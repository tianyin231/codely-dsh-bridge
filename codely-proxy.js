#!/usr/bin/env node
/**
 * codely-dsh-bridge — 本地代理
 *
 * 作用：把 dsh 的 OpenAI 格式请求转发到 Codely LiteLLM 网关，
 *      注入网关强制要求的客户端身份头（User-Agent / X-Stainless-*）
 *      与会话标识（litellm_session_id / x-litellm-session-id），
 *      并在 sk- 密钥失效时用本地 Codely 登录凭据自动换取新密钥。
 *
 * 协议细节见 docs/PROTOCOL.md
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./codely-auth');
const quota = require('./codely-quota');

/* ─── 命令行参数 ─── */
function argValue(name, env, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) return process.argv[i + 1];
  return process.env[env] || def;
}
function argFlag(name) { return process.argv.includes(name); }
if (argFlag('--help') || argFlag('-h')) {
  console.log(`codely-dsh-bridge proxy

用法: node codely-proxy.js [--port 8790] [--bind 127.0.0.1]

  --port N   监听端口        （默认 8790，或环境变量 CODELY_PROXY_PORT）
  --bind H   监听地址        （默认 127.0.0.1，仅本机）
  --help     显示本帮助

端点:
  /healthz   健康检查
  /quota     积分余额快照（每日赠送/充值余额/套餐窗口/月度统计，15s 缓存；?force=1 强制刷新）`);
  process.exit(0);
}

const PORT = parseInt(argValue('--port', 'CODELY_PROXY_PORT', '8790'), 10);
const BIND = argValue('--bind', 'CODELY_PROXY_BIND', '127.0.0.1');
const UPSTREAM_HOST = 'codely-litellm.tuanjie.cn';
const HERE = __dirname;
const KEY_CACHE = path.join(HERE, 'key.cache');
const SESSION_CACHE = path.join(HERE, 'session.cache');

/* 网关校验的是官方 CLI 的身份特征，缺失会被 400 拒绝（见 PROTOCOL.md） */
const CLIENT_HEADERS = {
  'User-Agent': 'codely-cli/1.0.0-release.41 (win32; x64)',
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': '5.11.0',
  'X-Stainless-OS': 'Windows',
  'X-Stainless-Arch': 'x64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
};

/* ─── 密钥管理 ─── */
function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }

function loadCachedKey() {
  try { return fs.readFileSync(KEY_CACHE, 'utf8').trim() || null; } catch { return null; }
}

/** 用登录凭据（codely-creds.json 或 ~/.codely-cli）换取新的 sk- 密钥（幂等，同一账号返回同一密钥） */
async function refreshKey() {
  const key = await auth.fetchApiKey();
  fs.writeFileSync(KEY_CACHE, key);
  log('key', `已刷新 API 密钥 (${key.slice(0, 6)}...)`);
  return key;
}

async function getKey() { return loadCachedKey() || refreshKey(); }

/* ─── 会话管理 ───
 * 网关要求请求带 litellm_session_id，缺失报「非法session」。
 * 用稳定 UUID 即可通过校验；每个代理实例持久化一个。 */
function getSessionId() {
  try {
    const s = fs.readFileSync(SESSION_CACHE, 'utf8').trim();
    if (s) return s;
  } catch { /* 首次运行 */ }
  const s = crypto.randomUUID();
  try { fs.writeFileSync(SESSION_CACHE, s); } catch { /* 只读目录时退化为内存态 */ }
  return s;
}

/* ─── 请求体改写：注入会话标识 ─── */
function transformBody(urlPath, body) {
  if (!body?.length || !urlPath.includes('/chat/completions')) return { payload: body, model: null };
  try {
    const j = JSON.parse(body.toString('utf8'));
    if (!j.litellm_session_id) j.litellm_session_id = getSessionId();
    if (!j.metadata) j.metadata = {};
    if (!j.metadata.session_id) j.metadata.session_id = j.litellm_session_id;
    return { payload: Buffer.from(JSON.stringify(j), 'utf8'), model: j.model || null };
  } catch {
    return { payload: body, model: null }; // 非 JSON 原样透传
  }
}

/* ─── 转发（单次尝试）：拿到上游状态码后再决定回写或重试，保证流式可透传 ─── */
function attemptForward(req, apiKey, body) {
  return new Promise((resolve, reject) => {
    const { payload, model } = transformBody(req.url, body);
    const up = https.request({
      hostname: UPSTREAM_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${apiKey}`,
        'x-litellm-session-id': getSessionId(),
        'Content-Type': req.headers['content-type'] || 'application/json',
        Accept: req.headers.accept || 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (ur) => {
      if (ur.statusCode === 401 || ur.statusCode === 403) {
        // 先读完响应体：区分「密钥失效」与「模型被团队权限拒绝」两类 401/403
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const errBody = Buffer.concat(chunks);
          const text = errBody.toString('utf8');
          const denied = /team_model_access_denied|not allowed to access model|model_access_denied/i.test(text);
          if (denied) {
            // 换 key 无济于事（换 key 幂等、且问题在模型权限）：把上游错误原样透传给客户端
            log('key', `上游 401: 模型 ${model || '(未知)'} 被团队权限拒绝（透传错误，不刷新密钥）`);
            return resolve({ retry: false, model, passthrough: { status: ur.statusCode, headers: ur.headers, body: errBody } });
          }
          log('key', `上游返回 ${ur.statusCode}，刷新密钥后重试`);
          resolve({ retry: true, status: ur.statusCode, errBody });
        });
        return;
      }
      resolve({ retry: false, ur, model });
    });
    up.on('error', reject);
    up.write(payload);
    up.end();
  });
}

async function handle(req, res, body) {
  const started = Date.now();
  const isProbe = req.headers['x-codely-probe'] === '1'; // 内部探测请求，不刷 [proxy] 日志
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let apiKey;
    try { apiKey = await getKey(); }
    catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `codely-dsh-bridge: ${e.message}` } }));
    }
    try {
      const r = await attemptForward(req, apiKey, body);
      if (r.retry) {
        log('key', `上游返回 ${r.status}，刷新密钥后重试`);
        lastErr = r.errBody ? { status: r.status, body: r.errBody } : r.status;
        try { await refreshKey(); } catch (e) { log('key', `刷新失败: ${e.message}`); }
        continue;
      }
      if (r.passthrough) {
        // 模型被团队权限拒绝：原样透传上游错误，让 dsh 显示真实原因
        if (!isProbe) log('proxy', `${req.method} ${req.url} -> ${r.passthrough.status} (${Date.now() - started}ms, 模型被拒透传${r.model ? `, model=${r.model}` : ''})`);
        const h = { ...r.passthrough.headers };
        delete h['content-length'];
        res.writeHead(r.passthrough.status, h);
        res.end(r.passthrough.body);
        return;
      }
      if (!isProbe) log('proxy', `${req.method} ${req.url} -> ${r.ur.statusCode} (${Date.now() - started}ms${r.model ? `, model=${r.model}` : ''})`);
      const h = { ...r.ur.headers };
      delete h['content-length']; // 会话注入可能改写请求体，上游长度对本端无意义
      res.writeHead(r.ur.statusCode, h);
      r.ur.pipe(res);
      return;
    } catch (e) {
      lastErr = e;
      log('proxy', `上游连接错误: ${e.message}`);
      break;
    }
  }
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    const reason = typeof lastErr === 'object' && lastErr?.body
      ? `${lastErr.status}: ${lastErr.body.toString('utf8').slice(0, 300)}`
      : String(lastErr);
    res.end(JSON.stringify({ error: { message: `codely-dsh-bridge: 上游请求失败 (${reason})` } }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_HOST, keyCached: !!loadCachedKey() }));
  }
  // 积分余额快照（供 dsh-codely-quota 插件 / 人工 curl 查询）
  // 仅允许 loopback Host 访问（127.0.0.1/localhost 端口），防 DNS rebinding 被网页读取
  if (req.url === '/quota' || req.url.startsWith('/quota?')) {
    const host = String(req.headers.host || '');
    const okHost = /^(127\.0\.0\.1|localhost|::1)(:\d+)?$/i.test(host);
    if (!okHost) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'forbidden host' }));
    }
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
    const started = Date.now();
    quota.fetchQuotaSnapshot({ force })
      .then((data) => {
        log('quota', `积分额度快照 -> 200 (${Date.now() - started}ms, ${force ? '强制' : '缓存'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fetchedAt: data.fetchedAt, data }));
      })
      .catch((e) => {
        log('quota', `积分额度快照失败: ${e.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => handle(req, res, Buffer.concat(chunks)));
  req.on('error', () => res.destroy());
});

server.listen(PORT, BIND, () => {
  log('proxy', `监听 http://${BIND}:${PORT}/v1  (健康检查: /healthz, 积分额度: /quota)`);
  log('proxy', `上游   https://${UPSTREAM_HOST}/v1`);
  const creds = auth.loadCreds();
  log('proxy', `凭据: ${creds ? creds.source : '未找到（npm run login 或用官方 CLI 登录）'}`);
  const k = loadCachedKey();
  log('proxy', `密钥缓存: ${k ? k.slice(0, 6) + '...' : '无（首个请求时自动获取）'}`);
  reportBackends();
});

/* ─── 启动时探测真实后端并同步到 dsh 模型选择界面 ───
 * 流程：GET /v1/models → 探测各 alias 真实后端 → buildModels → 写回 ~/.dsh/settings.yaml。
 * dsh 监听 settings/document-updated 会自动刷新模型选择页，实现"启动即实时映射"。
 * 若无法写 dsh 配置（如只读），退化为仅打印参考；失败不阻塞代理启动。 */
const KNOWN_ALIASES = ['codely-core', 'codely-flash', 'codely-air', 'codely-basic', 'codely-vl'];
const coconfig = require('./codely-config');

async function reportBackends() {
  setTimeout(async () => {
    try {
      log('probe', `探测真实后端（经本代理，共 ${KNOWN_ALIASES.length} 个 alias）...`);
      // 1) GET /v1/models（经本代理，得到当前可用 alias 快照——含官方新放行的模型）
      let liveData = [];
      try {
        const key = await getKey();
        liveData = await auth.fetchAvailableModels(key, { proxyBaseURL: `http://127.0.0.1:${PORT}/v1` });
      } catch (e) {
        log('probe', `模型列表获取失败（${e.message}），使用默认 alias 列表`);
        liveData = KNOWN_ALIASES.map((id) => ({ id }));
      }
      const probeTargets = liveData.map((m) => m.id);
      // 2) 探测各 alias 真实后端（探测实时列表，新放行的 alias 会自动纳入映射）
      const rows = await auth.probeBackends(probeTargets, { base: `http://127.0.0.1:${PORT}/v1`, samples: 2, concurrency: 3 });
      for (const r of rows) {
        if (r.error) { log('probe', `  ${r.alias.padEnd(15)} -> 探测失败 (${r.error})`); continue; }
        const w = r.contextWindow ? `${Math.round(r.contextWindow / 1024)}K` : '?';
        const modal = r.input?.includes('image') ? ', 支持图片' : '';
        log('probe', `  ${r.alias.padEnd(15)} -> ${r.backend}  (上下文 ${w}${modal})`);
      }
      // 3) 合并并写回 dsh 配置
      const models = coconfig.buildModels(liveData, rows);
      try {
        coconfig.writeCodelyProvider({ port: PORT, models });
        log('probe', `已同步 ${models.length} 个模型到 ~/.dsh/settings.yaml，dsh 模型选择界面将自动刷新`);
      } catch (e) {
        log('probe', `写入 dsh 配置失败（${e.message}），不影响代理运行；可手动 npm run setup`);
      }
    } catch (e) {
      log('probe', `探测真实后端失败: ${e.message}`);
    }
  }, 300);
}

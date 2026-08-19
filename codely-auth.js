/**
 * codely-dsh-bridge — 凭据与密钥获取（共享模块）
 *
 * 登录凭据来源优先级：
 *   1. 本项目 codely-creds.json   （npm run login 产生，无需安装 codely CLI）
 *   2. ~/.codely-cli/oauth_creds.json + org.json（官方 CLI 登录态）
 *
 * 支持用 refresh_token 自动续期（端点与官方 CLI 相同）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const BASE = 'https://codely.tuanjie.cn';
const LOCAL_CREDS = path.join(HERE, 'codely-creds.json');
const CODELY_HOME = path.join(os.homedir(), '.codely-cli');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 返回 {access_token, refresh_token, user_id, team_id, source} 或 null */
function loadCreds() {
  const local = readJson(LOCAL_CREDS);
  if (local?.access_token) {
    return {
      access_token: local.access_token,
      refresh_token: local.refresh_token || null,
      user_id: local.user_id != null ? String(local.user_id) : null,
      team_id: local.team_id || null,
      expiry_date: local.expiry_date || null,
      file: LOCAL_CREDS,
      source: '本项目 codely-creds.json',
    };
  }
  const oauth = readJson(path.join(CODELY_HOME, 'oauth_creds.json'));
  if (oauth?.access_token) {
    let teamId = null;
    const org = readJson(path.join(CODELY_HOME, 'org.json'));
    if (org?.accounts && oauth.user_id != null) {
      teamId = org.accounts[String(oauth.user_id)]?.currentOrgId || null;
    }
    return {
      access_token: oauth.access_token,
      refresh_token: oauth.refresh_token || null,
      user_id: oauth.user_id != null ? String(oauth.user_id) : null,
      team_id: teamId,
      expiry_date: oauth.expiry_date || null,
      file: path.join(CODELY_HOME, 'oauth_creds.json'),
      source: '~/.codely-cli（官方 CLI 登录态）',
    };
  }
  return null;
}

/** access_token 过期前 60s 视为需要刷新 */
function isExpiring(creds) {
  return !!creds?.expiry_date && Date.now() >= creds.expiry_date - 60000;
}

/** 用 refresh_token 换新 access_token；仅本地 creds.json 会被写回（不动官方 CLI 的文件） */
async function refreshAccessToken() {
  const c = loadCreds();
  if (!c?.refresh_token) throw new Error('没有 refresh_token，请重新登录: npm run login');
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: c.refresh_token }),
  });
  if (!res.ok) throw new Error(`刷新 token 失败: HTTP ${res.status}（请重新登录: npm run login）`);
  const r = await res.json();
  if (!r.access_token) throw new Error('刷新响应中没有 access_token');

  if (c.file === LOCAL_CREDS) {
    const local = readJson(LOCAL_CREDS) || {};
    local.access_token = r.access_token;
    if (r.refresh_token) local.refresh_token = r.refresh_token;
    local.expiry_date = Date.now() + (r.expires_in || 315360000) * 1000;
    fs.writeFileSync(LOCAL_CREDS, JSON.stringify(local, null, 2), 'utf8');
  }
  return r.access_token;
}

/** 拿一个可用的 access_token（必要时自动刷新） */
async function getAccessToken() {
  let c = loadCreds();
  if (!c) throw new Error('未找到登录凭据。请先运行: npm run login（或在官方 codely CLI 登录）');
  if (isExpiring(c)) {
    const t = await refreshAccessToken();
    c = { ...c, access_token: t };
  }
  return c;
}

/** 用 access_token 换 LiteLLM sk- 密钥（幂等：同一账号返回同一密钥） */
async function fetchApiKey(creds) {
  const c = creds || (await getAccessToken());
  const url = new URL(`${BASE}/api/api-token/cli-api-key`);
  if (c.team_id) url.searchParams.set('teamId', c.team_id);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${c.access_token}`, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    // access_token 过期：刷新后重试一次
    const token = await refreshAccessToken();
    const res2 = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res2.ok) throw new Error(`换取密钥失败: HTTP ${res2.status}（请重新登录: npm run login）`);
    const j2 = await res2.json();
    if (!j2.cli_api_key?.startsWith('sk-')) throw new Error(`密钥格式异常: ${String(j2.cli_api_key).slice(0, 8)}`);
    return j2.cli_api_key;
  }
  if (!res.ok) throw new Error(`换取密钥失败: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.cli_api_key?.startsWith('sk-')) throw new Error(`密钥格式异常: ${String(j.cli_api_key).slice(0, 8)}`);
  return j.cli_api_key;
}

const LITELLM_HOST = 'codely-litellm.tuanjie.cn';

/* 网关校验的是官方 CLI 的身份特征，缺失会被 400 拒绝（见 PROTOCOL.md §2.2）
 * 与 codely-proxy.js 的 CLIENT_HEADERS 保持一致（proxy 不可被 require，故各自维护） */
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

/** 用 sk- 密钥查询当前账号实际可用的模型列表（GET /v1/models）
 *  返回 upstream 原始 data 数组：[{id, object, created, owned_by, is_alias, max_model_len?}, ...]
 *  不同账号/会员档位返回的列表不同（如 GLM 系列仅会员可用）。
 *
 *  默认直连网关；传入 { proxyBaseURL: 'http://127.0.0.1:PORT/v1' } 时**优先走本地代理**——
 *  让写进 dsh 的列表与代理实际能服务的路径保持同源（GET 暂不强制会话，但若网关日后对 GET
 *  也校验会话，走代理可免疫），代理未启动/异常时回退直连，保证 setup 在代理未运行时同样可用。 */
async function fetchAvailableModels(apiKey, { proxyBaseURL } = {}) {
  if (proxyBaseURL) {
    try {
      const p = `${proxyBaseURL.replace(/\/+$/, '')}/models`;
      const r = await fetch(p, {
        headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j?.data)) return j.data;
    } catch { /* 代理不可用/异常：回退直连 */ }
  }
  const res = await fetch(`https://${LITELLM_HOST}/v1/models`, {
    headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`查询可用模型失败: HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j?.data)) throw new Error('可用模型响应格式异常（缺少 data 数组）');
  return j.data;
}

/**
 * 已知真实后端 → 上下文窗口（静态知识，随网关调整变化，用 backend-probe 复核）
 * 窗口以真实后端为准（LiteLLM 会把后端名透传到 resp.model，见下方 probeBackends）。
 */
const BACKEND_META = {
  'deepseek-v4-flash-0731': { contextWindow: 1048576 },
  'glm-5-fp8-128k': { contextWindow: 131072 },
  'glm-5-2-260617': { contextWindow: 131072 },
  'qwen3.5-397b-a17b': { contextWindow: 131072, input: ['text', 'image'] },
};

/**
 * 解析真实后端名对应的窗口/模态。
 * ① 精确匹配 BACKEND_META；② 按前缀规则兜底（gateway 会轮换同一型号的不同后端名，
 * 如核心 GLM-5 有 fp8-128k / 5-2-xxxxxxxx 等多个部署）；③ 未知返回 {}。
 */
function resolveBackendMeta(backend) {
  if (!backend) return {};
  const exact = BACKEND_META[backend];
  if (exact) return exact;
  if (backend.startsWith('deepseek-v4-flash')) return { contextWindow: 1048576 };
  if (backend.startsWith('glm-5')) return { contextWindow: 131072 }; // GLM-5 系（FP8/日期版）都是 128K
  if (backend.startsWith('qwen3')) return { contextWindow: 131072, input: ['text', 'image'] };
  return {};
}

/**
 * 探测每个 alias 背后的真实后端（LiteLLM 网关把真实后端模型名透传到 chat.completions 响应的
 * `model` 字段，由路由层填充、非模型自报、无法伪造）。
 *
 * 对每个 alias 发极小请求（max_completion_tokens: 4），并发受 `concurrency` 限制并带尾部
 * 微延迟防 429。每个 alias 探测 `samples` 次（默认 3，gateway 可能轮换同型号不同后端名），
 * 取出现次数最多且能解析到窗口的后端为准，返回其 { alias, backend, contextWindow, input }。
 * 单次/单 alias 失败跳过（不抛错），整体网络失败才抛错。
 *
 * @param opts.base 代理或直连 base（如 http://127.0.0.1:8790/v1），默认 LITELLM_HOST 直连
 * @param opts.apiKey sk- 密钥（直连时需要；走代理可省，代理自己会取 key）
 * @param opts.samples 每 alias 采样次数（默认 3）
 */
async function probeBackends(aliases, { base, apiKey, concurrency = 4, samples = 3 } = {}) {
  if (!Array.isArray(aliases) || aliases.length === 0) return [];
  const b = (base || `https://${LITELLM_HOST}/v1`).replace(/\/+$/, '');
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < aliases.length) {
      const alias = aliases[idx++];
      const seen = new Map(); // backend -> {count, meta}
      let lastErr = null;
      for (let s = 0; s < samples; s++) {
        try {
          const headers = { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' };
          if (!apiKey) delete headers.Authorization; // 走代理：由代理注入密钥与身份头
          // x-codely-probe 标记：让代理识别内部探测请求，不刷入 [proxy] 请求日志
          headers['x-codely-probe'] = '1';
          const r = await fetch(`${b}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: '验证' }], max_completion_tokens: 4, stream: false }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { lastErr = `${r.status} ${(j.error?.message || '').slice(0, 60)}`; continue; }
          const bk = j.model;
          if (bk) {
            const cur = seen.get(bk) || { count: 0, meta: resolveBackendMeta(bk) };
            cur.count++;
            seen.set(bk, cur);
          }
        } catch (e) { lastErr = e.message; }
        await new Promise((res) => setTimeout(res, 120)); // 微延迟，防 429
      }
      // 取出现次数最多的后端（gateway 同型号可能轮换多个后端名，取主样本）
      let best = null, bestCount = 0;
      for (const [bk, cur] of seen) {
        if (best === null || cur.count > bestCount) { best = { backend: bk, meta: cur.meta }; bestCount = cur.count; }
      }
      if (best) results.push({ alias, backend: best.backend, contextWindow: best.meta.contextWindow, input: best.meta.input });
      else results.push({ alias, error: lastErr || '无法确定真实后端' });
    }
  }
  await Promise.all([...Array(concurrency)].map(() => worker()));
  return results;
}

module.exports = { loadCreds, getAccessToken, refreshAccessToken, fetchApiKey, fetchAvailableModels, probeBackends, BACKEND_META, LOCAL_CREDS, BASE, LITELLM_HOST, CLIENT_HEADERS };

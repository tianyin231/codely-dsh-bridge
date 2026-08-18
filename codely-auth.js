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
 *  不同账号/会员档位返回的列表不同（如 GLM 系列仅会员可用）。 */
async function fetchAvailableModels(apiKey) {
  const res = await fetch(`https://${LITELLM_HOST}/v1/models`, {
    headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`查询可用模型失败: HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j?.data)) throw new Error('可用模型响应格式异常（缺少 data 数组）');
  return j.data;
}

module.exports = { loadCreds, getAccessToken, refreshAccessToken, fetchApiKey, fetchAvailableModels, LOCAL_CREDS, BASE, LITELLM_HOST, CLIENT_HEADERS };

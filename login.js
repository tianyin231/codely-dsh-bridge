#!/usr/bin/env node
/**
 * codely-dsh-bridge — 独立登录（无需安装 codely CLI）
 *
 * 走 Codely 官方的设备码授权流程（与 codely CLI /auth 完全相同的端点）：
 *
 *   1. POST /auth/device/initiate          → 拿到 verification_uri_complete + user_code
 *   2. 用户在浏览器打开并登录（Unity 账号）
 *   3. GET  /auth/device/poll              → 轮询直到 authorized，拿 authorization_code
 *   4. POST /auth/device/exchange          → 换 access_token / refresh_token
 *   5. GET  /api/api-token/cli-api-key     → 换 LiteLLM sk- 密钥
 *
 * 凭据保存在本项目 codely-creds.json（含 gitignore），与 ~/.codely-cli 互不影响。
 *
 * 用法:  node login.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const HERE = __dirname;
const CREDS_FILE = path.join(HERE, 'codely-creds.json');

const BASE = 'https://codely.tuanjie.cn';

function ok(msg) { console.log(`[✓] ${msg}`); }
function die(msg) { console.error(`\n[x] ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打不开就手动点 */ });
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
  try { return JSON.parse(text); } catch { throw new Error(`响应不是 JSON: ${text.slice(0, 200)}`); }
}

async function main() {
  console.log('Codely 独立登录（设备码流程）');
  console.log('============================\n');

  /* 1. 发起设备授权 */
  process.stdout.write('[1/5] 请求设备码 ... ');
  const dev = await jsonFetch(`${BASE}/auth/device/initiate`, {
    method: 'POST',
    body: JSON.stringify({ provider: 'unity', client_name: 'codely-cli' }),
  }).catch((e) => die(e.message));
  if (!dev.verification_uri_complete || !dev.auth_request_token) die('initiate 返回缺少字段');
  console.log('完成\n');

  /* 2. 引导用户授权 */
  console.log('──────────────────────────────────────────────────');
  console.log('  请在浏览器中打开下面链接并登录授权：');
  console.log('');
  console.log(`  ${dev.verification_uri_complete}`);
  console.log('');
  console.log(`  用户码: ${dev.user_code}`);
  console.log('──────────────────────────────────────────────────\n');
  openBrowser(dev.verification_uri_complete);

  /* 3. 轮询授权结果 */
  process.stdout.write('[2/5] 等待浏览器授权');
  const interval = Math.max(dev.interval || 2, 1);
  const deadline = Date.now() + Math.max(dev.expires_in || 600, 60) * 1000;
  let code = null;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const st = await jsonFetch(`${BASE}/auth/device/poll?auth_request_token=${encodeURIComponent(dev.auth_request_token)}`);
    if (st.status === 'pending') { process.stdout.write('.'); continue; }
    if (st.status === 'slow_down') { await sleep(interval * 1000); continue; }
    if (st.status === 'authorized') { code = st.authorization_code; break; }
    if (st.status === 'denied') die('你拒绝了授权，请重试');
    if (st.status === 'expired') die('授权码已过期，请重试');
    if (st.status === 'completed') die('该授权码已被使用过（可能已有其他进程完成登录），请重试');
    die(`未知状态: ${st.status}`);
  }
  if (!code) die('等待授权超时');
  console.log(' 完成\n');

  /* 4. 换取 token */
  process.stdout.write('[3/5] 换取 access_token ... ');
  const tok = await jsonFetch(`${BASE}/auth/device/exchange`, {
    method: 'POST',
    body: JSON.stringify({ authorization_code: code }),
  }).catch((e) => die(e.message));
  if (!tok.access_token) die('exchange 响应中没有 access_token');
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  console.log(`完成 (${tok.access_token.slice(0, 16)}...)`);

  /* 5. 用户与组织信息 */
  process.stdout.write('[4/5] 获取用户/组织信息 ... ');
  const me = await jsonFetch(`${BASE}/auth/external/me`, { headers: auth }).catch((e) => die(e.message));
  const userId = me.id != null ? String(me.id) : null;

  let teamId = null, teamName = null;
  try {
    const teams = await jsonFetch(`${BASE}/api/teams`, { headers: auth });
    teamId = teams.current_team_id || teams.teams?.find((t) => t.is_current)?.team_id || teams.teams?.[0]?.team_id || null;
    teamName = teams.teams?.find((t) => t.team_id === teamId)?.team_name || null;
  } catch { /* 单组织账号可能没有 teams 接口，cli-api-key 不带 teamId 也能发 */ }
  console.log(`完成 (user=${userId || '?'}, org=${teamName || teamId || '默认'})`);

  /* 6. 保存凭据 */
  const creds = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    token_type: tok.token_type || 'Bearer',
    expires_in: tok.expires_in,
    expiry_date: Date.now() + (tok.expires_in || 315360000) * 1000,
    user_id: userId,
    team_id: teamId,
    team_name: teamName,
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), 'utf8');

  /* 7. 预取 sk- 密钥 */
  process.stdout.write('[5/5] 预取 LiteLLM API 密钥 ... ');
  const keyUrl = new URL(`${BASE}/api/api-token/cli-api-key`);
  if (teamId) keyUrl.searchParams.set('teamId', teamId);
  const kj = await jsonFetch(keyUrl, { headers: auth }).catch((e) => {
    console.log(`跳过（${e.message}，代理启动后会自动重试）`);
    return null;
  });
  if (kj?.cli_api_key) {
    fs.writeFileSync(path.join(HERE, 'key.cache'), kj.cli_api_key, 'utf8');
    console.log(`完成 (${kj.cli_api_key.slice(0, 6)}...)`);
  }

  ok(`登录成功，凭据已保存到 ${path.basename(CREDS_FILE)}\n`);
  console.log('下一步:  npm run setup   注册 dsh provider，然后 npm start 启动代理');
}

main().catch((e) => die(e.message));

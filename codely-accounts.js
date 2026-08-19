/**
 * codely-dsh-bridge — 多账号注册表（共享模块）
 *
 * 结构（全部 gitignored）：
 *   accounts/index.json     注册表：{ current, accounts: { <slug>: { savedAt, userId, teamId, teamName } } }
 *   accounts/<slug>.json    该账号的完整登录凭据（与 codely-creds.json 同构）
 *   codely-creds.json       始终等于「当前激活账号」的凭据（老链路 auth/proxy/quota/setup 零改动）
 *   key.cache / session.cache  当前激活账号的 sk- 密钥与会话（切换时一并更换）
 *
 * 约定：
 *   · 账号名（slug）由用户指定或自动生成，只允许 [A-Za-z0-9._-]（防路径穿越）。
 *   · 激活 = 把 accounts/<slug>.json 复制到 codely-creds.json，并清掉 key.cache / session.cache ——
 *     代理下一次请求会自动用新凭据换取密钥、重新生成会话，实现「无重启丝滑切换」。
 *   · 首次使用时若注册表为空但存在 codely-creds.json（老版本单账号升级），自动导入为当前账号。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./codely-auth');

const HERE = __dirname;
const ACCOUNTS_DIR = path.join(HERE, 'accounts');
const INDEX_FILE = path.join(ACCOUNTS_DIR, 'index.json');
/** 当前激活账号凭据文件（与 auth.LOCAL_CREDS 同一文件） */
const CREDS_FILE = auth.LOCAL_CREDS;
const KEY_CACHE = path.join(HERE, 'key.cache');
const SESSION_CACHE = path.join(HERE, 'session.cache');

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadIndex() {
  const idx = readJson(INDEX_FILE);
  return { current: idx?.current || null, accounts: idx?.accounts && typeof idx.accounts === 'object' ? idx.accounts : {} };
}

function saveIndex(idx) {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

/** 规范化账号名（slug）。非法字符替换为 '-'；空则返回 null */
function slugify(name) {
  if (!name) return null;
  let s = String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || !SLUG_RE.test(s)) return null;
  return s;
}

/** 从凭据自动生成账号名（teamName → user_id → 随机） */
function autoName(creds) {
  if (creds?.team_name) {
    const s = slugify(creds.team_name);
    if (s) return s;
  }
  if (creds?.user_id != null) return 'user-' + String(creds.user_id);
  return 'account-' + crypto.randomBytes(2).toString('hex');
}

function accountFilePath(name) {
  return path.join(ACCOUNTS_DIR, slugify(name) + '.json');
}

/** 账号目录里实际存在的账号名列表（以文件为准，防 index 与文件不一致） */
function listSlugs() {
  try {
    return fs.readdirSync(ACCOUNTS_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json' && SLUG_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch { return []; }
}

/**
 * 首用自愈：注册表为空但存在 codely-creds.json（老版本单账号升级路径）时，
 * 自动把激活账号导入注册表并设为当前账号。返回是否发生了导入。
 */
function ensureRegistry() {
  const idx = loadIndex();
  if (Object.keys(idx.accounts).length) return false;
  const creds = auth.loadCreds();
  if (!creds) return false;
  // 用原始文件（含 team_name 等字段）做命名/登记，loadCreds() 的归一化对象不含 team_name
  const raw = readJson(CREDS_FILE) || creds;
  const name = autoName(raw);
  idx.accounts[name] = metaFromCreds(name, raw, raw.saved_at ? new Date(raw.saved_at).getTime() : Date.now());
  idx.current = name;
  saveIndex(idx);
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(accountFilePath(name), JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return true;
}

function metaFromCreds(name, creds, savedAt) {
  return {
    savedAt: savedAt ? new Date(savedAt).toISOString() : (creds.saved_at || new Date().toISOString()),
    userId: creds.user_id != null ? String(creds.user_id) : null,
    teamId: creds.team_id || null,
    teamName: creds.team_name || null,
    source: creds.source || null,
  };
}

/** 列出全部账号（含当前标记），按名称排序 */
function listAccounts() {
  ensureRegistry();
  const idx = loadIndex();
  return listSlugs().map((name) => {
    const meta = idx.accounts[name] || {};
    return {
      name,
      savedAt: meta.savedAt || null,
      userId: meta.userId ?? null,
      teamId: meta.teamId ?? null,
      teamName: meta.teamName ?? null,
      isCurrent: name === idx.current,
    };
  });
}

/** 当前账号名（null 表示没有注册账号） */
function getCurrentName() {
  ensureRegistry();
  return loadIndex().current;
}

/**
 * 当前激活账号摘要（供 /healthz、/quota 展示，只读不写文件）。
 * 注册表存在时用注册表信息；否则（老版本未导入）从激活凭据现算。
 */
function getCurrentMeta() {
  const idx = loadIndex();
  const name = idx.current;
  const account = idx.accounts[name];
  if (account) {
    return { name, userId: account.userId, teamId: account.teamId, teamName: account.teamName };
  }
  const creds = auth.loadCreds();
  if (creds) {
    const raw = readJson(CREDS_FILE) || creds; // 原始文件带 team_name
    return { name: autoName(raw), userId: raw.user_id != null ? String(raw.user_id) : null, teamId: raw.team_id || null, teamName: raw.team_name || null, legacy: true };
  }
  return null;
}

/** 激活凭据指纹：账号身份变化（换账号）时指纹变化，用于配额/模型缓存失效判断 */
function credFingerprint(creds) {
  const c = creds || auth.loadCreds() || {};
  const s = [c.user_id ?? '', c.team_id ?? '', c.team_name ?? ''].join('|');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * 保存（或覆盖）一个账号：把凭据写入 accounts/<slug>.json 并登记注册表。
 * @param {string} name 账号名（自动 slug 化；空则 autoName）
 * @param {object} creds 完整凭据对象（与 codely-creds.json 同构）
 * @param {object} [o]
 * @param {boolean} [o.activate] 同时设为当前激活账号
 * @returns {{name: string, savedAt: string, meta: object}}
 */
function saveAccount(name, creds, { activate = false } = {}) {
  const slug = slugify(name) || autoName(creds);
  ensureRegistry();
  const idx = loadIndex();
  const savedAt = Date.now();
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const full = { ...creds, saved_at: new Date(savedAt).toISOString() };
  fs.writeFileSync(accountFilePath(slug), JSON.stringify(full, null, 2) + '\n', 'utf8');
  idx.accounts[slug] = metaFromCreds(slug, creds, savedAt);
  if (activate) idx.current = slug;
  saveIndex(idx);
  return { name: slug, savedAt: new Date(savedAt).toISOString(), meta: idx.accounts[slug] };
}

/**
 * 读取某账号的完整凭据。
 * @returns {object|null} 凭据对象（含 user_id/team_id/team_name/...），不存在返回 null
 */
function loadAccountCreds(name) {
  const slug = slugify(name);
  if (!slug) return null;
  return readJson(accountFilePath(slug));
}

/**
 * 激活某账号（核心切换逻辑，CLI 与代理共用）：
 *   1. 校验账号存在；
 *   2. 把 accounts/<slug>.json 复制为 codely-creds.json（= 当前激活账号）；
 *   3. 删除 key.cache 与 session.cache —— 代理下次请求自动用新凭据取新密钥、重开会话；
 *   4. 更新注册表 current；
 *   5. 尝试预取新账号的 sk- 密钥（失败不阻塞——代理会在下一请求时自动重试）。
 * @returns {Promise<{name, teamName, userId, key}>} key 为预取密钥或 null
 */
async function activateAccount(name) {
  ensureRegistry();
  const slug = slugify(name);
  const creds = loadAccountCreds(slug);
  if (!creds || !creds.access_token) {
    throw new Error(`账号不存在或凭据无效: ${name || slug || '(空)'}（先 npm run account -- login <name> 登录该账号）`);
  }
  const idx = loadIndex();
  if (!idx.accounts[slug]) {
    idx.accounts[slug] = metaFromCreds(slug, creds, Date.now());
  }
  // 删除敏感缓存：让代理/CLI 后续请求自然落到新账号
  try { fs.unlinkSync(KEY_CACHE); } catch { /* 没有也无妨 */ }
  try { fs.unlinkSync(SESSION_CACHE); } catch { /* 没有也无妨 */ }
  // 与登录保存一致地写 actived 凭据
  const savedAt = new Date().toISOString();
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ ...creds, saved_at: savedAt }, null, 2) + '\n', 'utf8');
  idx.accounts[slug] = metaFromCreds(slug, creds, Date.now());
  idx.current = slug;
  saveIndex(idx);

  let key = null;
  try { key = await auth.fetchApiKey(creds); } catch { /* 网络/续期失败：代理下次请求时自动重试 */ }
  return {
    name: slug,
    teamName: creds.team_name || null,
    userId: creds.user_id != null ? String(creds.user_id) : null,
    key,
  };
}

/**
 * 删除账号。删的是当前账号时自动激活剩余账号中的第一个；全部删光则清空激活凭据。
 * @returns {{removed: boolean, nextCurrent: string|null, error?: string}}
 */
async function removeAccount(name) {
  const slug = slugify(name);
  const idx = loadIndex();
  if (!idx.accounts[slug] && !fs.existsSync(accountFilePath(slug))) return { removed: false, error: `账号不存在: ${slug}` };
  const wasCurrent = idx.current === slug;
  try { fs.unlinkSync(accountFilePath(slug)); } catch { /* 忽略 */ }
  delete idx.accounts[slug];
  const rest = Object.keys(idx.accounts).sort();
  idx.current = wasCurrent ? (rest.length ? rest[0] : null) : idx.current;
  saveIndex(idx);

  if (wasCurrent) {
    if (rest.length) {
      await activateAccount(rest[0]); // sync 激活（内部会更新 index.current 为剩余第一个）
    } else {
      // 全部删光：清空激活凭据与密钥缓存，回到未登录状态
      try { fs.unlinkSync(CREDS_FILE); } catch { /* 忽略 */ }
      try { fs.unlinkSync(KEY_CACHE); } catch { /* 忽略 */ }
      try { fs.unlinkSync(SESSION_CACHE); } catch { /* 忽略 */ }
    }
  }
  return { removed: true, nextCurrent: loadIndex().current };
}

/* ═══ 小球内设备码登录（代理进程内存态；登录取自 Codely 官方 OAuth device flow） ═══
 * 链路：小球「＋」→ host → 代理 /account/login/start → OAuth initiate → 返回验证链接+用户码
 *      → 用户在浏览器授权 → 代理 /account/login/status 轮询 → authorized → 换取 token、
 *        登记账号并激活（自动切过去）——全程无需碰终端。
 * 注：登录态保存在代理进程内存，代理重启则本次登录作废（可重新发起）。
 */
let loginSlot = null; // { auth_request_token, name, startedAt, expiresAt, interval }

/** 发起设备码登录。返回给前端展示的信息（验证链接 + 用户码）。@param {string|null} name 建议账号名 */
async function startLogin({ name = null } = {}) {
  const res = await fetch(`${auth.BASE}/auth/device/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ provider: 'unity', client_name: 'codely-cli' }),
  });
  if (!res.ok) throw new Error(`发起设备码失败: HTTP ${res.status}`);
  const dev = await res.json().catch(() => null);
  if (!dev?.verification_uri_complete || !dev?.auth_request_token) throw new Error('initiate 返回缺少字段');
  const interval = Math.max(dev.interval || 2, 1);
  const expiresIn = dev.expires_in || 600;
  loginSlot = {
    auth_request_token: dev.auth_request_token,
    name: name ? slugify(name) : null,
    startedAt: Date.now(),
    expiresAt: Date.now() + expiresIn * 1000,
    interval,
  };
  return { name: loginSlot.name, verification_uri_complete: dev.verification_uri_complete, user_code: dev.user_code, expiresIn, interval };
}

/** 轮询一次设备码授权状态。@returns {{status, progress?, account?, error?, message?}} */
async function pollLogin() {
  if (!loginSlot) return { status: 'idle', progress: 0 };
  if (Date.now() > loginSlot.expiresAt) {
    cancelLogin();
    return { status: 'expired', progress: 0, message: '授权码已过期，请重试' };
  }
  let st;
  try {
    const r = await fetch(`${auth.BASE}/auth/device/poll?auth_request_token=${encodeURIComponent(loginSlot.auth_request_token)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st = await r.json();
  } catch (e) {
    return { status: 'pending', progress: 1, message: '轮询异常（将自动重试）：' + e.message };
  }
  if (st.status === 'pending') return { status: 'pending', progress: 1 };
  if (st.status === 'slow_down') return { status: 'pending', progress: 2 };
  if (st.status === 'denied') { cancelLogin(); return { status: 'denied', message: '你在浏览器里拒绝了授权' }; }
  if (st.status === 'expired') { cancelLogin(); return { status: 'expired', message: '授权码已过期，请重试' }; }
  if (st.status === 'completed') { cancelLogin(); return { status: 'expired', message: '授权码已被使用（可能他处已完成登录），请重试' }; }
  if (st.status === 'authorized') {
    const code = st.authorization_code;
    try {
      const account = await completeLogin(code);
      cancelLogin();
      return { status: 'authorized', account };
    } catch (e) {
      cancelLogin();
      return { status: 'error', error: e.message };
    }
  }
  cancelLogin();
  return { status: 'unknown', message: '未知状态：' + String(st.status) };
}

/** 授权成功后：换取 token → 用户/组织信息 → 登记账号并激活（自动切过去） */
async function completeLogin(authorization_code) {
  const res = await fetch(`${auth.BASE}/auth/device/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ authorization_code }),
  });
  if (!res.ok) throw new Error(`换取 token 失败: HTTP ${res.status}`);
  const tok = await res.json().catch(() => null);
  if (!tok?.access_token) throw new Error('exchange 响应中没有 access_token');
  const A = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' };

  let userId = null;
  try {
    const me = await (await fetch(`${auth.BASE}/auth/external/me`, { headers: A })).json();
    userId = me?.id != null ? String(me.id) : null;
  } catch { /* 非致命 */ }
  let teamId = null, teamName = null;
  try {
    const teams = await (await fetch(`${auth.BASE}/api/teams`, { headers: A })).json();
    teamId = teams?.current_team_id || teams?.teams?.find((t) => t.is_current)?.team_id || teams?.teams?.[0]?.team_id || null;
    teamName = teams?.teams?.find((t) => t.team_id === teamId)?.team_name || null;
  } catch { /* 单组织账号可能没有 teams 接口 */ }

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
  // 同账号检测：授权账号 == 当前激活账号 → 不重复添加，明确告知（浏览器会话没换账号）
  const currentMeta = getCurrentMeta();
  if (currentMeta && creds.user_id != null && String(currentMeta.userId) === String(creds.user_id)) {
    return { name: currentMeta.name, teamName: creds.team_name || null, userId: creds.user_id, same: true };
  }
  // 不同账号：自动名可能与其他账号撞名（不同组织同名）→ 加后缀避免覆盖
  let name = loginSlot?.name || autoName(creds);
  const idx = loadIndex();
  let n = 2;
  while (idx.accounts[name] && String(idx.accounts[name].userId) !== String(creds.user_id)) {
    name = (loginSlot?.name || autoName(creds)) + '-' + n++;
  }
  saveAccount(name, creds, { activate: true });
  await activateAccount(name).catch(() => { /* 密钥预取失败不阻塞：代理下次请求自动换取 */ });
  return { name, teamName, userId: creds.user_id, same: false };
}

/** 取消/清理进行中的设备码登录状态 */
function cancelLogin() { loginSlot = null; }

/** 当前登录流程状态（供前端初始化展示：是否有进行中的登录） */
function getLoginInfo() {
  if (!loginSlot) return null;
  return { name: loginSlot.name, startedAt: loginSlot.startedAt, expiresAt: loginSlot.expiresAt };
}

module.exports = {
  ACCOUNTS_DIR, INDEX_FILE, CREDS_FILE,
  slugify, autoName, readJson,
  ensureRegistry, listAccounts, listSlugs,
  getCurrentName, getCurrentMeta, credFingerprint,
  saveAccount, loadAccountCreds, activateAccount, removeAccount,
  startLogin, pollLogin, cancelLogin, getLoginInfo,
};
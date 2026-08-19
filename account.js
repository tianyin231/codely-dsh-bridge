#!/usr/bin/env node
/**
 * codely-dsh-bridge — 多账号管理 CLI
 *
 * 用法（注意 npm 需要 `--` 透传参数）：
 *   npm run account -- list                列出已登录账号（* 标记当前）
 *   npm run account -- switch <name>       切换当前账号（换凭据+密钥，无需重启代理）
 *   npm run account -- login [name]        设备码登录一个新账号（缺省名自动取 team_name/user_id）
 *   npm run account -- remove <name>       删除账号（删当前账号时自动切到剩下的第一个）
 *   npm run account -- show                显示当前账号详情
 *   npm run account -- help
 *
 * 也支持「小球」切换：dsh web 右下角额度圈 → 展开面板 → 顶部账号下拉一键切换
 * （其实同一套接口：CLI 代理到本地代理 :8790/account/switch，小球经插件 host 转发到同一端点）。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const accounts = require('./codely-accounts');
const auth = require('./codely-auth');

const HERE = __dirname;
const DEFAULT_PROXY_PORT = process.env.CODELY_PROXY_PORT || '8790';

function die(msg) { console.error(`\n[x] ${msg}`); process.exit(1); }
function ok(msg) { console.log(`[✓] ${msg}`); }

async function isProxyUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

/* ─── list ─── */
function cmdList() {
  const list = accounts.listAccounts();
  const currentName = accounts.getCurrentName();
  if (!list.length) {
    console.log('还没有已保存的账号。');
    if (auth.loadCreds()) {
      console.log('注：检测到 codely-creds.json（老版本单账号），首次 list 已自动导入注册表。');
    } else {
      console.log('请先登录:  npm run login   或   npm run account -- login [name]');
    }
    return;
  }
  console.log(`已登录账号 (${list.length}):`);
  for (const a of list) {
    const mark = a.isCurrent ? '*' : ' ';
    const t = a.teamName && a.teamName !== a.name ? `（${a.teamName}）` : '';
    console.log(`  ${mark} ${a.name}${t}${a.isCurrent ? '  ← 当前' : ''}`);
  }
}

/* ─── show ─── */
function cmdShow() {
  const meta = accounts.getCurrentMeta();
  if (!meta) die('当前没有激活账号。请先登录: npm run login');
  console.log(`当前账号: [${meta.name}]${meta.teamName && meta.teamName !== meta.name ? `（${meta.teamName}）` : ''}`);
  console.log(`  user_id: ${meta.userId || '-'}`);
  console.log(`  team_id: ${meta.teamId || '-'}`);
  console.log(`  team_name: ${meta.teamName || '-'}`);
  const list = accounts.listAccounts();
  if (list.length > 1) {
    console.log(`  全部账号: ${list.map((a) => (a.isCurrent ? '[' + a.name + ']' : a.name)).join(', ')}`);
  }
}

/* ─── switch：本地切换或代理委托 ─── */
async function cmdSwitch(name) {
  if (!name) die('用法: npm run account -- switch <name>');
  const list = accounts.listAccounts();
  if (!list.some((a) => a.name === accounts.slugify(name))) {
    die(`账号不存在: ${name}\n  已保存账号: ${list.map((a) => a.name).join(', ') || '（无）'}（先 npm run account -- login <name>）`);
  }
  const slug = accounts.slugify(name);
  const port = process.env.CODELY_PROXY_PORT || DEFAULT_PROXY_PORT;
  if (await isProxyUp(port)) {
    ok(`代理运行中 (:${port})，走代理切换（顺带重探模型映射）...`);
    const r = await fetch(`http://127.0.0.1:${port}/account/switch?name=${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slug }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) die(`切换失败: ${j.error || ('HTTP ' + r.status)}`);
    console.log(`已切换到 [${j.account?.name}]${j.account?.teamName ? `（${j.account.teamName}）` : ''}`);
    console.log('模型映射已自动重探并同步到 dsh（如窗口未刷新，稍等几秒或手动重探）。');
  } else {
    ok('代理未运行，本地切换（凭据+密钥缓存已更新）...');
    const acct = await accounts.activateAccount(slug).catch((e) => die(e.message));
    console.log(`已切换到 [${acct.name}]${acct.teamName ? `（${acct.teamName}）` : ''}`);
    console.log(`  密钥: ${acct.key ? acct.key.slice(0, 6) + '...' : '（下次代理请求时自动换取）'}`);
    console.log('提示: 模型映射将在下次 npm start 或 npm run setup 时按新账号权限重新同步。');
  }
}

/* ─── login：委托 login.js 完整设备码流程（独立进程，凭据写 accounts/ + 设为当前） ─── */
function cmdLogin(name) {
  const args = [path.join(HERE, 'login.js')];
  if (name) args.push('--name', name);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

/* ─── remove ─── */
async function cmdRemove(name) {
  if (!name) die('用法: npm run account -- remove <name>');
  const slug = accounts.slugify(name);
  const wasCurrent = accounts.getCurrentName() === slug;
  const result = await accounts.removeAccount(slug);
  if (!result.removed) die(result.error || '删除失败');
  ok(`已删除账号 [${slug}]`);
  if (wasCurrent) {
    if (result.nextCurrent) {
      console.log(`当前账号已自动切换到 [${result.nextCurrent}]`);
      const port = process.env.CODELY_PROXY_PORT || DEFAULT_PROXY_PORT;
      if (await isProxyUp(port)) {
        await fetch(`http://127.0.0.1:${port}/account/switch?name=${encodeURIComponent(result.nextCurrent)}`, {
          method: 'POST', body: JSON.stringify({ name: result.nextCurrent }),
        }).catch(() => { /* 尽力而为 */ });
        console.log('（已同步代理，模型映射自动重探）');
      }
    } else {
      console.log('没有剩余账号：已清空激活凭据（重新 npm run login 即可）。');
    }
  }
}

/* ─── help ─── */
function help() {
  console.log(`codely-dsh-bridge — 多账号管理

用法: npm run account -- <command> [args]

命令:
  list                列出所有已登录账号（* 标记当前）
  switch <name>       切换到指定账号（代理运行中会自动重探模型映射）
  login [name]        设备码登录一个新账号并设为当前（缺省名自动取 team_name/user_id）
  remove <name>       删除账号（删当前账号时自动切到剩余第一个）
  show                显示当前账号详情
  help                显示本帮助

示例:
  npm run account -- list
  npm run account -- switch my-team-a
  npm run account -- login my-team-a      # 浏览器授权登录
  npm run account -- remove my-team-a

账号数据: 本目录 accounts/（含凭据，已 gitignore，勿外传）。
小球切换: dsh web 右下角额度圈 → 展开 → 顶部账号下拉，同样可一键切换（同一套端点和逻辑）。`);
}

/* ─── 入口 ─── */
async function main() {
  const cmd = process.argv[2] || 'list';
  const arg = process.argv[3];
  switch (cmd) {
    case 'list': case 'ls': return cmdList();
    case 'show': case 'current': return cmdShow();
    case 'switch': return cmdSwitch(arg);
    case 'login': return cmdLogin(arg);
    case 'remove': case 'rm': return cmdRemove(arg);
    case 'help': case '--help': case '-h': return help();
    default: die(`未知命令: ${cmd}（npm run account -- help）`);
  }
}

main().catch((e) => die(e.message));
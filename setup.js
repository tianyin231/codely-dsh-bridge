#!/usr/bin/env node
/**
 * codely-dsh-bridge — 安装脚本（幂等，可重复运行）
 *
 * 做五件事：
 *  1. 换取 sk- 密钥（凭据优先级：本项目 codely-creds.json → ~/.codely-cli）
 *  2. 在 ~/.dsh/settings.yaml 注册 `codely` provider（指向本地代理）
 *  3. 在 ~/.dsh/.credentials.yaml 写入 CODELY_API_KEY
 *  4. 可选 --set-default：把 dsh 默认模型切到 codely
 *  5. 自动装配 dsh-codely-quota 插件（见下，开箱即有额度圈）
 *
 * 修改前自动备份为 *.bak-codely（仅首次），可用 uninstall.js 回滚。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const auth = require('./codely-auth');
const coconfig = require('./codely-config');

const HERE = __dirname;
const DSH_HOME = path.join(os.homedir(), '.dsh');

/* 查询 /v1/models 失败时的保守回退。
 * 只列 id、不带窗口/模态信息（避免写死误导；缺失时 dsh 用框架默认 256K，安全但会早压缩）。
 * 注意：账号不一定包含全部档位，若写入的模型实际不可用，代理会把上游
 * “team not allowed to access model”错误原样透传给 dsh，不会静默失败。 */
const FALLBACK_MODELS = [
  { id: 'codely-core' },
  { id: 'codely-flash' },
  { id: 'codely-air' },
  { id: 'codely-basic' },
  { id: 'codely-vl' },
];

/** 检查本地代理是否在监听（/healthz 快速探测，0.8s 超时） */
async function isProxyUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

/** 查询模型列表（优先走本地代理，与 dsh 实际路径同源），探测真实后端校正窗口，返回 {models, liveIds, backends} */
async function detectModels(key) {
  let liveData;
  try {
    liveData = await auth.fetchAvailableModels(key, { proxyBaseURL: `http://127.0.0.1:${PORT}/v1` });
  } catch (e) {
    console.warn(`\n[!] 检测可用模型失败 (${e.message})`);
    console.warn('    已改用保守回退列表（仅保险兜底，可能不含/多含当前账号真实可用模型，且窗口信息缺失）');
    console.warn(`    请确认代理已启动 (npm start) 后重跑: npm run setup`);
    return { models: FALLBACK_MODELS, liveIds: new Set(FALLBACK_MODELS.map(m => m.id)), backends: [] };
  }
  const liveIds = liveData.map(m => m.id);

  // 探测每个 alias 的真实后端：优先经本地代理（代理注入 sk- 密钥与身份头）；
  // 代理未启动或经代理全部失败时回退直连上游（带密钥与身份头直探，保证 setup 在代理未运行时同样可用）
  console.log(`\n  探测真实后端 ...`);
  let backends;
  if (await isProxyUp(PORT)) {
    backends = await auth.probeBackends(liveIds, { base: `http://127.0.0.1:${PORT}/v1` });
    const failed = backends.filter((b) => b.error).map((b) => b.alias);
    if (failed.length) {
      console.warn(`    [!] ${failed.length} 个 alias 经代理探测失败，回退直连补探（${failed.join(', ')}）...`);
      const direct = await auth.probeBackends(failed, { apiKey: key, concurrency: 3 });
      backends = backends.map((b) => (b.error ? direct.find((d) => d.alias === b.alias) || b : b));
    }
  } else {
    console.warn(`    [!] 本地代理未启动（:${PORT}），回退直连探测真实后端 ...`);
    backends = await auth.probeBackends(liveIds, { apiKey: key, concurrency: 3 });
  }
  for (const b of backends) {
    const w = b.contextWindow ? `${Math.round(b.contextWindow / 1024)}K` : (b.error ? `探测失败(${b.error})` : '?');
    console.log(`    ${b.alias.padEnd(15)} -> ${b.backend || b.error}  (ctx ${w})`);
  }
  const models = coconfig.buildModels(liveData, backends);
  console.log(`检测到 ${models.length} 个: ${liveIds.join(', ')}`);
  return { models, liveIds: new Set(liveIds), backends, liveData };
}

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = argValue('--port', '8790');
const SET_DEFAULT = process.argv.includes('--set-default');
const DEFAULT_MODEL = argValue('--model', 'codely-core');

function die(msg) { console.error(`\n[x] ${msg}`); process.exit(1); }
function ok(msg) { console.log(`[✓] ${msg}`); }

function backupOnce(file) {
  const bak = `${file}.bak-codely`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    ok(`已备份 ${path.basename(file)} -> ${path.basename(bak)}`);
  }
}

function loadYaml(file) {
  try { return yaml.load(fs.readFileSync(file, 'utf8')) || {}; }
  catch (e) { die(`解析 ${file} 失败: ${e.message}`); }
}

function saveYaml(file, obj) {
  fs.writeFileSync(file, yaml.dump(obj, { lineWidth: 120, noRefs: true }), 'utf8');
}

/* ═══ dsh-codely-quota 插件自动装配（开箱即有额度圈）═══ */
const PLUGIN_NAME = '@dsh-external/dsh-codely-quota';
const PLUGIN_DIR = path.join(HERE, 'plugins', 'dsh-codely-quota');
const DSH_PROFILE_LINK = path.join('node_modules', '@dsh-external', 'dsh-codely-quota');

/** 找 dsh profile 目录（优先 web；否则唯一 profile；都没有则返回 null） */
function findProfileDir() {
  const profiles = path.join(DSH_HOME, 'profiles');
  if (!fs.existsSync(profiles)) return null;
  const web = path.join(profiles, 'web');
  if (fs.existsSync(path.join(web, 'package.json'))) return web;
  const dirs = fs.readdirSync(profiles)
    .map((d) => path.join(profiles, d))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')));
  return dirs.length === 1 ? dirs[0] : dirs.length ? dirs[0] : null;
}

/** 跨平台符号链接（Windows junction 免管理员；已存在则跳过） */
function ensureLink(target, linkPath) {
  if (fs.existsSync(linkPath)) return false;
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, type);
  return true;
}

/** 把插件写进 profile package.json（dependencies + bundles），幂等 */
function wireProfilePackage(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  backupOnce(pkgPath);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = Object.assign({}, pkg.dependencies, {
    [PLUGIN_NAME]: 'link:' + PLUGIN_DIR.replace(/\\/g, '/'),
  });
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.slice() : [];
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
  pkg.dsh = Object.assign({}, pkg.dsh, { profile: Object.assign({}, pkg.dsh?.profile, { bundles }) });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return true;
}

/** 插件运行时依赖 junction（@deepseek-ai/dsh-tools、@deepseek-ai/schemastery），指向 dsh 安装（尽力而为） */
function ensurePluginDeps() {
  const deps = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'];
  const done = [];
  const resolved = new Map();
  const probe = (base) => deps.forEach((d) => {
    const segments = d.split('/');
    // base 可能已含 @scope 目录（如 …/node_modules/@deepseek-ai）：带 scope 全拼会叠成双重 @scope，
    // 因此同时试「全名拼接」与「仅 basename 拼接」两种候选
    const p1 = path.join(base, ...segments);
    const p2 = segments.length > 1 ? path.join(base, ...segments.slice(1)) : null;
    if (!resolved.has(d) && fs.existsSync(p1)) resolved.set(d, p1);
    else if (!resolved.has(d) && p2 && fs.existsSync(p2)) resolved.set(d, p2);
  });
  // 候选路径：全局 npm root 下的 dsh 安装（npx 安装时 nvm/全局目录）
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  if (npmRoot) {
    probe(path.join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
    probe(path.join(npmRoot, '@deepseek-ai'));
  }
  // 不依赖 npm 的通用根：node 可执行文件同级或上一级的全局 node_modules（nvm / nvm4w / 常规安装均覆盖）
  for (const rel of ['.', '..']) {
    const execRoot = path.resolve(path.dirname(process.execPath), rel, 'node_modules');
    if (!fs.existsSync(execRoot)) continue;
    probe(path.join(execRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
    probe(path.join(execRoot, '@deepseek-ai'));
  }
  // 候选路径：从本机任意已装 dsh 处反向解析（环境变量 DSH_CHECKOUT 常见于源码开发机）
  if (process.env.DSH_CHECKOUT) {
    probe(path.join(process.env.DSH_CHECKOUT, 'node_modules', '@deepseek-ai'));
  }
  for (const d of deps) {
    const target = resolved.get(d);
    if (!target) { console.log(`    [i] 未定位 ${d}（无法自动建依赖链接；可手动补 node_modules 后重跑）`); continue; }
    const linkPath = path.join(PLUGIN_DIR, 'node_modules', ...d.split('/'));
    if (ensureLink(target, linkPath)) { ok(`    ${d} -> ${target}`); done.push(d); }
  }
  return done;
}

function warn(msg) { console.log(`[!] ${msg}`); }

/** 装配插件：profile bundles + profile junction + 插件自身依赖链接。返回消息数组 */
function wireQuotaPlugin() {
  const msgs = [];
  if (!fs.existsSync(path.join(PLUGIN_DIR, 'lib', 'index.js')) || !fs.existsSync(path.join(PLUGIN_DIR, 'lib', 'client.js'))) {
    msgs.push('    [跳过] plugins/dsh-codely-quota 缺少 lib 产物');
    return msgs;
  }
  const profileDir = findProfileDir();
  if (!profileDir) { msgs.push('    [跳过] 未找到 ~/.dsh/profiles/<profile>/package.json（请先运行过一次 dsh）'); return msgs; }
  if (!wireProfilePackage(profileDir)) { msgs.push('    [跳过] profile package.json 不可写'); return msgs; }
  const linked = ensureLink(PLUGIN_DIR, path.join(profileDir, DSH_PROFILE_LINK));
  msgs.push(`    ${linked ? '已链接' : '已存在链接'}: ~/.dsh/profiles/${path.basename(profileDir)}/node_modules/${PLUGIN_NAME}`);
  ensurePluginDeps();
  msgs.push('    插件已写入 profile：dependencies + bundles（重启 dsh 后自动装配并显示额度圈；当前运行的会话需刷新页面并确保代理已启动）');
  return msgs;
}

async function main() {
  console.log('codely-dsh-bridge 安装');
  console.log('======================');

  /* 1. 换取密钥（凭据来自 login.js 或官方 CLI） */
  process.stdout.write('[1/5] 换取 Codely API 密钥 ... ');
  const creds = auth.loadCreds();
  if (!creds) {
    die([
      '未找到登录凭据。',
      '    · 脚本内直接登录（推荐，无需安装 codely CLI）:  npm run login',
      '    · 或在官方 codely CLI 中完成登录后重试本脚本',
    ].join('\n'));
  }
  console.log(`（凭据来源: ${creds.source}）`);
  let key;
  try { key = await auth.fetchApiKey(creds); }
  catch (e) { die(`${e.message}`); }
  fs.writeFileSync(path.join(HERE, 'key.cache'), key, 'utf8');
  console.log(`完成 (${key.slice(0, 6)}...)`);

  /* 2. 检测可用模型（实时查 /v1/models，不写死，避免下线模型误导） */
  process.stdout.write('[2/5] 检测可用模型 ... ');
  const detected = await detectModels(key);
  let defaultModel = DEFAULT_MODEL;
  if (SET_DEFAULT && !detected.liveIds.has(defaultModel)) {
    const fallback = detected.liveIds.has('codely-core') ? 'codely-core' : detected.models[0]?.id;
    console.warn(`\n[!] 指定的默认模型 ${defaultModel} 不在可用列表中，改用 ${fallback}`);
    defaultModel = fallback;
  }

  /* 3. 注册 dsh provider */
  process.stdout.write('[3/5] 配置 ~/.dsh/settings.yaml ... ');
  if (!fs.existsSync(DSH_HOME)) die(`未找到 ${DSH_HOME}，请先运行过一次 dsh`);
  const settingsPath = coconfig.SETTINGS_PATH;
  backupOnce(settingsPath);
  coconfig.writeCodelyProvider({
    port: PORT,
    models: detected.models,
    defaultModel: SET_DEFAULT ? defaultModel : undefined,
  });
  console.log('完成');

  /* 4. 写入凭据 */
  process.stdout.write('[4/5] 配置 ~/.dsh/.credentials.yaml ... ');
  const credPath = path.join(DSH_HOME, '.credentials.yaml');
  backupOnce(credPath);
  const credsYaml = loadYaml(credPath);
  credsYaml.CODELY_API_KEY = key;
  saveYaml(credPath, credsYaml);
  console.log('完成');

  /* 5. 自动装配 dsh-codely-quota 插件（拨盘式：开箱即有额度圈） */
  process.stdout.write('[5/6] 装配额度悬浮圈插件 ... ');
  try {
    console.log('\n' + wireQuotaPlugin());
  } catch (e) {
    console.warn(`    [!] 插件装配失败（不影响代理/模型配置）: ${e.message}`);
  }
  console.log('完成');

  /* 6. 汇总 */
  ok('安装完成\n');
  console.log(`可用模型 (${detected.models.length}): ${detected.models.map(m => m.id).join(', ')}`);
  console.log('\n后续步骤:');
  console.log(`  1. 启动代理:  双击 start.cmd  或  npm start          (端口 ${PORT})`);
  console.log('  2. 运行 dsh:  dsh web（若 dsh 已在运行请刷新页面）→ 右下角应出现 Codely 额度圈');
  if (!SET_DEFAULT) {
    console.log('  3. (可选) 设为默认模型:  npm run setup -- --set-default --model codely-core');
  } else {
    console.log(`  ·  已设为默认模型: ${defaultModel}（dsh web 直接可用）`);
  }
  console.log('\n提示: 模型列表会随账号权限变化，重跑 npm run setup 即可刷新；')
  console.log('      额度圈插件已写入 profile（dependencies+bundles），重启 dsh 后自动装配。');
  console.log('回滚:  npm run uninstall');
}

main().catch((e) => die(e.message));

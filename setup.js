#!/usr/bin/env node
/**
 * codely-dsh-bridge — 安装脚本（幂等，可重复运行）
 *
 * 做四件事：
 *  1. 换取 sk- 密钥（凭据优先级：本项目 codely-creds.json → ~/.codely-cli）
 *  2. 在 ~/.dsh/settings.yaml 注册 `codely` provider（指向本地代理）
 *  3. 在 ~/.dsh/.credentials.yaml 写入 CODELY_API_KEY
 *  4. 可选 --set-default：把 dsh 默认模型切到 codely
 *
 * 修改前自动备份为 *.bak-codely（仅首次），可用 uninstall.js 回滚。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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

  // 探测每个 alias 的真实后端（经本地代理：代理注入 sk- 密钥与身份头）
  console.log(`\n  探测真实后端 ...`);
  const backends = await auth.probeBackends(liveIds, { base: `http://127.0.0.1:${PORT}/v1` });
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

  /* 5. 汇总 */
  ok('安装完成\n');
  console.log(`可用模型 (${detected.models.length}): ${detected.models.map(m => m.id).join(', ')}`);
  console.log('\n后续步骤:');
  console.log(`  1. 启动代理:  双击 start.cmd  或  npm start          (端口 ${PORT})`);
  console.log('  2. 运行 dsh:  dsh web  然后在模型列表选择 codely 系列');
  if (!SET_DEFAULT) {
    console.log('  3. (可选) 设为默认模型:  npm run setup -- --set-default --model codely-core');
  } else {
    console.log(`  ·  已设为默认模型: ${defaultModel}（dsh web 直接可用）`);
  }
  console.log('\n提示: 模型列表会随账号权限变化，重跑 npm run setup 即可刷新');
  console.log('回滚:  npm run uninstall');
}

main().catch((e) => die(e.message));

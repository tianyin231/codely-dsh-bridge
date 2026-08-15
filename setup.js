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

const HERE = __dirname;
const DSH_HOME = path.join(os.homedir(), '.dsh');

const MODELS = [
  { id: 'codely-core', contextWindow: 1048576 },
  { id: 'codely-flash' },
  { id: 'codely-air' },
  { id: 'codely-basic' },
  { id: 'codely-vl', input: ['text', 'image'] },
  { id: 'GLM-5.2', contextWindow: 1048576 },
  { id: 'GLM-5.3' },
];

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
  process.stdout.write('[1/4] 换取 Codely API 密钥 ... ');
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

  /* 2. 注册 dsh provider */
  process.stdout.write('[2/4] 配置 ~/.dsh/settings.yaml ... ');
  if (!fs.existsSync(DSH_HOME)) die(`未找到 ${DSH_HOME}，请先运行过一次 dsh`);
  const settingsPath = path.join(DSH_HOME, 'settings.yaml');
  backupOnce(settingsPath);
  const settings = loadYaml(settingsPath);
  settings['llm-pi-ai'] ||= {};
  settings['llm-pi-ai'].providers ||= {};
  settings['llm-pi-ai'].providers.codely = {
    apiKeyEnv: 'CODELY_API_KEY',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${PORT}/v1`,
    models: MODELS,
  };
  if (SET_DEFAULT) {
    settings['agent-default-model'] = { provider: 'codely', model: DEFAULT_MODEL };
  }
  saveYaml(settingsPath, settings);
  console.log('完成');

  /* 3. 写入凭据 */
  process.stdout.write('[3/4] 配置 ~/.dsh/.credentials.yaml ... ');
  const credPath = path.join(DSH_HOME, '.credentials.yaml');
  backupOnce(credPath);
  const credsYaml = loadYaml(credPath);
  credsYaml.CODELY_API_KEY = key;
  saveYaml(credPath, credsYaml);
  console.log('完成');

  /* 4. 汇总 */
  ok('安装完成\n');
  console.log('后续步骤:');
  console.log(`  1. 启动代理:  双击 start.cmd  或  npm start          (端口 ${PORT})`);
  console.log('  2. 运行 dsh:  dsh web  然后在模型列表选择 codely 系列');
  if (!SET_DEFAULT) {
    console.log('  3. (可选) 设为默认模型:  npm run setup -- --set-default --model codely-core');
  } else {
    console.log(`  ·  已设为默认模型: ${DEFAULT_MODEL}（dsh web 直接可用）`);
  }
  console.log('\n回滚:  npm run uninstall');
}

main().catch((e) => die(e.message));

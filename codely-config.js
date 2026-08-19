/**
 * codely-dsh-bridge — dsh 配置的 codely provider 共享构建/写入逻辑
 *
 * setup.js（手动安装/同步）与 codely-proxy.js（启动时自动同步）共用：
 *   · buildModels —— 把 /v1/models 快照 + 真实后端探测合并为 dsh 的 codely.models 数组
 *   · writeCodelyProvider —— 把 codely provider（含 models）原子写回 ~/.dsh/settings.yaml
 *
 * 这样代理启动时也能探测真实后端并把「真正的模型名」映射进 dsh 界面。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SETTINGS_PATH = path.join(DSH_HOME, 'settings.yaml');

/* alias → 语义名回退（仅当该 alias 探测不到真实后端代号时使用；探测到时 name 直接用真实代号）。
 * name 作为 dsh 模型选择器主标签；选择/发送仍用 id（必须保持 alias，否则网关 401）。 */
const MODEL_NAME_MAP = {
  'codely-core': 'GLM-5（core）',
  'codely-flash': 'DeepSeek-V4-Flash（flash）',
  'codely-vl': 'Qwen3.5（vl，多模态）',
  'GLM-5.2': 'GLM-5.2',
  'GLM-5.3': 'GLM-5.3',
};

/**
 * 把 /v1/models 快照 + 真实后端探测合并为 dsh 的 codely.models 条目数组。
 * name 展示规则（由真实后端探测驱动，官方新增 alias 放行后启动探测即自动纳入，无需改码）：
 *   · 探测到真实后端代号 → name = 「后端代号（alias）」，如 "deepseek-v4-flash-0731（codely-flash）"
 *   · 探测失败 → 回退语义名 MODEL_NAME_MAP，如 "DeepSeek-V4-Flash（flash）"
 * id 始终保持 alias（网关只放行 alias，真实代号不可作请求 model）。
 * @param {Array<{id:string, max_model_len?:number}>} liveData  /v1/models 的 data
 * @param {Array<{alias:string, backend?:string, contextWindow?:number, input?:string[]}>} backends  probeBackends 结果
 * @returns {Array<{id:string, name?:string, contextWindow?:number, input?:string[]}>}
 */
function buildModels(liveData, backends) {
  const byAlias = new Map((backends || []).filter((b) => b.backend).map((b) => [b.alias, b]));
  return liveData.map((m) => {
    const entry = { id: m.id };
    const bk = byAlias.get(m.id);
    if (bk?.backend) entry.name = `${bk.backend}（${m.id}）`;
    else if (MODEL_NAME_MAP[m.id]) entry.name = MODEL_NAME_MAP[m.id];
    const w = bk?.contextWindow;
    if (w) entry.contextWindow = w;
    else if (m.max_model_len) entry.contextWindow = m.max_model_len;
    if (bk?.input) entry.input = bk.input;
    return entry;
  });
}

/** 加载 ~/.dsh/settings.yaml（不存在则空对象） */
function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try { return yaml.load(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {}; }
  catch (e) { throw new Error(`解析 ${SETTINGS_PATH} 失败: ${e.message}`); }
}

/**
 * 把 codely provider（baseURL→port、models，可选 defaultModel）写回 ~/.dsh/settings.yaml 的
 * llm-pi-ai.providers.codely，保留其他 provider 与顶层字段。返回是否写入。
 * 写回后 dsh 监听 settings/document-updated 会自动刷新模型选择界面。
 * @param {object} o
 * @param {number} [o.port=8790]
 * @param {Array} o.models  codely.models 条目
 * @param {string} [o.defaultModel]  若提供则同时设 agent-default-model.provider/model
 */
function writeCodelyProvider({ port = 8790, models, defaultModel } = {}) {
  if (!fs.existsSync(DSH_HOME)) throw new Error(`未找到 ${DSH_HOME}，请先运行过一次 dsh`);
  const settings = loadSettings();
  settings['llm-pi-ai'] ||= {};
  settings['llm-pi-ai'].providers ||= {};
  const existing = settings['llm-pi-ai'].providers.codely || {};
  const next = {
    ...existing, // 保留 apiKeyEnv/api 等（即便被旧版遗漏）
    apiKeyEnv: existing.apiKeyEnv || 'CODELY_API_KEY',
    api: existing.api || 'openai-completions',
    baseURL: `http://127.0.0.1:${port}/v1`,
    models,
  };
  settings['llm-pi-ai'].providers.codely = next;
  if (defaultModel) {
    settings['agent-default-model'] = { provider: 'codely', model: defaultModel };
  }
  fs.writeFileSync(SETTINGS_PATH, yaml.dump(settings, { lineWidth: 120, noRefs: true }), 'utf8');
  return true;
}

module.exports = { buildModels, writeCodelyProvider, loadSettings, MODEL_NAME_MAP, SETTINGS_PATH, DSH_HOME };

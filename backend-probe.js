#!/usr/bin/env node
/**
 * codely-dsh-bridge — 探测 `codely-*` alias 背后的真实后端模型
 *
 * LiteLLM 网关会在 chat.completions 响应的 `model` 字段透传真实后端模型名
 * （由路由层填充，非模型自报，无法伪造）。本脚本对每个 alias 发一个最小请求，
 * 打印透传的真实后端名与上下文窗口，用于核对模型路由是否变化。
 *
 * 用法:  node backend-probe.js            (默认 http://127.0.0.1:8790/v1)
 *        node backend-probe.js --base http://127.0.0.1:9000/v1
 * 前提:  本地代理已启动（走代理时无需密钥；若直接指向上游网关直连地址则需 --key）。
 */
'use strict';

const auth = require('./codely-auth');

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BASE = argValue('--base', process.env.CODELY_PROXY_URL || 'http://127.0.0.1:8790/v1');
const KEY = argValue('--key', '');

const ALIASES = ['codely-flash', 'codely-core', 'codely-air', 'codely-basic', 'codely-vl'];

async function main() {
  console.log(`探测后端 (${BASE})\n`);
  const rows = await auth.probeBackends(ALIASES, { base: BASE, apiKey: KEY || undefined, concurrency: 3 });
  for (const r of rows) {
    if (r.error) { console.log(`  ${r.alias.padEnd(15)} -> ${r.error}`); continue; }
    const w = r.contextWindow ? `${Math.round(r.contextWindow / 1024)}K` : '?';
    const modal = r.input?.includes('image') ? ', 图片' : '';
    console.log(`  ${r.alias.padEnd(15)} -> ${r.backend}  (ctx ${w}${modal})`);
  }
  console.log('\n对照参考（随网关调整，以本脚本实测为准）:');
  console.log('  codely-flash/air/basic -> deepseek-v4-flash-0731 (DeepSeek-V4-Flash, 1M)');
  console.log('  codely-core            -> glm-5-fp8-128k (GLM-5, FP8, 128K)');
  console.log('  codely-vl              -> qwen3.5-397b-a17b (Qwen3.5 MoE, 128K, 支持图片)');
}

main().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * codely-dsh-bridge — 查询当前账号可用的模型列表
 *
 * 直连 Codely LiteLLM 网关 GET /v1/models，显示实际可用模型。
 * 不同账号/会员档位返回的列表不同（如 GLM 系列仅会员可用）。
 *
 * 用法:  npm run models
 */
'use strict';

const auth = require('./codely-auth');

async function main() {
  const creds = await auth.getAccessToken();
  if (!creds) {
    console.error('未找到登录凭据。请先运行: npm run login');
    process.exit(1);
  }
  const key = await auth.fetchApiKey(creds);
  const models = await auth.fetchAvailableModels(key);

  console.log(`Codely API 密钥: ${key.slice(0, 6)}...`);
  console.log(`可用模型 (${models.length}):\n`);
  for (const m of models) {
    const ctx = m.max_model_len ? `  上下文 ${Math.round(m.max_model_len / 1024)}K` : '';
    const alias = m.is_alias ? '  [alias]' : '';
    console.log(`  ${m.id}${ctx}${alias}`);
  }
  console.log('\n提示: 模型列表随账号权限变化，重跑 npm run setup 可同步到 dsh');
}

main().catch((e) => { console.error(e.message); process.exit(1); });

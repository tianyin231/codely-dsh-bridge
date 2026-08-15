#!/usr/bin/env node
/** 冒烟测试：需要代理已在运行（默认 http://127.0.0.1:8790） */
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8790';

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) { pass++; console.log(`[✓] ${name}`); }
    else { fail++; console.log(`[x] ${name}`); }
  };

  /* 1. 健康检查 */
  try {
    const r = await fetch(`${BASE}/healthz`);
    check('GET /healthz -> 200', r.status === 200);
  } catch (e) { check(`GET /healthz（代理是否已启动？${e.message}）`, false); }

  /* 2. 模型列表 */
  try {
    const r = await fetch(`${BASE}/v1/models`);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    check(`GET /v1/models -> 200 (${ids.length} 个模型)`, r.status === 200);
    check('模型列表包含 codely-core / codely-flash', ids.includes('codely-core') && ids.includes('codely-flash'));
  } catch { check('GET /v1/models', false); }

  /* 3. 一次对话 */
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'codely-flash',
        messages: [{ role: 'user', content: '只回复两个字：成功' }],
        max_completion_tokens: 50,
      }),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    check(`POST /v1/chat/completions -> ${r.status}`, r.status === 200);
    check(`模型回复正常 ("${text.trim()}")`, r.status === 200 && text.length > 0);
  } catch { check('POST /v1/chat/completions', false); }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * codely-dsh-bridge — 卸载脚本
 *
 * 优先恢复 *.bak-codely 备份；若无备份则从当前配置中摘除 codely 相关条目。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const DSH_HOME = path.join(os.homedir(), '.dsh');

function ok(msg) { console.log(`[✓] ${msg}`); }
function info(msg) { console.log(`[i] ${msg}`); }

function restoreOrPatch(file, patch) {
  const bak = `${file}.bak-codely`;
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
    fs.unlinkSync(bak);
    ok(`${path.basename(file)}: 已恢复原始备份`);
    return;
  }
  if (!fs.existsSync(file)) { info(`${path.basename(file)}: 不存在，跳过`); return; }
  const obj = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  patch(obj);
  fs.writeFileSync(file, yaml.dump(obj, { lineWidth: 120, noRefs: true }), 'utf8');
  ok(`${path.basename(file)}: 已摘除 codely 条目`);
}

restoreOrPatch(path.join(DSH_HOME, 'settings.yaml'), (s) => {
  delete s['llm-pi-ai']?.providers?.codely;
  if (s['agent-default-model']?.provider === 'codely') {
    delete s['agent-default-model'];
    info('默认模型原为 codely，已移除该设置（dsh 将使用其内置默认）');
  }
});

restoreOrPatch(path.join(DSH_HOME, '.credentials.yaml'), (c) => {
  delete c.CODELY_API_KEY;
});

console.log('\n卸载完成。key.cache / session.cache 留在本目录，可手动删除。');

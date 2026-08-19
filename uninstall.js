#!/usr/bin/env node
/**
 * codely-dsh-bridge — 卸载脚本（保证卸载干净）
 *
 * 清理范围：
 *  1. ~/.dsh/settings.yaml 的 codely provider / 默认模型（优先恢复 *.bak-codely）
 *  2. ~/.dsh/.credentials.yaml 的 CODELY_API_KEY（优先恢复 *.bak-codely）
 *  3. dsh profile 的插件装配：package.json（dependencies + bundles，强制摘除）+ node_modules junction
 *  4. 注入器注册表 ~/.dsh/super-injector/registry.json 中本插件的记录
 *  5. 本目录可再生的运行时缓存：key.cache / session.cache（登录凭据 codely-creds.json 保留，便于重装免登录）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const HERE = __dirname;
const DSH_HOME = path.join(os.homedir(), '.dsh');
const PLUGIN_NAME = '@dsh-external/dsh-codely-quota';

function ok(msg) { console.log(`[✓] ${msg}`); }
function info(msg) { console.log(`[i] ${msg}`); }

/* ── 卸载 dsh-codely-quota 插件装配（npm run setup 第 5 步的反向）── */
function uninstallPlugin() {
  const profiles = path.join(DSH_HOME, 'profiles');
  if (!fs.existsSync(profiles)) return;
  const dirs = fs.readdirSync(profiles)
    .map((d) => path.join(profiles, d))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')));
  for (const profileDir of dirs) {
    // 1) profile junction
    const link = path.join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/'));
    if (fs.existsSync(link)) {
      try { fs.rmSync(link, { recursive: false, force: true }); ok(`已移除 profile 链接: ${link}`); }
      catch (e) { info(`移除链接失败: ${e.message}`); }
    }
    // 2) package.json 的 dependencies + bundles 条目
    const pkgPath = path.join(profileDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    // 不依赖 .bak-codely 恢复：备份可能是「装配后」的快照（如先经 dev_install_package 装配、
    // 后 setup 才备份），恢复它反而删不掉条目。直接摘除才是确定性结果；残留备份一并删除。
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let touched = false;
    if (pkg.dependencies?.[PLUGIN_NAME]) { delete pkg.dependencies[PLUGIN_NAME]; touched = true; }
    const bundles = pkg.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes(PLUGIN_NAME)) {
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME);
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      ok(`${path.basename(pkgPath)}: 已摘除 ${PLUGIN_NAME}`);
    }
    const backup = `${pkgPath}.bak-codely`;
    if (fs.existsSync(backup)) { try { fs.unlinkSync(backup); info(`已清理残留备份 ${path.basename(backup)}`); } catch { /* 忽略 */ } }
  }
}

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

/* ── 清理注入器注册表中的本插件记录（dev_inject_plugin 写入，卸载须一并移除）── */
function cleanInjectorRegistry() {
  const regPath = path.join(DSH_HOME, 'super-injector', 'registry.json');
  if (!fs.existsSync(regPath)) { info('注入器注册表不存在，跳过'); return; }
  let list;
  try { list = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const before = list.length;
  const next = list.filter((e) => !(e && (e.name === PLUGIN_NAME || String(e.dir || '').includes('dsh-codely-quota'))));
  if (next.length !== before) {
    fs.writeFileSync(regPath, JSON.stringify(next, null, 2), 'utf8');
    ok(`注入器注册表: 已移除 ${before - next.length} 条记录（现 ${next.length} 条）`);
  } else {
    info('注入器注册表: 无本插件记录');
  }
}

/* ── 清理本目录可再生的运行时缓存（凭据 codely-creds.json 保留，便于重装免登录）── */
function cleanLocalCaches() {
  for (const name of ['key.cache', 'session.cache']) {
    const f = path.join(HERE, name);
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); ok(`已删除 ${name}`); } catch (e) { info(`删除 ${name} 失败: ${e.message}`); } }
  }
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

uninstallPlugin();
cleanInjectorRegistry();
cleanLocalCaches();

console.log('\n卸载完成。登录凭据 codely-creds.json 已保留（重装免登录）；如需彻底清除请手动删除。');

#!/usr/bin/env node
'use strict';

/*
 * idiot-index —— 白痴指数 CLI
 * 一键量化你的项目有多「胖」：可被原生 API 替代的依赖 + 过度工程分数。
 * 零依赖、单文件、本地、确定性、可进 CI 门禁。
 *
 * 白痴指数 = 成品复杂度 ÷ 理论最小复杂度。指数越高，制造流程里的浪费越大。
 */

const fs = require('node:fs');
const path = require('node:path');

// 冗余依赖 → 原生替代。命中即说明「这包装了不该装」。
// requires: 该替代方案所需的最低 Node 主版本；null = 无版本门槛。
const REDUNDANT = {
  'lodash': {repl: '原生 Array/Object/Map 方法', requires: null},
  'underscore': {repl: '原生方法', requires: null},
  'moment': {repl: 'Intl.DateTimeFormat / Temporal', requires: null},
  'dayjs': {repl: 'Intl（已很轻，可评估是否必要）', requires: null},
  'date-fns': {repl: 'Intl（部分可替代）', requires: null},
  'chalk': {repl: 'node:util.styleText', requires: 20},
  'colors': {repl: 'ANSI 转义', requires: null},
  'picocolors': {repl: 'ANSI 转义', requires: null},
  'ansi-colors': {repl: 'ANSI 转义', requires: null},
  'is-odd': {repl: '% 2', requires: null},
  'is-even': {repl: '% 2 === 0', requires: null},
  'is-number': {repl: 'Number.isFinite / 正则', requires: null},
  'left-pad': {repl: 'String.prototype.padStart', requires: null},
  'mkdirp': {repl: 'fs.mkdir({recursive:true})', requires: null},
  'fs-extra': {repl: 'node:fs/promises', requires: null},
  'axios': {repl: 'node:fetch', requires: 18},
  'node-fetch': {repl: 'node:fetch（本身即重复）', requires: 18},
  'uuid': {repl: 'node:crypto.randomUUID', requires: 14},
  'crypto-random-string': {repl: 'node:crypto.randomUUID', requires: 14},
  'slugify': {repl: 'encodeURIComponent / Intl 折叠', requires: null},
  'pretty-bytes': {repl: 'Intl.NumberFormat', requires: null},
  'deepmerge': {repl: 'structuredClone / 手写', requires: 17},
  'clone-deep': {repl: 'structuredClone', requires: 17},
  'rimraf': {repl: 'fs.rm({recursive:true, force:true})', requires: 14},
  'glob': {repl: 'node:fs.glob', requires: 22},
  'minimatch': {repl: 'node:path 匹配 /手写', requires: null},
  'dotenv': {repl: 'node:process.loadEnvFile / --env-file', requires: 20},
  'querystring': {repl: 'node:querystring 已内置（无需安装）', requires: null},
  'object-assign': {repl: 'Object.assign（已内置）', requires: null},
  'foreach': {repl: 'Array.forEach（已内置）', requires: null},
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.vuepress', 'vendor', 'bower_components',
  '.turbo', 'tmp', '.cache',
]);

const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue']);

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// 跳过字符串/注释里的大括号，统计最大嵌套深度。
function maxNesting(src) {
  let depth = 0, max = 0;
  let state = 'normal'; // normal | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (state === 'normal') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue; }
      if (c === '/' && n === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'sq'; continue; }
      if (c === '"') { state = 'dq'; continue; }
      if (c === '`') { state = 'tpl'; continue; }
      if (c === '{') { depth++; if (depth > max) max = depth; }
      else if (c === '}') { depth = Math.max(0, depth - 1); }
    } else if (state === 'line') {
      if (c === '\n') state = 'normal';
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'normal'; i++; }
    } else if (state === 'sq') {
      if (c === '\\') { i++; continue; }
      if (c === "'") state = 'normal';
    } else if (state === 'dq') {
      if (c === '\\') { i++; continue; }
      if (c === '"') state = 'normal';
    } else if (state === 'tpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') state = 'normal';
    }
  }
  return max;
}

function fileMetrics(absPath, rootDir) {
  let src;
  try { src = fs.readFileSync(absPath, 'utf8'); }
  catch { return null; }
  const lines = src.split('\n').length;
  const depth = maxNesting(src);
  const typeCount = (src.match(/(?:interface|type)\s+[A-Za-z_]\w*/g) || []).length;
  const arrowCount = (src.match(/=>/g) || []).length;
  const fnCount = (src.match(/\bfunction\b/g) || []).length + arrowCount;
  const nestingScore = clamp(depth / 12, 0, 1) * 50;
  const abstractionScore = clamp(typeCount / 20, 0, 1) * 50;
  const fileScore = Math.round(nestingScore + abstractionScore);
  // rel 必须相对扫描根，而不是 cwd —— 否则临时目录/外部路径会退化成 ..\..\..\Foo
  const rel = path.relative(rootDir, absPath);
  return {
    rel: (rel === '' ? path.basename(absPath) : rel).split(path.sep).join('/'),
    lines, depth, typeCount, fnCount, fileScore,
  };
}

function walk(dir, rootDir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(abs, rootDir, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (SRC_EXT.has(ext) && !e.name.endsWith('.min.js') && !e.name.endsWith('.d.ts')) {
        const m = fileMetrics(abs, rootDir);
        if (m) out.push(m);
      }
    }
  }
}

function gradeOf(score) {
  if (score < 20) return 'A';
  if (score < 40) return 'B';
  if (score < 60) return 'C';
  if (score < 80) return 'D';
  return 'F';
}

// ---- 依赖是否真被源码使用 ----
// 旧实现只看 package.json，于是「代码里正在用 lodash」也会被建议「删掉 lodash」。
// 这里做一次轻量引用检测，把「声明了」和「真在用」区分开。
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;

function bareName(spec) {
  // @scope/pkg/sub -> @scope/pkg ; pkg/sub -> pkg ; node:fs -> null
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

// 收集源码里出现的所有裸模块名（含 lodash/xxx 这种子路径用法）
function collectImports(files, rootDir) {
  const used = new Set();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(rootDir, f.rel.split('/').join(path.sep)), 'utf8'); }
    catch { continue; }
    for (const re of [REQUIRE_RE, IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const n = bareName(m[1]);
        if (n) used.add(n);
      }
    }
  }
  return used;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// 递归收集所有 package.json 的依赖（支持 monorepo / workspaces）
function collectManifests(root) {
  const out = [];
  const visit = (dir) => {
    if (out.length >= 200) return;                    // 防跑飞
    const pj = path.join(dir, 'package.json');
    const raw = readJson(pj);
    if (raw && typeof raw === 'object') {
      out.push({
        dir,
        rel: path.relative(root, dir).split(path.sep).join('/') || '.',
        pkg: raw,
      });
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      visit(path.join(dir, e.name));
    }
  };
  visit(root);
  return out;
}

function analyze(targetDir, opts) {
  const strictUsage = !!(opts && opts.requireUsage);
  const root = path.resolve(targetDir || '.');

  // 目标不存在时必须报错，不能当成「空项目 = 满分」
  if (!fs.existsSync(root)) {
    const e = new Error('目标目录不存在: ' + root);
    e.code = 'ENOTARGET';
    throw e;
  }
  if (!fs.statSync(root).isDirectory()) {
    const e = new Error('目标不是目录: ' + root);
    e.code = 'ENOTARGET';
    throw e;
  }

  const manifests = collectManifests(root);

  // 先扫源码（依赖引用检测需要它）
  const files = [];
  walk(root, root, files);

  const used = collectImports(files, root);

  const redundantFound = [];
  for (const name of Object.keys(REDUNDANT)) {
    let hit = null;
    for (const m of manifests) {
      if (m.pkg.dependencies && m.pkg.dependencies[name]) { hit = { m, dev: false }; break; }
      if (m.pkg.devDependencies && m.pkg.devDependencies[name]) { hit = { m, dev: true }; break; }
    }
    if (!hit) continue;
    redundantFound.push({
      name,
      replacement: REDUNDANT[name].repl,
      requiresNode: REDUNDANT[name].requires,
      dev: hit.dev,
      declaredIn: hit.m.rel === '.' ? '.' : hit.m.rel + '/package.json',
      usedInSource: used.has(name),
    });
  }

  const topFiles = files
    .slice()
    .sort((a, b) => b.fileScore - a.fileScore)
    .slice(0, 10);

  const avgTop = topFiles.length
    ? topFiles.reduce((s, f) => s + f.fileScore, 0) / topFiles.length
    : 0;

  // 「可删」= 声明了但源码没引用。strictUsage 模式下只有这类才计入惩罚。
  const counted = strictUsage ? redundantFound.filter(r => !r.usedInSource) : redundantFound;

  const redundantPenalty = clamp(counted.length * 8, 0, 50);
  const overPenalty = clamp(avgTop * 0.5, 0, 50);
  const score = Math.round(redundantPenalty + overPenalty);
  const grade = gradeOf(score);

  const suggestions = [];

  // 真在用的冗余依赖：提示替换而不是「删掉」
  const inUse = redundantFound.filter(r => r.usedInSource);
  const unused = redundantFound.filter(r => !r.usedInSource);

  for (const r of inUse) {
    const gate = r.requiresNode === null ? ''
      : `（需Node ${r.requiresNode}+；项目 ${r.declaredIn}）`;
    suggestions.push(`[在用] ${r.name} 被源码引用，先评估迁移成本 → 目标 ${r.replacement}${gate}`);
  }
  for (const r of unused) {
    suggestions.push(`[未引用] 删掉 ${r.name}${r.dev ? '(dev)' : ''} → 用 ${r.replacement}`);
  }

  if (topFiles.some(f => f.depth >= 8)) {
    suggestions.push('存在嵌套 ≥8 层的文件，拆函数/提前 return 降深度');
  }
  if (topFiles.some(f => f.typeCount >= 10)) {
    suggestions.push('类型声明偏多，确认是否过度抽象（类型≠实现）');
  }
  if (files.length === 0) {
    suggestions.push('未扫到任何源码文件——若这不是预期，请检查路径/是否含 dist 排除目录。');
  }
  if (suggestions.length === 0) {
    suggestions.push('未检出明显冗余，保持克制。');
  }

  return {
    target: root,
    score, grade,
    redundantFound,
    countedForPenalty: counted.map(r => r.name),
    strictUsage,
    scannedFiles: files.length,
    manifestsFound: manifests.length,
    // 结论可信度：源码为 0 时分数无意义，显式暴露给CI
    basisComplete: files.length > 0,
    topFiles,
    suggestions,
  };
}

function printReport(r) {
  const bar = '='.repeat(54);
  console.log(bar);
  console.log(`  白痴指数 (Idiot Index): ${r.score}/100   等级 ${r.grade}`);
  console.log(bar);
  console.log(`  扫描目录 : ${r.target.split(path.sep).join('/')}`);
  console.log(`  源码文件 : ${r.scannedFiles} 个`);
  console.log(`  package.json: ${r.manifestsFound} 个`);
  if (r.strictUsage) {
    console.log(`  严格模式: 仅「未引用」计分（计分项 ${r.countedForPenalty.length}）`);
  }
  if (!r.basisComplete) {
    console.log(`  ⚠ 未扫到任何源码文件，本分数不构成有效结论`);
  }
  console.log('');

  console.log(`[1] 可被原生 API 替代的依赖 (${r.redundantFound.length})`);
  if (r.redundantFound.length === 0) {
    console.log('    - 无。依赖克制，赞。');
  } else {
    for (const d of r.redundantFound) {
      const flag = d.usedInSource ? '[在用] ' : '[未引用]';
      console.log(`    - ${flag}${d.name}${d.dev ? ' (dev)' : ''}  →  ${d.replacement}`);
    }
  }
  console.log('');

  console.log('[2] 最「胖」的 10 个文件 (按深度+抽象)');
  if (r.topFiles.length === 0) {
    console.log('    - （无源码文件）');
  }
  for (const f of r.topFiles) {
    console.log(`    - ${f.fileScore.toString().padStart(3)}  ${f.rel}  (行${f.lines}, 深${f.depth}, 类型${f.typeCount})`);
  }
  console.log('');

  console.log('[3] 建议');
  for (const s of r.suggestions) console.log(`    * ${s}`);
  console.log('');
  console.log('  物理不允许就别做——先删，再优化。');
  console.log(bar);
}

function printHelp() {
  console.log(`idiot-index —— 白痴指数 CLI

用法:
  idiot-index [目录] [选项]

选项:
  -h, --help        显示本帮助
  --json             JSON 输出（供 CI 解析）
  --max N            指数 > N 时退出码 1（CI 门禁）
  --require-usage    只对「源码中未被引用」的冗余依赖计分（更严格）

输出字段:
  basisComplete   是否扫到源码。为 false 时分数无意义，退出码 3。
  usedInSource    该冗余依赖是否真被源码引用（区分「删掉」与「评估迁移」）

等级: A(<20) / B(<40) / C(<60) / D(<80) / F(>=80)

退出码:
  0  扫描完整且指数达标
  1  指数超阈值（--max）
  2  参数错误 / 目标目录不可用
  3  未扫到任何源码文件 —— 分数不构成有效结论

示例:
  node index.js .                    扫描当前项目
  node index.js . --max 50           CI 门禁
  node index.js . --json > i.json    机器可读`);
}

function main() {
  const args = process.argv.slice(2);
  let target = '.';
  let asJson = false;
  let requireUsage = false;
  let max = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { asJson = true; continue; }
    if (a === '--require-usage') { requireUsage = true; continue; }
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    if (a === '--max') {
      const v = args[++i];
      max = parseInt(v, 10);
      if (!Number.isFinite(max)) {
        console.error('--max 需要整数，收到: ' + JSON.stringify(v));
        process.exit(2);
      }
      continue;
    }
    if (!a.startsWith('-')) { target = a; continue; }
    console.error('未知选项: ' + a);
    process.exit(2);
  }

  let r;
  try {
    r = analyze(target, { requireUsage });
  } catch (e) {
    if (e && e.code === 'ENOTARGET') {
      console.error(e.message);
      process.exit(2);
    }
    console.error('扫描失败: ' + (e && e.message ? e.message : String(e)));
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    printReport(r);
  }

  // 未扫到源码 → 分数无意义，拒绝给出「达标」结论
  // 注意：必须用 process.exitCode 而非 process.exit()，
  // 否则 stdout 缓冲会被截断，--json 输出成残缺 JSON。
  if (!r.basisComplete) {
    console.error('\n[CI] 未扫到任何源码文件，白痴指数无有效结论（退出码 3）。请检查路径。');
    process.exitCode = 3;
    return;
  }

  if (max !== null && r.score > max) {
    console.error(`\n[CI] 白痴指数 ${r.score} > 阈值 ${max}，构建门禁失败。`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  analyze, gradeOf, REDUNDANT, maxNesting, walk, bareName, collectManifests,
};
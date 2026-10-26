#!/usr/bin/env node
'use strict';

/*
 * awaitscan — 零依赖单文件 Node CLI · 异步性能反模式静态扫描器
 *
 * 聚焦三类高信号、零依赖即可确定性检测的「性能反模式」：
 *   R1 serial-await-in-loop  循环体内串行 await（应 Promise.all 并行）
 *   R2 await-in-map          .map() 回调内 await（map 不会自动并行，经典 bug）
 *   R3 nested-loop           嵌套循环（O(n^2) 潜在风险）
 *
 * 设计铁律（继承 family 方法沉淀）：
 *   - 纯本地、零依赖、离线、单文件，跨平台（Windows posix 路径）。
 *   - 预处理剥离注释/字符串/模板串，双重降误报（排除字符串与文档里的伪 await/for）。
 *   - 块级扫描：用括号平衡定位循环体 / map 回调体，并去除内层块得到「表层」，
 *     只报表层里的 await / 嵌套循环，避免把函数内层 await 误算成循环内串行。
 *   - 门禁阈值一律 Number.isFinite 校验，非整数直接 exit 2，绝不静默放行。
 *   - root 必须 statSync 先验存在且为目录，错误路径不谎报「通过」。
 *   - 大文件（>5MB）跳过，避免 OOM。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 上限，跳过防 OOM
const SCORE_FREE = 1;                   // 每千行允许加权问题数（不扣分）
const SCORE_K = 25;                     // 超出部分扣分系数

// 规则定义（严重度 / 权重）
const RULES = {
  serialAwait: { id: 'serial-await-in-loop', severity: 'high',   weight: 3, title: '循环内串行 await' },
  awaitInMap:  { id: 'await-in-map',         severity: 'high',   weight: 3, title: 'map 回调内 await（未并行）' },
  nestedLoop:  { id: 'nested-loop',          severity: 'medium', weight: 2, title: '嵌套循环（O(n^2) 风险）' }
};

// 仅针对 JS/TS 生态源文件（不扫 .md/.json，避免文档示例代码产生伪信号）
const SRC_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte'
]);

// 注释 / 字符串 剥离已改用逐字符 tokenizer（见 stripNoise），更稳健地处理转义与跨行。

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  'coverage', '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.cache',
  '.tmp', 'tmp', 'vendor', 'bower_components', '.idea', '.vscode'
]);

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

// 逐字符剥离注释与字符串（保留换行）：比正则更稳健，不依赖复杂正则配对，
// 能正确处理转义、嵌套引号与跨行模板串，避免示例字符串里的 for/await 被误当真代码。
function stripNoise(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    // 行注释 //
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // 块注释 /* */
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out.push(code[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) { out.push(' '); out.push(' '); i += 2; } // 跳过 */
      continue;
    }
    // 字符串 / 模板串（含转义处理，保留换行）
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (code[i] === '\\') { out.push(' '); out.push(' '); i += 2; continue; }
        if (code[i] === q) { i++; break; }
        out.push(code[i] === '\n' && q === '`' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// 通用括号配对：s[idx] 为开括号 ( [ {，返回其匹配闭括号索引
function matchBracket(s, idx) {
  const open = s[idx];
  const closeMap = { '(': ')', '[': ']', '{': '}' };
  const close = closeMap[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = idx; i < s.length; i++) {
    const c = s[i];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    else if (c === '"' || c === "'" || c === '`') {
      // 跳过字符串（理论上已剥离，防御性）
      const re = c === '`' ? RE_TPL_STRING : (c === '"' ? RE_DQ_STRING : RE_SQ_STRING);
      re.lastIndex = i;
      const m = re.exec(s);
      if (m && m.index === i) { i = re.lastIndex - 1; continue; }
    }
  }
  return -1;
}

// 收集所有 { } 块 [start, end]（start=开括号索引，end=闭括号索引）
function braceBlocks(s) {
  const blocks = [];
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (start !== undefined) blocks.push({ start, end: i });
    }
  }
  return blocks;
}

// 取在某范围内的内层 { } 块（用于计算「表层」，排除内层函数/块）
function innerBlocksIn(blocks, rangeStart, rangeEnd) {
  return blocks.filter(b => b.start > rangeStart && b.end < rangeEnd);
}

// 判断索引是否落在任一内层块内
function isInside(idx, innerBlocks) {
  for (let i = 0; i < innerBlocks.length; i++) {
    if (idx > innerBlocks[i].start && idx < innerBlocks[i].end) return true;
  }
  return false;
}

// 在指定范围内（排除内层块）查找关键字首次出现位置
function findInSurface(s, re, rangeStart, rangeEnd, innerBlocks) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const idx = m.index;
    if (idx >= rangeStart && idx <= rangeEnd && !isInside(idx, innerBlocks)) return idx;
    if (m.index > rangeEnd) break;
  }
  return -1;
}

function lineOf(s, idx) {
  if (idx < 0) return -1;
  let line = 1;
  const limit = Math.min(idx, s.length);
  for (let i = 0; i < limit; i++) if (s[i] === '\n') line++;
  return line;
}

// 跳过空白，返回下一个非空白字符索引（或直接返回 idx）
function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  return i;
}

// ---------------------------------------------------------------------------
// 循环枚举（R1 / R3 共用）
// ---------------------------------------------------------------------------

const LOOP_RE = /\b(for|while|do)\b/g;

// 提取单个循环的「体」范围（含表层）。返回 null 表示跳过（如 for await of）。
function getLoopBody(s, kwStart, blocks) {
  const kw = s.substr(kwStart, 3); // for / whi / do?
  let searchFrom = kwStart + (kw === 'for' ? 3 : (kw === 'whi' ? 5 : 2));
  // 先找循环头起始 '('（do 没有头括号，特殊处理）
  let headOpen = -1;
  if (kw === 'do') {
    // do { ... } while(...) —— 体为 do 后第一个 { 块
    let i = skipWs(s, searchFrom);
    if (s[i] === '{') {
      const close = matchBracket(s, i);
      if (close > i) return makeBody(i + 1, close - 1, blocks);
    }
    return null; // 非标准形式，跳过
  }
  // for / while：找 '('
  let i = skipWs(s, searchFrom);
  while (i < s.length && s[i] !== '(') {
    // 处理 for await：for 后空白后紧跟 await 则跳过
    if (kw === 'for' && s[i] === 'a' && s.substr(i, 5) === 'await') return null;
    i++;
  }
  if (s[i] !== '(') return null;
  const headClose = matchBracket(s, i);
  if (headClose < 0) return null;
  // 头后找体
  let b = skipWs(s, headClose + 1);
  if (s[b] === '{') {
    const close = matchBracket(s, b);
    if (close > b) return makeBody(b + 1, close - 1, blocks);
  }
  if (s[b] === ';') return null; // 空循环
  // 单行体：直到行尾或 ';'
  let e = b;
  while (e < s.length && s[e] !== ';' && s[e] !== '\n') e++;
  if (e > b) return makeBody(b, e, blocks);
  return null;
}

function makeBody(bodyStart, bodyEnd, blocks) {
  const inner = innerBlocksIn(blocks, bodyStart, bodyEnd);
  return { bodyStart, bodyEnd, innerBlocks: inner };
}

// 枚举所有循环，返回 [{kw, kwStart, body}]
function enumerateLoops(s) {
  const blocks = braceBlocks(s);
  const loops = [];
  LOOP_RE.lastIndex = 0;
  let m;
  while ((m = LOOP_RE.exec(s)) !== null) {
    const kwStart = m.index;
    const body = getLoopBody(s, kwStart, blocks);
    if (body) loops.push({ kw: m[1], kwStart, body });
  }
  return loops;
}

// 定位 .map() 回调体的扫描范围（保留回调块本身，只排除更深层块与子 map）
function getMapCallbackRange(s, p0, p1, blocks) {
  // 优先找箭头函数 =>
  const arrowRe = /=>/g;
  arrowRe.lastIndex = p0;
  let am;
  let arrowIdx = -1;
  while ((am = arrowRe.exec(s)) !== null) {
    if (am.index > p0 && am.index < p1) { arrowIdx = am.index; break; }
  }
  let cbStart, cbEnd;
  if (arrowIdx >= 0) {
    cbStart = skipWs(s, arrowIdx + 2);
    if (s[cbStart] === '{') {
      const close = matchBracket(s, cbStart);
      if (close <= cbStart) return null;
      cbStart = cbStart + 1;
      cbEnd = close - 1;
    } else {
      cbEnd = p1; // 表达式体，直到 map 调用结束
    }
  } else {
    // function 风格
    const fnRe = /\bfunction\b/g;
    fnRe.lastIndex = p0;
    let fm;
    let fnIdx = -1;
    while ((fm = fnRe.exec(s)) !== null) {
      if (fm.index > p0 && fm.index < p1) { fnIdx = fm.index; break; }
    }
    if (fnIdx < 0) return null;
    let i = skipWs(s, fnIdx + 'function'.length);
    if (s[i] === '(') { const pc = matchBracket(s, i); if (pc > i) i = skipWs(s, pc + 1); }
    if (s[i] !== '{') return null;
    const close = matchBracket(s, i);
    if (close <= i) return null;
    cbStart = i + 1;
    cbEnd = close - 1;
  }
  const inner = innerBlocksIn(blocks, cbStart, cbEnd);
  return { start: cbStart, end: cbEnd, inner };
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

const AWAIT_RE = /\bawait\b/g;
const LOOP_RE2 = /\b(for|while|do)\b/g;

function detectInText(s, file) {
  const issues = [];
  const blocks = braceBlocks(s);
  const loops = enumerateLoops(s);

  // 预收集所有 .map 调用范围（顶层单循环，供 R2 排除内层 map 子调用，避免嵌套循环字面）
  const allMaps = [];
  const allMapRe = /\.map\s*\(/g;
  let am;
  while ((am = allMapRe.exec(s)) !== null) {
    const sp0 = am.index + am[0].length - 1;
    const sp1 = matchBracket(s, sp0);
    allMaps.push({ start: sp0, end: sp1 });
  }

  // R1 循环内串行 await
  for (let li = 0; li < loops.length; li++) {
    const lp = loops[li];
    const b = lp.body;
    const idx = findInSurface(s, AWAIT_RE, b.bodyStart, b.bodyEnd, b.innerBlocks);
    if (idx >= 0) {
      issues.push({
        file, line: lineOf(s, idx), rule: RULES.serialAwait,
        message: '循环体内出现 await（' + lp.kw + ' 循环串行执行，迭代间无依赖时应改用 Promise.all 并行）',
        suggest: 'const results = await Promise.all(items.map(x => worker(x)));'
      });
    }
    // R3 嵌套循环（体表层再出现另一个循环关键字）
    const nIdx = findInSurface(s, LOOP_RE2, b.bodyStart, b.bodyEnd, b.innerBlocks);
    if (nIdx >= 0) {
      issues.push({
        file, line: lineOf(s, nIdx), rule: RULES.nestedLoop,
        message: '循环体内嵌套另一循环（O(n^2) 风险，确认是否可用哈希/集合去重或拆分）',
        suggest: '用 Map/Set 把内层查找从 O(n) 降到 O(1)，或在外层循环外预处理。'
      });
    }
  }

  // R2 .map() 回调内 await（定位回调体范围，保留回调块本身用于扫描）
  const MAP_RE = /\.map\s*\(/g;
  MAP_RE.lastIndex = 0;
  let mm;
  while ((mm = MAP_RE.exec(s)) !== null) {
    const p0 = mm.index + mm[0].length - 1; // '(' 位置
    const p1 = matchBracket(s, p0);
    if (p1 < 0) continue;
    const cb = getMapCallbackRange(s, p0, p1, blocks);
    if (!cb) continue;
    const subMaps = allMaps.filter(m => m.start > cb.start && m.start < cb.end);
    const subBlocked = cb.inner.concat(subMaps);
    const idx = findInSurface(s, AWAIT_RE, cb.start, cb.end, subBlocked);
    if (idx < 0) continue;
    // Promise.all 包裹豁免
    const paPos = s.lastIndexOf('Promise.all', p0);
    if (paPos >= 0) {
      let pi = paPos + 'Promise.all'.length;
      pi = skipWs(s, pi);
      if (s[pi] === '(') {
        const paClose = matchBracket(s, pi);
        if (paClose >= p1) continue; // 真实并行，豁免
      }
    }
    issues.push({
      file, line: lineOf(s, idx), rule: RULES.awaitInMap,
      message: '.map() 回调内出现 await（map 不会自动并行，结果仍串行；应 Promise.all 包裹）',
      suggest: 'const results = await Promise.all(items.map(async x => worker(x)));'
    });
  }

  return issues;
}

function scanFile(full) {
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (_) { return null; }
  const s = stripNoise(text);
  const issues = detectInText(s, full);
  return { issues, lineCount: countLines(text) };
}

function scanRoot(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (_) { continue; }
    entries.forEach(e => {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        return;
      }
      if (!e.isFile()) return;
      const ext = path.extname(e.name).toLowerCase();
      if (!SRC_EXT.has(ext)) return;
      if (fileSize(full) > MAX_FILE_BYTES) return;
      files.push(full);
    });
  }
  return files;
}

function topN(map, n) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([p, c]) => ({ path: p, count: c }));
}

function analyze(root) {
  const files = scanRoot(root);
  const issues = [];
  const byRule = {};
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byFile = {};
  let totalWeighted = 0;
  let srcLines = 0;
  for (const r of Object.values(RULES)) byRule[r.id] = 0;

  for (let i = 0; i < files.length; i++) {
    const res = scanFile(files[i]);
    if (!res) continue;
    srcLines += res.lineCount;
    if (res.issues.length) {
      byFile[files[i]] = (byFile[files[i]] || 0) + res.issues.length;
      res.issues.forEach(it => {
        byRule[it.rule.id]++;
        bySeverity[it.rule.severity]++;
        totalWeighted += it.rule.weight;
        issues.push(it);
      });
    }
  }

  const weightedDensity = srcLines > 0 ? totalWeighted / (srcLines / 1000) : 0;
  const score = computeScore(weightedDensity);
  // 按严重度排序输出，便于阅读
  issues.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    if (sev[a.rule.severity] !== sev[b.rule.severity]) return sev[a.rule.severity] - sev[b.rule.severity];
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return {
    root, files: files.length, srcLines, issueCount: issues.length,
    totalWeighted, byRule, bySeverity, weightedDensity: Number(weightedDensity.toFixed(2)),
    healthScore: score.score, verdict: score.verdict,
    topFiles: topN(byFile, 10), issues
  };
}

// ---------------------------------------------------------------------------
// 健康分
// ---------------------------------------------------------------------------

function computeScore(weightedDensity) {
  const over = Math.max(0, weightedDensity - SCORE_FREE);
  const penalty = Math.min(100, over * SCORE_K);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  let verdict = '健康';
  if (score < 40) verdict = '性能风险高';
  else if (score < 70) verdict = '性能风险偏高';
  else if (score < 90) verdict = '基本健康';
  return { score, verdict };
}

// ---------------------------------------------------------------------------
// 警告 + 门禁
// ---------------------------------------------------------------------------

function buildWarnings(a) {
  const warnings = [];
  if (a.files === 0) warnings.push('no-source: 未扫描到任何 JS/TS 源文件');
  if (a.bySeverity.high > 0) {
    warnings.push('has-high-severity: 存在阻塞级性能反模式 (串行 await / map 内 await) 共 ' + a.bySeverity.high + ' 处');
  }
  return warnings;
}

function applyGate(a, args, warnings) {
  const gate = [];
  if (args.maxHigh !== undefined) {
    if (!Number.isFinite(args.maxHigh)) { console.error('[awaitscan] 错误：--max-high 必须为整数'); return { code: 2, gate: null }; }
    if (a.bySeverity.high > args.maxHigh) gate.push('高危反模式 ' + a.bySeverity.high + ' > --max-high ' + args.maxHigh);
  }
  if (args.maxMedium !== undefined) {
    if (!Number.isFinite(args.maxMedium)) { console.error('[awaitscan] 错误：--max-medium 必须为整数'); return { code: 2, gate: null }; }
    if (a.bySeverity.medium > args.maxMedium) gate.push('中危反模式 ' + a.bySeverity.medium + ' > --max-medium ' + args.maxMedium);
  }
  if (args.maxIssues !== undefined) {
    if (!Number.isFinite(args.maxIssues)) { console.error('[awaitscan] 错误：--max-issues 必须为整数'); return { code: 2, gate: null }; }
    if (a.issueCount > args.maxIssues) gate.push('总问题数 ' + a.issueCount + ' > --max-issues ' + args.maxIssues);
  }
  if (args.failOnHigh && a.bySeverity.high > 0) {
    gate.push('存在 ' + a.bySeverity.high + ' 处高危反模式');
  }
  if (args.failOnIssues && warnings.length > 0) {
    gate.push('存在 ' + warnings.length + ' 条警告');
  }
  return { code: gate.length ? 2 : 0, gate };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'scan') args._.push(a);
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--max-high') args.maxHigh = parseInt(argv[++i], 10);
    else if (a === '--max-medium') args.maxMedium = parseInt(argv[++i], 10);
    else if (a === '--max-issues') args.maxIssues = parseInt(argv[++i], 10);
    else if (a === '--fail-on-high') args.failOnHigh = true;
    else if (a === '--fail-on-issues') args.failOnIssues = true;
    else if (a === '--version' || a === '-V') args.version = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log([
    'awaitscan — 零依赖单文件异步性能反模式静态扫描 CLI',
    '',
    '用法:',
    '  awaitscan [scan] [--root <dir>] [--json] [--max-high <n>] [--max-medium <n>]',
    '                      [--max-issues <n>] [--fail-on-high] [--fail-on-issues]',
    '',
    '  scan    静态扫描（默认）：检测三类高信号异步性能反模式',
    '         R1 serial-await-in-loop  循环内串行 await',
    '         R2 await-in-map          .map 回调内 await（未并行）',
    '         R3 nested-loop           嵌套循环（O(n^2) 风险）',
    '',
    '门禁（非整数阈值直接 exit 2）：',
    '  --max-high <n>    高危反模式(串行await/map内await) 超过则失败',
    '  --max-medium <n>  中危反模式(嵌套循环) 超过则失败',
    '  --max-issues <n>  总问题数超过则失败',
    '  --fail-on-high    出现任何高危反模式即失败',
    '  --fail-on-issues  存在任何警告即失败',
    '',
    '其他：',
    '  --version, -V       打印版本号',
    '  --help, -h          打印本帮助',
    '',
    '健康分：每千行允许加权问题 ' + SCORE_FREE + ' 不扣分，超出按系数 ' + SCORE_K + ' 扣，0-100。'
  ].join('\n'));
}

function printReport(a, warnings, gate) {
  console.log('awaitscan · 异步性能反模式扫描 · root=' + a.root);
  console.log('  扫描源文件   : ' + a.files);
  console.log('  源码总行数   : ' + a.srcLines);
  console.log('  问题总数     : ' + a.issueCount + ' (加权 ' + a.totalWeighted + ')');
  console.log('  严重度分布   : high=' + a.bySeverity.high + ' medium=' + a.bySeverity.medium + ' low=' + a.bySeverity.low);
  const ruleLine = Object.keys(a.byRule).filter(k => a.byRule[k] > 0)
    .map(k => k + '=' + a.byRule[k]).join('  ');
  if (ruleLine) console.log('  规则明细     : ' + ruleLine);
  if (a.issues.length) {
    console.log('  问题清单:');
    for (let i = 0; i < a.issues.length; i++) {
      const it = a.issues[i];
      const rel = path.relative(a.root, it.file) || it.file;
      console.log('    [' + it.rule.severity + '] ' + rel + ':' + it.line + '  ' + it.rule.title);
      console.log('         ' + it.message);
    }
  }
  if (a.topFiles.length) {
    console.log('  问题 Top 文件:');
    for (let i = 0; i < a.topFiles.length; i++) console.log('    - ' + a.topFiles[i].path + ' (' + a.topFiles[i].count + ')');
  }
  console.log('  健康分       : ' + a.healthScore + ' / 100  [' + a.verdict + ']');
  if (a.elapsed !== undefined) console.log('  耗时         : ' + a.elapsed + ' ms');
  if (warnings.length) {
    console.log('  警告:');
    for (let i = 0; i < warnings.length; i++) console.log('    [警告] ' + warnings[i]);
  } else {
    console.log('  警告: 无');
  }
  if (gate) {
    if (gate.length) {
      console.log('  门禁: 失败');
      for (let i = 0; i < gate.length; i++) console.log('    [失败] ' + gate[i]);
    } else {
      console.log('  门禁: 通过');
    }
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.version) {
    const pkg = readJsonSafe(path.join(__dirname, 'package.json'));
    console.log('awaitscan ' + (pkg && pkg.version ? pkg.version : '1.0.0'));
    return 0;
  }

  const root = path.resolve(args.root);
  if (!isDir(root)) {
    console.error('[awaitscan] 错误：root 不是有效目录 -> ' + root);
    return 2;
  }

  const t0 = Date.now();
  const a = analyze(root);
  a.elapsed = Date.now() - t0;
  const warnings = buildWarnings(a);
  const gateRes = applyGate(a, args, warnings);
  if (gateRes.gate === null) return gateRes.code; // 阈值非法已报错

  if (args.json) {
    const report = {
      mode: 'scan', root, files: a.files, srcLines: a.srcLines,
      issueCount: a.issueCount, totalWeighted: a.totalWeighted,
      byRule: a.byRule, bySeverity: a.bySeverity, weightedDensity: a.weightedDensity,
      healthScore: a.healthScore, verdict: a.verdict,
      topFiles: a.topFiles, issues: a.issues, elapsed: a.elapsed, warnings,
      gate: { passed: gateRes.gate.length === 0, failures: gateRes.gate }
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(a, warnings, gateRes.gate);
  }
  return gateRes.code;
}

module.exports = {
  RULES, SRC_EXT, SKIP_DIRS, MAX_FILE_BYTES, SCORE_FREE, SCORE_K,
  readJsonSafe, isDir, isFile, fileSize, countLines,
  stripNoise, matchBracket, braceBlocks, innerBlocksIn, isInside,
  findInSurface, lineOf, skipWs, getLoopBody, makeBody, enumerateLoops,
  detectInText, scanFile, scanRoot, analyze, computeScore,
  buildWarnings, applyGate, parseArgs
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('[awaitscan] 运行异常: ' + (e && e.message));
    process.exit(1);
  }
}

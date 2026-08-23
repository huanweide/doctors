#!/usr/bin/env node
'use strict';

// typodoctor - 零依赖单文件 TypeScript/JavaScript 类型健康体检 CLI
// 检查类型纪律坏味道：explicit-any / any-cast / ts-ignore-comment / double-cast
// 给出 0-100 健康分，可直接挂进 CI 当类型纪律门禁。

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', 'node_modules']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 跳过防 OOM
const MAX_FILES = 20000;
const ALLOWED_PER_KLOC = 6; // 每千行容忍的加权问题数（超出才扣分）

const BT = String.fromCharCode(96); // 反引号，避免源文件出现裸反引号

// 上一个进入 code 的非空白字符集合，用于判定 "/" 是否为正则字面量起点
// 注意：不含 '<' '>' —— '<' 后跟 '/' 在 JS 里是 JSX/比较而非正则，否则 </tag> 的 '/' 会被误判正则
const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '^', '~', '%', '+', '-', '*', '/', ')', ']', '}']);

function isRegexContext(prev) {
  return REGEX_PREV.has(prev);
}

// 逐字符 tokenizer：剥离注释与字符串（保留换行，防止行号错位与误报）
// 返回 { code, comments:[{text,line}] }
function tokenize(src) {
  const code = [];
  const comments = [];
  let i = 0;
  const n = src.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringChar = '';
  let commentBuf = null;
  let commentLine = 1;
  let lineAcc = 1;
  let prevMeaningful = '';

  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    if (inLineComment) {
      commentBuf.push(ch);
      if (ch === '\n') {
        inLineComment = false;
        comments.push({ text: commentBuf.join(''), line: commentLine });
        commentBuf = null;
        code.push('\n');
        lineAcc++;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      commentBuf.push(ch);
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        comments.push({ text: commentBuf.join(''), line: commentLine });
        commentBuf = null;
        code.push(' ');
        i += 2;
        continue;
      }
      if (ch === '\n') lineAcc++;
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') { code.push(' '); i += 2; continue; }
      if (ch === stringChar) {
        inString = false;
        code.push(' ');
        prevMeaningful = stringChar;
        i++;
        continue;
      }
      code.push(ch === '\n' ? '\n' : ' ');
      if (ch === '\n') lineAcc++;
      i++;
      continue;
    }

    // 普通区域
    if (ch === '/' && next === '/') {
      inLineComment = true; commentBuf = []; commentLine = lineAcc; i += 2; continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true; commentBuf = []; commentLine = lineAcc; i += 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === BT) {
      inString = true; stringChar = ch; code.push(' '); i++; continue;
    }
    // 正则字面量：内部引号/括号不触发字符串态，防误报
    if (ch === '/' && next !== '/' && next !== '*' && isRegexContext(prevMeaningful)) {
      code.push('/');
      i++;
      let inCharClass = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { code.push(' '); i += 2; continue; }
        if (c === '[') inCharClass = true;
        else if (c === ']' && inCharClass) inCharClass = false;
        else if (c === '/' && !inCharClass) { code.push('/'); i++; break; }
        else if (c === '\n') { code.push('\n'); lineAcc++; i++; continue; }
        else code.push(' ');
        i++;
      }
      prevMeaningful = '/';
      continue;
    }

    code.push(ch);
    if (ch === '\n') lineAcc++;
    else if (ch !== ' ' && ch !== '\t' && ch !== '\r') prevMeaningful = ch;
    i++;
  }
  if (commentBuf) comments.push({ text: commentBuf.join(''), line: commentLine });
  return { code: code.join(''), comments };
}

function lineOf(code, index) {
  let line = 1;
  const len = Math.min(index, code.length);
  for (let i = 0; i < len; i++) if (code[i] === '\n') line++;
  return line;
}

function snippetLine(src, line) {
  const lines = src.split('\n');
  return (lines[line - 1] || '').trim().slice(0, 120);
}

// 从源码提取 .vue/.svelte 的 <script> 块（避免 template 的 :prop 误判为类型注解）
function extractScript(content) {
  const scripts = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(content)) !== null) scripts.push(m[1]);
  return scripts.join('\n');
}

function scanFile(filePath, content) {
  if (/\.d\.ts$/i.test(filePath)) return null; // 声明文件里 any 是合法的，跳过避免误报
  let src = content;
  const isJsx = /\.(tsx|jsx)$/i.test(filePath);
  if (/\.(vue|svelte)$/i.test(filePath)) {
    src = extractScript(content);
    if (!src.trim()) return null;
  }
  const { code, comments } = tokenize(src);
  const loc = src.split('\n').length;
  const issues = [];

  // T1 explicit-any: 类型注解里的 any（类型系统洞）
  const reColon = /:\s*any\b/g;
  let m;
  while ((m = reColon.exec(code)) !== null) {
    const line = lineOf(code, m.index);
    issues.push({ rule: 'explicit-any', severity: 'medium', line, snippet: snippetLine(src, line) });
  }
  // T1b generic-any: 泛型/类型参数里的 any；JSX 文件里 <any> 是元素不是泛型，跳过避免误报
  if (!isJsx) {
    const reGeneric = /<\s*any\b/g;
    while ((m = reGeneric.exec(code)) !== null) {
      const line = lineOf(code, m.index);
      issues.push({ rule: 'explicit-any', severity: 'medium', line, snippet: snippetLine(src, line) });
    }
  }
  // T2 any-cast: as any 强转（抹掉类型检查）
  const reCast = /\bas\s+(?:readonly\s+)?any\b/g;
  while ((m = reCast.exec(code)) !== null) {
    const line = lineOf(code, m.index);
    issues.push({ rule: 'any-cast', severity: 'high', line, snippet: snippetLine(src, line) });
  }
  // T4 double-cast: as unknown as 双重强转
  const reDouble = /\bas\s+unknown\s+as\b/g;
  while ((m = reDouble.exec(code)) !== null) {
    const line = lineOf(code, m.index);
    issues.push({ rule: 'double-cast', severity: 'medium', line, snippet: snippetLine(src, line) });
  }
  // T3 ts-ignore-comment: 绕过类型检查的指令注释
  const reIgnore = /@ts-(?:ignore|nocheck|expect-error)\b/g;
  for (const c of comments) {
    let cm;
    while ((cm = reIgnore.exec(c.text)) !== null) {
      issues.push({ rule: 'ts-ignore-comment', severity: 'high', line: c.line, snippet: '@ts-' + cm[0].slice(4) });
    }
  }

  let high = 0, medium = 0;
  for (const it of issues) {
    if (it.severity === 'high') high++;
    else if (it.severity === 'medium') medium++;
  }
  const anyCount = issues.filter((x) => x.rule === 'explicit-any' || x.rule === 'any-cast' || x.rule === 'double-cast').length;
  const score = computeScore(high, medium, loc);
  return { file: filePath, loc, issues, high, medium, any: anyCount, score };
}

function computeScore(high, medium, loc) {
  const w = high * 3 + medium * 2;
  // 每千行容忍 6 个问题当量（= 12 加权分），超出部分按加权扣分
  const allowed = ALLOWED_PER_KLOC * 2 * (loc / 1000);
  const excess = Math.max(0, w - allowed);
  return Math.max(0, 100 - excess * 3);
}

function collectFiles(root) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 20 || out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (EXTENSIONS.has(ext)) out.push(full);
        }
      } catch { /* 权限问题跳过 */ }
    }
  }
  walk(root, 0);
  return out;
}

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    json: false,
    failOnHigh: false,
    maxHigh: Infinity,
    maxMedium: Infinity,
    maxAny: Infinity,
    maxIssues: Infinity,
    minScore: -1,
    help: false,
    version: false,
  };
  const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-any', '--max-issues', '--min-score']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--version' || a === '-V') { opts.version = true; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--fail-on-high') { opts.failOnHigh = true; }
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined) throw new Error('missing value for --root');
      opts.root = v;
    } else if (NUM_FLAGS.has(a)) {
      const v = argv[++i];
      const num = Number(v);
      if (v === undefined || !Number.isFinite(num)) throw new Error('missing or invalid number for ' + a);
      const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = num;
    } else if (!a.startsWith('--')) {
      // 位置参数也当作扫描根（与 --root 等价），统一 doctors <sub> <path> 语法
      opts.root = a;
    } else {
      throw new Error('unknown flag: ' + a);
    }
  }
  return opts;
}

function buildReport(opts, results, summary) {
  if (opts.json) {
    return JSON.stringify({
      score: summary.score,
      summary: {
        files: summary.files,
        loc: summary.loc,
        high: summary.high,
        medium: summary.medium,
        any: summary.any,
        issues: summary.issues,
      },
      files: results,
    }, null, 2);
  }
  const lines = [];
  lines.push('typedoctor · 类型健康体检');
  lines.push('扫描 ' + summary.files + ' 个文件，共 ' + summary.loc + ' 行');
  lines.push('');
  if (results.length === 0) {
    lines.push('（未发现类型纪律问题）');
  } else {
    for (const r of results) {
      if (r.issues.length === 0) continue;
      lines.push(r.file + '  (健康分 ' + r.score + ', 高危 ' + r.high + ' / 中危 ' + r.medium + ')');
      for (const it of r.issues) {
        lines.push('  L' + it.line + '  [' + it.severity + ']  ' + it.rule + '   ' + it.snippet);
      }
      lines.push('');
    }
  }
  lines.push('综合健康分: ' + summary.score);
  lines.push('高危: ' + summary.high + '   中危: ' + summary.medium + '   类型漏洞总数: ' + summary.any + '   问题总数: ' + summary.issues);
  return lines.join('\n');
}

function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    return { report: '参数错误: ' + e.message + '\n用法: node typedoctor.js [--root <dir>] [--json] [--fail-on-high] [--max-high N] [--max-medium N] [--max-any N] [--max-issues N] [--min-score N]', exitCode: 2 };
  }
  if (opts.version) return { report: VERSION, exitCode: 0 };
  if (opts.help) {
    return { report: [
      'typodoctor - 零依赖类型健康体检 CLI',
      '',
      '用法: node typedoctor.js [选项]',
      '  --root <dir>          扫描目录（默认当前目录）',
      '  --json                JSON 输出',
      '  --fail-on-high        任意高危即失败 (exit 1)',
      '  --max-high N          高危上限',
      '  --max-medium N        中危上限',
      '  --max-any N           类型漏洞(any)总数上限',
      '  --max-issues N        问题总数上限',
      '  --min-score N         最低健康分',
      '  --version, -V         版本号',
      '  --help, -h            帮助',
    ].join('\n'), exitCode: 0 };
  }

  let rootStat;
  try { rootStat = fs.statSync(opts.root); }
  catch { return { report: '路径不存在: ' + opts.root, exitCode: 2 }; }
  if (!rootStat.isDirectory()) return { report: '不是目录: ' + opts.root, exitCode: 2 };

  const files = collectFiles(opts.root);
  const results = [];
  for (const f of files) {
    let content, st;
    try {
      st = fs.statSync(f);
      if (st.size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    const r = scanFile(f, content);
    if (r) results.push(r);
  }

  let totalHigh = 0, totalMedium = 0, totalAny = 0, totalIssues = 0, totalLoc = 0;
  for (const r of results) {
    totalHigh += r.high;
    totalMedium += r.medium;
    totalAny += r.any;
    totalIssues += r.issues.length;
    totalLoc += r.loc;
  }
  const score = computeScore(totalHigh, totalMedium, totalLoc);
  const summary = { files: results.length, loc: totalLoc, high: totalHigh, medium: totalMedium, any: totalAny, issues: totalIssues, score };

  let failed = false;
  if (opts.failOnHigh && totalHigh > 0) failed = true;
  if (totalHigh > opts.maxHigh) failed = true;
  if (totalMedium > opts.maxMedium) failed = true;
  if (totalAny > opts.maxAny) failed = true;
  if (totalIssues > opts.maxIssues) failed = true;
  if (opts.minScore >= 0 && score < opts.minScore) failed = true;

  const base = buildReport(opts, results, summary);
  const report = opts.json ? base : base + (failed ? '\n\n门禁: 失败 (exit 1)' : '\n\n门禁: 通过');
  const exitCode = failed ? 1 : 0;
  return { report, exitCode, summary };
}

function main() {
  const { report, exitCode } = run(process.argv.slice(2));
  console.log(report);
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { tokenize, scanFile, computeScore, parseArgs, collectFiles, run, extractScript, VERSION };

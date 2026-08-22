#!/usr/bin/env node
'use strict';

// docdoctor · Markdown 文档健康体检（零依赖单文件 CLI）
// 检测维度：D1 死链接/锚点 · D2 超大文档 · D3 标题跳级 · D4 锚点冲突
//           D5 图片缺 alt · D6 裸 URL · D7 参考链接定义缺失
// 组合健康分 + --json + CI 门禁（--fail-on-high / --max-issues / --max-high / --max-lines）

const fs = require('fs');
const path = require('path');

// ---------- 常量 ----------
const VERSION = '1.0.0';
const DEFAULT_MAX_BYTES = 256 * 1024; // 单文件字节上限（防 OOM）
const WEIGHT = { high: 3, medium: 2, low: 1 };
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build',
  'coverage', 'vendor', '.next', '.cache'
]);

// GitHub 风格标题 slug：小写、去标点、空白转连字符（保留中文等字母数字）
function slugify(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function truncate(s, n = 60) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function die(msg) {
  process.stderr.write('docdoctor: ' + msg + '\n');
  process.exit(2);
}

// ---------- 单文件扫描 ----------
function scanFile(absPath, maxLines) {
  const issues = [];
  let content;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > DEFAULT_MAX_BYTES) {
      issues.push({
        rule: 'D2', severity: 'low', line: 0,
        message: `文件过大 (${(stat.size / 1024).toFixed(0)}KB > ${(DEFAULT_MAX_BYTES / 1024).toFixed(0)}KB)，跳过内容扫描`
      });
      return { headings: [], issues, skipped: true, bytes: stat.size };
    }
    content = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    issues.push({ rule: 'ERR', severity: 'high', line: 0, message: `读取失败: ${e.message}` });
    return { headings: [], issues, bytes: 0 };
  }

  const lines = content.split('\n');
  const headings = [];      // {level, text, slug, line}
  const slugCounts = new Map();
  const refDefs = new Set();
  const refUses = [];       // {label, line}
  let fenced = false, fencedMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    // fenced code 围栏切换
    const fenceMatch = rawLine.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!fenced) { fenced = true; fencedMarker = marker; continue; }
      else if (marker === fencedMarker) { fenced = false; fencedMarker = ''; continue; }
    }
    if (fenced) continue; // 围栏内整行跳过

    // 行内代码豁免：构建 masked 行
    const inlineCodeRanges = []; // 行内代码区间（用于链接/图片/参考链接豁免）
    let mc;
    const inlineRe = /`[^`]+`/g; // + 而非 *：避免相邻反引号被当成空代码跨度
    while ((mc = inlineRe.exec(rawLine)) !== null) {
      inlineCodeRanges.push([mc.index, mc.index + mc[0].length]);
    }
    const consumed = inlineCodeRanges.slice(); // 链接/图片 url 后续追加到此
    const masked = rawLine.replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));
    const inCode = (s, e) => inlineCodeRanges.some(([a, b]) => s < b && e > a);

    // 标题
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const slug = slugify(text);
      headings.push({ level, text, slug, line: lineNo });
      slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
    }

    // 参考定义 [label]: url
    const defMatch = rawLine.match(/^\[([^\]]+)\]:\s*(\S+)/);
    if (defMatch) {
      refDefs.add(defMatch[1].trim().toLowerCase());
    }

    // 图片 ![alt](url)
    const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let im;
    while ((im = imgRe.exec(rawLine)) !== null) {
      if (inCode(im.index, im.index + im[0].length)) continue;
      const alt = im[1];
      const url = im[2].trim();
      if (alt.trim() === '') {
        issues.push({ rule: 'D5', severity: 'medium', line: lineNo,
          message: `图片缺少替代文本(alt)：![](${truncate(url)})` });
      }
      checkLocalLink(url, absPath, lineNo, headings, issues, 'image');
      const urlStart = im.index + im[0].indexOf(url);
      consumed.push([urlStart, urlStart + url.length]);
    }

    // 链接 [text](url)（排除图片）
    const linkRe = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
    let lm;
    while ((lm = linkRe.exec(rawLine)) !== null) {
      if (inCode(lm.index, lm.index + lm[0].length)) continue;
      const url = lm[2].trim();
      checkLocalLink(url, absPath, lineNo, headings, issues, 'link');
      const urlStart = lm.index + lm[0].indexOf(url);
      consumed.push([urlStart, urlStart + url.length]);
    }

    // 参考链接 [text][ref] / [text][]
    const refUseRe = /\[([^\]]+)\]\[([^\]]*)\]/g;
    let rm;
    while ((rm = refUseRe.exec(rawLine)) !== null) {
      if (inCode(rm.index, rm.index + rm[0].length)) continue;
      const label = (rm[2] || rm[1]).trim().toLowerCase();
      refUses.push({ label, line: lineNo });
    }

    // 裸 URL（masked 行，跳过已消费区间）
    const bareRe = /https?:\/\/[^\s)]+/g;
    let bm;
    while ((bm = bareRe.exec(masked)) !== null) {
      const s = bm.index, e = s + bm[0].length;
      let inside = false;
      for (const [rs, re] of consumed) {
        if (s >= rs && e <= re) { inside = true; break; }
      }
      if (inside) continue;
      issues.push({ rule: 'D6', severity: 'low', line: lineNo,
        message: `裸 URL（未用 Markdown 链接包裹）：${truncate(bm[0])}` });
    }
  }

  // 标题跳级
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1], cur = headings[i];
    if (cur.level - prev.level > 1) {
      issues.push({ rule: 'D3', severity: 'low', line: cur.line,
        message: `标题层级跳级：从 H${prev.level} 直接到 H${cur.level}（"${truncate(cur.text, 30)}"）` });
    }
  }

  // 锚点 slug 冲突
  for (const [slug, count] of slugCounts) {
    if (count > 1) {
      issues.push({ rule: 'D4', severity: 'low', line: 0,
        message: `同文档存在 ${count} 个相同锚点 slug："${slug}"，GitHub 锚点会冲突` });
    }
  }

  // 参考链接定义缺失
  for (const use of refUses) {
    if (!refDefs.has(use.label)) {
      issues.push({ rule: 'D7', severity: 'medium', line: use.line,
        message: `参考链接 [${use.label}] 缺少对应的 [${use.label}]: 定义` });
    }
  }

  // 超大文档（行数）
  if (lines.length > maxLines) {
    issues.push({ rule: 'D2', severity: 'medium', line: 0,
      message: `文档过长（${lines.length} 行 > ${maxLines} 行），建议拆分` });
  }

  return { headings, issues, bytes: content.length };
}

// 检查本地相对链接 / 锚点
function checkLocalLink(url, absPath, lineNo, headings, issues, kind) {
  if (/^(https?:|mailto:|tel:)/i.test(url)) return;
  if (url.startsWith('//')) return;
  if (url.startsWith('/')) return; // 绝对路径交由站点处理

  const hashIdx = url.indexOf('#');
  let filePath = url, anchor = '';
  if (hashIdx !== -1) {
    filePath = url.slice(0, hashIdx);
    anchor = url.slice(hashIdx + 1);
  }
  const qIdx = filePath.indexOf('?');
  if (qIdx !== -1) filePath = filePath.slice(0, qIdx);

  const dir = path.dirname(absPath);

  if (filePath === '') {
    if (anchor && !headings.some(h => h.slug === slugify(anchor))) {
      issues.push({ rule: 'D1', severity: 'medium', line: lineNo,
        message: `锚点 "#${anchor}" 在本文件无匹配标题` });
    }
    return;
  }

  let target;
  try { target = path.resolve(dir, decodeURIComponent(filePath)); }
  catch { target = path.resolve(dir, filePath); }

  let exists = false;
  try { exists = fs.existsSync(target) && fs.statSync(target).isFile(); } catch {}
  if (!exists) {
    issues.push({ rule: 'D1', severity: 'high', line: lineNo,
      message: `${kind === 'image' ? '图片' : '链接'}指向不存在的本地文件：${truncate(url)}` });
    return;
  }
  if (anchor) {
    let targetHeadings = headings;
    if (path.resolve(target) !== path.resolve(absPath)) {
      targetHeadings = collectHeadings(target);
    }
    if (!targetHeadings.some(h => h.slug === slugify(anchor))) {
      issues.push({ rule: 'D1', severity: 'medium', line: lineNo,
        message: `锚点 "#${anchor}" 在 ${truncate(filePath)} 中无匹配标题` });
    }
  }
}

function collectHeadings(absPath) {
  let content;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > DEFAULT_MAX_BYTES) return [];
    content = fs.readFileSync(absPath, 'utf8');
  } catch { return []; }
  const headings = [];
  let fenced = false, marker = '';
  for (const rawLine of content.split('\n')) {
    const fm = rawLine.match(/^(\s*)(`{3,}|~{3,})/);
    if (fm) {
      const m = fm[2][0];
      if (!fenced) { fenced = true; marker = m; continue; }
      else if (m === marker) { fenced = false; marker = ''; continue; }
    }
    if (fenced) continue;
    const hm = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (hm) headings.push({ slug: slugify(hm[2].trim()) });
  }
  return headings;
}

// ---------- 文件遍历 ----------
function collectMdFiles(root) {
  const out = [];
  function walk(p) {
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// ---------- 健康分 ----------
function fileScore(issues) {
  const w = issues.reduce((a, x) => a + (WEIGHT[x.severity] || 0), 0);
  const allowance = 2; // 每文件允许少量低危不扣分
  const penalty = Math.max(0, w - allowance) * 8;
  return Math.max(0, 100 - penalty);
}

function repoScore(files) {
  if (files.length === 0) return 100;
  const sum = files.reduce((a, f) => a + f.score, 0);
  return Math.round(sum / files.length);
}

// ---------- 参数解析（三类：数值/路径/布尔） ----------
function parseArgs(argv) {
  const STR_FLAGS = { '--root': true, '-r': true };
  const NUM_FLAGS = { '--max-issues': true, '--max-high': true, '--max-lines': true };
  const BOOL_FLAGS = {
    '--json': true, '--fail-on-high': true, '--quiet': true, '-q': true,
    '--version': true, '-V': true, '--help': true, '-h': true
  };
  const opts = {
    paths: [], root: null, json: false, failOnHigh: false, quiet: false,
    maxIssues: Infinity, maxHigh: Infinity, maxLines: 1500,
    version: false, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (STR_FLAGS[a]) {
      const v = argv[++i];
      if (v === undefined) die('选项缺少参数: ' + a);
      opts.root = v;
    } else if (NUM_FLAGS[a]) {
      const v = argv[++i];
      if (v === undefined || !Number.isFinite(parseInt(v, 10))) {
        die(`选项 ${a} 需要整数参数`);
      }
      const n = parseInt(v, 10);
      if (a === '--max-issues') opts.maxIssues = n;
      else if (a === '--max-high') opts.maxHigh = n;
      else if (a === '--max-lines') opts.maxLines = n;
    } else if (BOOL_FLAGS[a]) {
      if (a === '--json') opts.json = true;
      else if (a === '--fail-on-high') opts.failOnHigh = true;
      else if (a === '--quiet' || a === '-q') opts.quiet = true;
      else if (a === '--version' || a === '-V') opts.version = true;
      else if (a === '--help' || a === '-h') opts.help = true;
    } else if (a.startsWith('-') && a !== '-') {
      die('未知选项: ' + a);
    } else {
      opts.paths.push(a);
    }
  }
  return opts;
}

// ---------- 报告 ----------
function printText(files, root, summary) {
  const rel = (f) => path.relative(root, f) || path.basename(f);
  for (const f of files) {
    if (f.results.issues.length === 0) continue;
    const tag = f.results.skipped ? '⏭ ' : (f.score >= 90 ? '✓ ' : '✗ ');
    process.stdout.write(`${tag}${rel(f.path)} (健康分 ${f.score})\n`);
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...f.results.issues].sort((a, b) =>
      (order[a.severity] - order[b.severity]) || (a.line - b.line));
    for (const it of sorted) {
      const sev = it.severity === 'high' ? 'HIGH' : it.severity === 'medium' ? 'MED ' : 'LOW ';
      const loc = it.line > 0 ? `L${it.line} ` : '     ';
      process.stdout.write(`  ${loc}[${sev}] ${it.rule} ${it.message}\n`);
    }
  }
  process.stdout.write('\n');
  process.stdout.write(`汇总：${summary.fileCount} 文件 · ${summary.high} 高危 · ${summary.medium} 中危 · ${summary.low} 低危 · 健康分 ${summary.score}\n`);
}

function printJson(files, root, summary) {
  const out = {
    version: VERSION,
    summary,
    files: files.map(f => ({
      path: path.relative(root, f.path) || path.basename(f.path),
      score: f.score,
      skipped: !!f.results.skipped,
      issues: f.results.issues
    }))
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function showHelp() {
  process.stdout.write(`docdoctor · Markdown 文档健康体检 v${VERSION}

用法：
  docdoctor [路径...] [选项]
  路径可为 .md 文件或目录（默认当前目录，递归扫描）

选项：
  -r, --root <dir>       报告中的相对路径基准（默认首个路径或 cwd）
  --json                 输出机器可读 JSON
  --max-lines <n>        超大文档行数阈值（默认 1500）
  --max-issues <n>       问题总数上限，超过则 CI 失败
  --max-high <n>         高危问题上限，超过则 CI 失败
  --fail-on-high         CA 只要存在高危问题即失败退出码 2
  -q, --quiet            全绿时静默（仅错误到 stderr）
  -V, --version          显示版本
  -h, --help             显示帮助

检测维度：
  D1 死链接/锚点   D2 超大文档   D3 标题跳级   D4 锚点冲突
  D5 图片缺 alt   D6 裸 URL     D7 参考链接定义缺失

退出码：0 健康 · 1 存在高危文档问题 · 2 门禁越界/用法错误
`);
}

// ---------- 主入口 ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { showHelp(); process.exit(0); }
  if (opts.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }

  const roots = opts.paths.length > 0 ? opts.paths : [process.cwd()];
  const root = opts.root || (path.isAbsolute(roots[0]) ? roots[0] : path.resolve(roots[0]));

  const fileSet = new Set();
  for (const r of roots) {
    const abs = path.resolve(r);
    let st;
    try { st = fs.statSync(abs); } catch { die(`路径不存在: ${r}`); }
    if (st.isDirectory()) {
      for (const f of collectMdFiles(abs)) fileSet.add(f);
    } else if (st.isFile()) {
      fileSet.add(abs);
    }
  }

  const files = [];
  for (const fp of [...fileSet].sort()) {
    const results = scanFile(fp, opts.maxLines);
    files.push({ path: fp, results, score: fileScore(results.issues) });
  }

  let high = 0, medium = 0, low = 0, issueCount = 0;
  for (const f of files) {
    for (const it of f.results.issues) {
      issueCount++;
      if (it.severity === 'high') high++;
      else if (it.severity === 'medium') medium++;
      else low++;
    }
  }
  const score = repoScore(files);
  const summary = { fileCount: files.length, high, medium, low, issueCount, score };

  if (!opts.quiet || issueCount > 0) {
    if (opts.json) printJson(files, root, summary);
    else printText(files, root, summary);
  }

  // 门禁
  let exitCode = 0;
  if (high > 0) exitCode = 1;                       // 存在高危文档问题
  if (opts.failOnHigh && high > 0) exitCode = 2;
  if (issueCount > opts.maxIssues) exitCode = 2;
  if (high > opts.maxHigh) exitCode = 2;
  process.exit(exitCode);
}

module.exports = { slugify, scanFile, fileScore, repoScore, parseArgs, collectMdFiles, checkLocalLink };

if (require.main === module) {
  main();
}

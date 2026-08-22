#!/usr/bin/env node
'use strict';

// commitdoctor — 零依赖单文件 git 提交消息体检 CLI
// 扫描仓库最近 N 条提交消息的规范坏味道，给 0-100 健康分 + CI 门禁。
// 与 repodoctor（仓库卫生：危险文件/大文件/LICENSE/无意义提交占比）互补：
//   repodoctor 看"仓库工程卫生"，commitdoctor 看"提交消息格式规范"。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0.0';

// 严重度权重（用于健康分扣分）
const WEIGHT = { high: 3, medium: 2, low: 1 };

// 标准 Conventional Commits 类型（仅用于"非标准类型前缀"提示）
const CC_TYPES = new Set([
  'feat', 'fix', 'chore', 'docs', 'style', 'refactor',
  'test', 'perf', 'build', 'ci', 'revert',
]);

// 规则清单（id -> 元信息），供 --json 与 README 引用
const RULES = {
  'empty-subject':         { severity: 'high',   desc: '提交主题行为空' },
  'subject-too-long':      { severity: 'high',   desc: '主题行超过 100 字符（硬上限）' },
  'subject-long':          { severity: 'medium', desc: '主题行超过推荐长度（默认 72）' },
  'subject-trailing-period': { severity: 'low',  desc: '主题行以句号等标点结尾' },
  'subject-leading-space': { severity: 'low',    desc: '主题行前导空格' },
  'subject-trailing-space':{ severity: 'low',    desc: '主题行尾部空格' },
  'has-todo-marker':       { severity: 'medium', desc: '消息含未完成标记 TODO/FIXME/HACK/WIP' },
  'has-secret':            { severity: 'high',   desc: '消息疑似泄露密钥/凭据' },
  'merge-no-desc':         { severity: 'low',    desc: '合并提交无说明' },
  'no-body-separator':     { severity: 'low',    desc: '正文与主题间缺少空行分隔' },
  'draft-markers':         { severity: 'low',    desc: '消息含草稿标记 TMP/DEBUG/temp/asdf' },
  'subject-emoji':         { severity: 'low',    desc: '主题含 emoji 噪音' },
  'non-standard-type':     { severity: 'low',    desc: '疑似类型前缀但格式/大小写不符规范' },
};

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/u;
const SECRET_RE = /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key|auth[_-]?token)[\s:=]+[^\s"']{8,})/i;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/;
const TODO_RE = /\b(?:TODO|FIXME|HACK|WIP)\b/;
const DRAFT_RE = /\b(?:TMP|DEBUG|temp|asdf|test123)\b/;
const CC_PREFIX_RE = /^([a-zA-Z]+)(\([^)]*\))?!?:\s/;

function stripAnsi(s) { return s.replace(/\u001b\[[0-9;]*m/g, ''); }

function parseArgs(argv) {
  const NUM_FLAGS = new Set(['-n', '--max-commits', '--max-subject-len', '--max-high', '--max-medium', '--max-issues', '--min-score']);
  const BOOL_FLAGS = new Set(['--ignore-merges', '--json', '-V', '--version', '--fail-on-high', '--help', '-h']);
  const STR_FLAGS = new Set(['-p', '--path', '--since']);
  const opts = {
    path: process.cwd(), maxCommits: 50, maxSubjectLen: 72,
    ignoreMerges: false, json: false, checkEmoji: true,
    maxHigh: Infinity, maxMedium: Infinity, maxIssues: Infinity, minScore: 0,
    since: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-V' || a === '--version') { console.log(VERSION); process.exit(0); }
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    if (a === '--no-check-emoji') { opts.checkEmoji = false; continue; }
    if (NUM_FLAGS.has(a)) {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) { console.error(`错误：标志 ${a} 需要整数参数`); process.exit(2); }
      if (a === '-n' || a === '--max-commits') opts.maxCommits = v;
      else if (a === '--max-subject-len') opts.maxSubjectLen = v;
      else if (a === '--max-high') opts.maxHigh = v;
      else if (a === '--max-medium') opts.maxMedium = v;
      else if (a === '--max-issues') opts.maxIssues = v;
      else if (a === '--min-score') opts.minScore = v;
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--ignore-merges') opts.ignoreMerges = true;
      else if (a === '--json') opts.json = true;
      else if (a === '--fail-on-high') opts.failOnHigh = true;
    } else if (STR_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) { console.error(`错误：标志 ${a} 需要字符串参数`); process.exit(2); }
      if (a === '-p' || a === '--path') opts.path = v;
      else if (a === '--since') opts.since = v;
    } else if (a.startsWith('--max-subject-len=')) {
      const v = Number(a.split('=')[1]);
      if (!Number.isFinite(v)) { console.error('错误：--max-subject-len 需要整数'); process.exit(2); }
      opts.maxSubjectLen = v;
    } else if (a.startsWith('--')) {
      console.error(`未知标志：${a}`); process.exit(2);
    } else {
      // 位置参数视为 --path
      opts.path = a;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`commitdoctor v${VERSION} — 零依赖 git 提交消息体检 CLI

用法：node index.js [选项]

选项：
  -p, --path <dir>          目标 git 仓库（默认当前目录）
  -n, --max-commits <n>     扫描最近 n 条提交（默认 50）
      --since <spec>        仅扫描此日期之后的提交（传给 git --since，如 "2.weeks"）
      --max-subject-len <n> 主题行推荐长度上限（默认 72，超过即 medium，超过 100 即 high）
      --ignore-merges       跳过合并提交
      --check-emoji         检测主题行 emoji 噪音（默认开；用 --no-check-emoji 关闭）
      --json                输出机器可读 JSON
  CI 门禁：
      --fail-on-high        存在任何 high 问题即失败（exit 1）
      --max-high <n>        high 数超过 n 即失败
      --max-medium <n>      medium 数超过 n 即失败
      --max-issues <n>      问题总数超过 n 即失败
      --min-score <s>       健康分低于 s 即失败（0-100）
  -V, --version             打印版本
  -h, --help                打印帮助`);
}

// 读取 git 日志，返回提交对象数组
function readCommits(opts) {
  // 用 %B 取完整消息（含主题与正文间空行），避免 %s+%b 分离丢失空行导致 no-body-separator 误报
  // 用 tformat: 而非 format:，避免 git 在每条记录后额外追加换行污染下一条记录的 hash 字段
  const args = ['-C', opts.path, 'log', '--pretty=tformat:%h%x1f%an%x1f%at%x1f%B%x1e'];
  if (opts.ignoreMerges) args.push('--no-merges');
  if (opts.since) args.push('--since=' + opts.since);
  args.push('-n', String(opts.maxCommits));
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    console.error(`无法执行 git（${opts.path}）：${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`git log 失败（${opts.path}）：不是 git 仓库或参数无效`);
    process.exit(1);
  }
  const out = stripAnsi(res.stdout || '');
  // git log 在每条记录后会插入换行作为记录分隔，\x1e 后紧跟的 \n 会污染下一条记录开头，需同时去掉首尾换行
  const records = out.split('\x1e').map(r => r.replace(/^\n+/, '').replace(/\n+$/, '')).filter(Boolean);
  const commits = [];
  for (const rec of records) {
    const parts = rec.split('\x1f');
    if (parts.length < 4) continue;
    const hash = parts[0];
    const author = parts[1];
    const at = parts[2];
    const fullMsg = parts[3] || '';
    const nl = fullMsg.indexOf('\n');
    let subject, rest;
    if (nl === -1) { subject = fullMsg; rest = ''; }
    else { subject = fullMsg.slice(0, nl); rest = fullMsg.slice(nl + 1); }
    const body = rest.replace(/^\n+/, '').replace(/\n+$/, '');
    commits.push({ hash, author, at, subject, body, raw: fullMsg });
  }
  return commits;
}

// 对单条提交跑规则，返回问题数组
function lintCommit(c, opts) {
  const issues = [];
  const subject = c.subject;
  const full = c.subject + '\n' + c.body;
  const isMerge = /^Merge\s/.test(subject) || /Merge (?:branch|remote|pull request|tag)/.test(subject);

  if (subject.trim() === '') {
    issues.push({ rule: 'empty-subject', severity: 'high', excerpt: '(空主题)' });
  } else {
    const len = [...subject.trim()].length;
    if (len > 100) issues.push({ rule: 'subject-too-long', severity: 'high', excerpt: `长度 ${len}` });
    else if (len > opts.maxSubjectLen) issues.push({ rule: 'subject-long', severity: 'medium', excerpt: `长度 ${len} > ${opts.maxSubjectLen}` });
    if (/[\.!?。！？]\s*$/.test(subject.trim())) issues.push({ rule: 'subject-trailing-period', severity: 'low', excerpt: subject.trim().slice(-12) });
    if (/^\s/.test(subject)) issues.push({ rule: 'subject-leading-space', severity: 'low', excerpt: JSON.stringify(subject.slice(0, 8)) });
    if (/\s$/.test(subject)) issues.push({ rule: 'subject-trailing-space', severity: 'low', excerpt: '(尾部空格)' });

    // 非标准类型前缀提示（仅当明显像 type: 形式但不符合规范）
    const m = CC_PREFIX_RE.exec(subject.trim());
    if (m) {
      const t = m[1].toLowerCase();
      if (!CC_TYPES.has(t) || m[1] !== t) {
        issues.push({ rule: 'non-standard-type', severity: 'low', excerpt: m[1] + ':' });
      }
    }
    if (opts.checkEmoji && EMOJI_RE.test(subject)) {
      issues.push({ rule: 'subject-emoji', severity: 'low', excerpt: '(含 emoji)' });
    }
  }

  if (TODO_RE.test(full)) issues.push({ rule: 'has-todo-marker', severity: 'medium', excerpt: (full.match(TODO_RE) || [''])[0] });
  if (SECRET_RE.test(full) || PRIVATE_KEY_RE.test(full)) issues.push({ rule: 'has-secret', severity: 'high', excerpt: '(疑似密钥/凭据)' });
  if (DRAFT_RE.test(full)) issues.push({ rule: 'draft-markers', severity: 'low', excerpt: (full.match(DRAFT_RE) || [''])[0] });

  if (!opts.ignoreMerges && isMerge && c.body.trim() === '') {
    issues.push({ rule: 'merge-no-desc', severity: 'low', excerpt: '(合并提交无说明)' });
  }

  // 正文与主题间缺空行分隔
  if (c.body.trim() !== '') {
    const lines = c.raw.split('\n');
    if (lines.length >= 2 && lines[1].trim() !== '') {
      issues.push({ rule: 'no-body-separator', severity: 'low', excerpt: '(主题后无空行)' });
    }
  }

  for (const it of issues) it.hash = c.hash;
  return issues;
}

function computeScore(allIssues) {
  let deduction = 0;
  for (const it of allIssues) deduction += WEIGHT[it.severity] || 0;
  return Math.max(0, 100 - deduction);
}

function runGate(opts, score, counts) {
  const violations = [];
  if (opts.failOnHigh && counts.high > 0) violations.push(`存在 ${counts.high} 个 high 问题`);
  if (counts.high > opts.maxHigh) violations.push(`high 问题 ${counts.high} > ${opts.maxHigh}`);
  if (counts.medium > opts.maxMedium) violations.push(`medium 问题 ${counts.medium} > ${opts.maxMedium}`);
  if (allIssueCount(counts) > opts.maxIssues) violations.push(`问题总数 ${allIssueCount(counts)} > ${opts.maxIssues}`);
  if (score < opts.minScore) violations.push(`健康分 ${score} < ${opts.minScore}`);
  return violations;
}

function allIssueCount(counts) { return counts.high + counts.medium + counts.low; }

function printReport(commits, allIssues, score, counts, opts) {
  console.log('\n=== commitdoctor 提交消息体检 ===');
  console.log(`仓库：${opts.path}`);
  console.log(`扫描提交：${commits.length} 条`);
  if (allIssues.length === 0) {
    console.log('未发现问题。提交消息整洁。');
  } else {
    const byHash = new Map();
    for (const it of allIssues) {
      if (!byHash.has(it.hash)) byHash.set(it.hash, []);
      byHash.get(it.hash).push(it);
    }
    for (const c of commits) {
      const list = byHash.get(c.hash);
      if (!list) continue;
      console.log(`\n[${c.hash}] ${c.subject.trim().slice(0, 60) || '(空主题)'}`);
      for (const it of list) {
        const sv = it.severity.toUpperCase();
        console.log(`  - [${sv}] ${it.rule}: ${it.excerpt}`);
      }
    }
  }
  console.log('\n--- 汇总 ---');
  console.log(`  high: ${counts.high}  medium: ${counts.medium}  low: ${counts.low}`);
  console.log(`  健康分：${score} / 100`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const commits = readCommits(opts);
  let allIssues = [];
  for (const c of commits) allIssues = allIssues.concat(lintCommit(c, opts));

  const counts = { high: 0, medium: 0, low: 0 };
  for (const it of allIssues) counts[it.severity]++;

  const score = computeScore(allIssues);

  if (opts.json) {
    const out = {
      score, counts, commits: commits.length,
      issues: allIssues.map(it => ({ hash: it.hash, rule: it.rule, severity: it.severity, excerpt: it.excerpt })),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    printReport(commits, allIssues, score, counts, opts);
  }

  const violations = runGate(opts, score, counts);
  if (violations.length > 0) {
    console.log('\n[CI 门禁失败] ' + violations.join('；'));
    process.exit(1);
  }
  process.exit(0);
}

module.exports = { parseArgs, lintCommit, computeScore, readCommits, RULES, VERSION };
if (require.main === module) main();

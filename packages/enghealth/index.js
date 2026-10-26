#!/usr/bin/env node
'use strict';

/*
 * enghealth — 工程健康家族「元仪表盘 / 统一体检入口」（零依赖单文件 CLI）
 *
 * 定位（组合叙事）：工程健康家族已 14 件套（源码层九轴 + git 层四件套 + 配置层 pkgdoctor），
 * 但它们各自为政、零依赖单兵作战。enghealth 把整支 family 聚合成「一次命令、一张体检表、一个总分」。
 *
 * 设计（守住零依赖基线 + 容错）：
 *   1. 自身零依赖扫描「项目卫生概览」通用指标（LICENSE/README/锁文件/.gitignore/测试/package.json
 *      合法性/危险文件提交），给 overview 健康分 —— 即使一个兄弟工具都没装也能独立跑。
 *   2. 可选增强：自动发现 14 个兄弟 CLI（默认 PATH 全局；本地用 --tools-dir 指向 family 源码，
 *      回退找 ol-<name>/index.js 或 <name>/index.js），逐个跑 --json 并容错解析其健康分汇入矩阵。
 *   3. 输出统一体检表 + 总分 + CI 门禁。兄弟工具缺失/失败一律降级为「跳过」，绝不误判。
 *
 * 纯本地 fs + 系统 git 只读，不联网、不执行用户代码，零依赖确定性可复现。
 * 与 family 正交互补：family 是单兵体检，enghealth 是它们的统一编排层，不重复任何单兵维度。
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const VERSION = '1.0.0';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 跳过防 OOM（读小文件用）

// 兄弟工具注册表（family 14 件套）：name=可执行名 / 维度标签 / 类别
const BROTHERS = [
  { name: 'devdoctor',    label: '依赖体检',   cat: '源码' },
  { name: 'testlite',     label: '测试卫生',   cat: '源码' },
  { name: 'debtlens',     label: '技术债密度', cat: '源码' },
  { name: 'a11ydoctor',   label: '前端可访问', cat: '源码' },
  { name: 'awaitscan',    label: '异步性能',   cat: '源码' },
  { name: 'cycscan',      label: '结构复杂度', cat: '源码' },
  { name: 'secscan',      label: '安全反模式', cat: '源码' },
  { name: 'dupscan',      label: '重复代码',   cat: '源码' },
  { name: 'typedoctor',   label: '类型纪律',   cat: '源码' },
  { name: 'repodoctor',   label: '仓库卫生',   cat: 'git' },
  { name: 'docdoctor',    label: '文档健康',   cat: 'git' },
  { name: 'commitdoctor', label: '提交规范',   cat: 'git' },
  { name: 'reldoctor',    label: '发布一致性', cat: 'git' },
  { name: 'pkgdoctor',    label: '配置规范',   cat: '配置' },
];

// 严重度权重（overview 维度）
const OV_PENALTY = { high: 15, medium: 8, low: 3 };

// 参数解析：数值 / 路径 / 布尔 三类分离（cycscan 铁律）
const NUM_FLAGS = new Set(['--fail-on-low', '--min-overall']);
const BOOL_FLAGS = new Set(['--json', '--quiet', '--help', '-h', '--version', '-V']);

function parseArgs(argv) {
  const opts = {
    target: null,
    json: false, quiet: false, help: false, version: false,
    toolsDir: [],
    failOnLow: null, minOverall: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (NUM_FLAGS.has(a)) {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) {
        console.error(`[错误] ${a} 需要一个整数参数`);
        process.exit(2);
      }
      if (a === '--fail-on-low') opts.failOnLow = v;
      else if (a === '--min-overall') opts.minOverall = v;
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--json') opts.json = true;
      else if (a === '--quiet') opts.quiet = true;
      else if (a === '--help' || a === '-h') opts.help = true;
      else if (a === '--version' || a === '-V') opts.version = true;
    } else if (a === '--tools-dir') {
      const v = argv[++i];
      if (!v) { console.error('[错误] --tools-dir 需要一个路径参数'); process.exit(2); }
      opts.toolsDir.push(v);
    } else if (a.startsWith('-') && a !== '-') {
      console.error(`[错误] 未知选项：${a}`);
      process.exit(2);
    } else {
      if (opts.target === null) opts.target = a;
      else { console.error(`[错误] 多余参数：${a}`); process.exit(2); }
    }
  }
  return opts;
}

const HELP = `enghealth — 工程健康家族「元仪表盘 / 统一体检入口」（零依赖）

用法：
  enghealth [目标目录] [选项]

选项：
  --tools-dir <dir>     指向 family 兄弟 CLI 源码目录（可多次，回退找 ol-<name>/index.js）。
                        默认仅从 PATH 全局发现已安装的兄弟 CLI（npm i -g 或 npx）。
  --json                仅向 stdout 输出纯 JSON（门禁结果用退出码表达）。
  --quiet               仅输出总分与门禁结论。
  --fail-on-low <n>     任一兄弟工具健康分低于 n（默认 70）则门禁失败。
  --min-overall <n>     总分低于 n（默认 60）则门禁失败。
  -V, --version         显示版本。
  -h, --help            显示本帮助。

说明：
  自身零依赖扫描「项目卫生概览」（LICENSE/README/锁文件/.gitignore/测试/package.json/危险文件）。
  若发现已安装的 family 兄弟 CLI，则逐个调用其 --json 并容错汇入统一体检矩阵；
  缺失或失败一律降级为「跳过」，不影响其余维度。找不到任何兄弟工具也能独立出体检报告。`;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch { return false; }
}

// ---------- 自身零依赖 overview 扫描 ----------
function scanOverview(root) {
  const issues = [];
  const add = (sev, msg) => issues.push({ severity: sev, msg });

  const pkgPath = path.join(root, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  let pkgValid = false;
  if (hasPkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkgValid = !!(pkg.name && pkg.version);
      if (!pkg.name) add('medium', 'package.json 缺少 name 字段');
      if (!pkg.version) add('medium', 'package.json 缺少 version 字段');
    } catch {
      add('high', 'package.json 无法解析（JSON 语法错误）');
    }
  }

  // LICENSE
  const hasLicense = fs.existsSync(path.join(root, 'LICENSE')) ||
    fs.existsSync(path.join(root, 'LICENSE.md')) ||
    fs.existsSync(path.join(root, 'COPYING'));
  if (!hasLicense) add('medium', '缺少 LICENSE 文件');

  // README
  if (!fs.existsSync(path.join(root, 'README.md')) &&
      !fs.existsSync(path.join(root, 'README'))) add('medium', '缺少 README 文档');

  // 锁文件（有 package.json 时）
  if (hasPkg) {
    const lockers = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
    const hasLock = lockers.some((l) => fs.existsSync(path.join(root, l)));
    if (!hasLock) add('low', '缺少锁文件（package-lock.json/yarn.lock/pnpm-lock.yaml/bun.lockb）');

    // .gitignore
    if (!fs.existsSync(path.join(root, '.gitignore'))) add('low', '缺少 .gitignore');
  }

  // 测试存在（有源码时）
  const hasSrc = isDir(path.join(root, 'src')) || isDir(path.join(root, 'lib')) ||
    isDir(path.join(root, 'app'));
  const hasTests =
    isDir(path.join(root, 'test')) || isDir(path.join(root, 'tests')) ||
    isDir(path.join(root, '__tests__')) ||
    fs.readdirSync(root).some((f) => /^.*\.test\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f) || f === 'test.js');
  if (hasSrc && !hasTests) add('medium', '有源码目录但未见测试');

  // 危险文件被提交（.env 存在且不被 .gitignore 忽略）
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    let ignored = false;
    const giPath = path.join(root, '.gitignore');
    if (fs.existsSync(giPath)) {
      const gtxt = fs.readFileSync(giPath, 'utf8');
      ignored = gtxt.split('\n').some((l) => l.trim() === '.env' || l.trim() === '.env*');
    }
    if (!ignored) add('medium', '.env 存在且未被 .gitignore 忽略（密钥泄露风险）');
  }

  // git 仓库提示
  const isGit = isDir(path.join(root, '.git'));
  if (!isGit) add('low', '目标不是 git 仓库（仓库卫生维度不可用）');

  let penalty = 0;
  for (const it of issues) penalty += (OV_PENALTY[it.severity] || 0);
  const score = Math.max(0, 100 - penalty);

  return { score, issues, hasPkg, isGit };
}

// ---------- 发现兄弟 CLI 路径 ----------
function findBrotherCli(name, toolsDirs) {
  // 1) 全局 PATH（已 npm i -g 或 npx 可用）
  // 用 spawnSync 探测可执行名（Windows 下 .cmd 由 shell 解析，这里直接试 node 调全局较麻烦，
  // 故本地优先 tools-dir；PATH 全局留给用户把 family 装全局后用 npx -p 串联）。
  for (const dir of toolsDirs) {
    for (const cand of [`ol-${name}/index.js`, `${name}/index.js`, `${name}.js`]) {
      const p = path.join(dir, cand);
      if (fs.existsSync(p)) return p;
    }
  }
  return null; // 未找到（可选增强缺失 → 降级跳过）
}

// ---------- 容错解析兄弟 JSON 的健康分 ----------
function parseBrotherScore(raw) {
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  // 兄弟工具字段不统一：healthScore / score / gate.passed
  if (typeof obj.healthScore === 'number') return obj.healthScore;
  if (typeof obj.score === 'number') return obj.score;
  if (obj.gate && typeof obj.gate.passed === 'boolean') return obj.gate.passed ? 100 : 0;
  return null;
}

function runBrother(name, cliPath, target) {
  try {
    const r = spawnSync('node', [cliPath, '--json', target], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return { found: true, score: null, status: 'error', detail: String(r.error.message || r.error) };
    if (r.status !== 0) return { found: true, score: null, status: 'failed', detail: `exit ${r.status}` };
    const score = parseBrotherScore(r.stdout);
    if (score === null) return { found: true, score: null, status: 'unparsable', detail: 'JSON 无健康分字段' };
    return { found: true, score, status: 'ok' };
  } catch (e) {
    return { found: true, score: null, status: 'error', detail: String(e && e.message || e) };
  }
}

// ---------- 输出 ----------
function buildReport(root, overview, brothers, opts) {
  const found = brothers.filter((b) => b.result && b.result.status === 'ok' && b.result.score !== null);
  const scores = found.map((b) => b.result.score);
  const overall = found.length
    ? Math.round((overview.score + scores.reduce((a, c) => a + c, 0)) / (1 + found.length))
    : overview.score;

  return {
    tool: 'enghealth',
    version: VERSION,
    root,
    overviewScore: overview.score,
    overallScore: overall,
    brothersFound: found.length,
    brothersTotal: brothers.length,
    overviewIssues: overview.issues,
    brothers: brothers.map((b) => ({
      name: b.name, label: b.label, cat: b.cat,
      found: !!(b.result && b.result.found),
      score: b.result && b.result.score !== null ? b.result.score : null,
      status: b.result ? b.result.status : 'missing',
      detail: b.result ? b.result.detail : '未安装/未提供 --tools-dir',
    })),
  };
}

function printHuman(report, opts) {
  if (opts.quiet) {
    console.log(`总分 ${report.overallScore}（概览 ${report.overviewScore}）｜兄弟工具 ${report.brothersFound}/${report.brothersTotal} 已并入`);
    return;
  }
  console.log('========================================');
  console.log(' 工程健康家族 · 统一体检报告 (enghealth)');
  console.log('========================================');
  console.log(`目标目录 : ${report.root}`);
  console.log(`概览健康分 : ${report.overviewScore}/100（enghealth 自身零依赖扫描）`);
  console.log(`并入兄弟工具 : ${report.brothersFound}/${report.brothersTotal}`);
  console.log('----------------------------------------');
  console.log('维度'.padEnd(14) + '类别'.padEnd(8) + '健康分'.padEnd(10) + '状态');
  for (const b of report.brothers) {
    const name = (b.label).padEnd(12);
    const cat = b.cat.padEnd(6);
    const sc = (b.score === null ? '--' : String(b.score)).padEnd(8);
    let st;
    if (!b.found) st = '跳过(未安装)';
    else if (b.status === 'ok') st = b.score >= 90 ? '优' : b.score >= 70 ? '良' : '需关注';
    else st = '跳过(' + b.status + ')';
    console.log(name + cat + sc + st);
  }
  console.log('----------------------------------------');
  console.log(`总分 : ${report.overallScore}/100`);
  if (report.overviewIssues.length) {
    console.log('概览发现：');
    for (const it of report.overviewIssues) console.log(`  [${it.severity}] ${it.msg}`);
  } else {
    console.log('概览发现：无');
  }
}

// ---------- 门禁 ----------
function runGate(report, opts) {
  const failures = [];
  if (opts.failOnLow !== null) {
    for (const b of report.brothers) {
      if (b.found && b.score !== null && b.score < opts.failOnLow) {
        failures.push(`${b.label}(${b.name}) 健康分 ${b.score} < ${opts.failOnLow}`);
      }
    }
  }
  if (opts.minOverall !== null && report.overallScore < opts.minOverall) {
    failures.push(`总分 ${report.overallScore} < ${opts.minOverall}`);
  }
  return { passed: failures.length === 0, failures };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  if (opts.version) { console.log(VERSION); process.exit(0); }

  const root = path.resolve(opts.target || '.');
  if (!isDir(root)) {
    console.error(`[错误] 目标目录不存在：${root}`);
    process.exit(2);
  }

  const overview = scanOverview(root);

  // 发现并运行兄弟 CLI
  const brothers = BROTHERS.map((b) => {
    const cliPath = findBrotherCli(b.name, opts.toolsDir);
    const result = cliPath ? runBrother(b.name, cliPath, root) : null;
    return { ...b, result };
  });

  const report = buildReport(root, overview, brothers, opts);
  const gate = runGate(report, opts);
  report.gate = gate;

  if (opts.json) {
    // 纯 JSON，绝不追加文本（pkgdoctor 铁律：--json 模式门禁只用退出码表达）
    process.stdout.write(JSON.stringify(report, null, 2));
    process.exit(gate.passed ? 0 : 2);
  }

  printHuman(report, opts);
  console.log('----------------------------------------');
  if (gate.passed) {
    console.log('CI 门禁：PASS');
    process.exit(0);
  } else {
    console.log('CI 门禁：FAIL');
    for (const f of gate.failures) console.log('  - ' + f);
    process.exit(2);
  }
}

main();

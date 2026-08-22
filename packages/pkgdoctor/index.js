#!/usr/bin/env node
'use strict';

/*
 * pkgdoctor — 零依赖单文件 package.json 配置卫生体检 CLI
 *
 * 扫描 package.json 的元数据坏味道 + 依赖声明规范，给 0-100 健康分 + CI 门禁。
 * 纯本地 fs 只读，不联网、不调 git、不执行用户代码，零依赖确定性可复现。
 *
 * 与 family 正交互补（不重叠）：
 *   - devdoctor  查"依赖胖瘦(bloat) + 依赖 license + cycles + 明文密钥"（运行态/源码态）
 *   - licguard   查"node_modules 里每个包的 license"（别人）
 *   - repodoctor 查"仓库工程卫生（含 package.json 无锁文件 G6）"（git 层）
 *   - pkgdoctor  查"项目自身 package.json 的元数据坏味道 + 依赖声明规范"（配置层）
 */

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 跳过防 OOM

// 严重度权重与扣分（健康分满分 100，按问题当量扣，封底 0）
const PENALTY = { high: 12, medium: 6, low: 3 };

// 参数解析：数值 / 路径 / 布尔 三类分离（cycscan 铁律：避免对路径调 parseInt 得 NaN）
const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-issues', '--min-score']);
const BOOL_FLAGS = new Set(['--json', '--quiet', '--fail-on-high', '--help', '-h', '--version', '-V']);

function parseArgs(argv) {
  const opts = {
    target: null,
    json: false, quiet: false, failOnHigh: false,
    maxHigh: null, maxMedium: null, maxIssues: null, minScore: null,
    help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (NUM_FLAGS.has(a)) {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) {
        console.error(`[错误] ${a} 需要一个整数参数`);
        process.exit(2);
      }
      if (a === '--max-high') opts.maxHigh = v;
      else if (a === '--max-medium') opts.maxMedium = v;
      else if (a === '--max-issues') opts.maxIssues = v;
      else if (a === '--min-score') opts.minScore = v;
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--json') opts.json = true;
      else if (a === '--quiet') opts.quiet = true;
      else if (a === '--fail-on-high') opts.failOnHigh = true;
      else if (a === '--help' || a === '-h') opts.help = true;
      else if (a === '--version' || a === '-V') opts.version = true;
    } else if (a.startsWith('-') && a !== '-') {
      console.error(`[错误] 未知选项：${a}`);
      process.exit(2);
    } else {
      if (opts.target === null) opts.target = a; // 第一个位置参 = target
      else { console.error(`[错误] 多余参数：${a}`); process.exit(2); }
    }
  }
  return opts;
}

// semver 基础校验（x.y.z + 可选预发布 + 可选构建）
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// 依赖版本范围是否"模糊"（版本漂移风险）
function isWildcardRange(v) {
  if (typeof v !== 'string') return false;
  if (v === '' || v === 'latest') return true;
  if (v.startsWith('workspace:')) return false; // pnpm/yarn workspace 别名，合法
  if (/^(file:|link:|git|https?:|npm:)/.test(v)) return false; // 非 npm registry 依赖，非模糊
  return /[*xX]/.test(v); // 含 * 或 x/X 即模糊范围（如 "*" "1.x" "1.2.*"）
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function scanPackageJson(pkgPath) {
  const issues = [];
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (e) {
    return { pkg: null, issues: [{ rule: 'read-error', severity: 'high', message: `无法读取 ${pkgPath}：${e.message}` }], raw: '' };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
    return { pkg: null, issues: [{ rule: 'too-large', severity: 'medium', message: `package.json 超过 ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB，跳过内容扫描` }], raw };
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    return { pkg: null, issues: [{ rule: 'invalid-json', severity: 'high', message: `package.json 不是合法 JSON：${e.message}` }], raw };
  }

  const priv = pkg.private === true;
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
  const version = pkg.version;
  const license = pkg.license;
  const engines = pkg.engines;
  const repository = pkg.repository;
  const scripts = pkg.scripts || {};
  const description = typeof pkg.description === 'string' ? pkg.description.trim() : '';
  const author = pkg.author;
  const type = pkg.type;
  const keywords = pkg.keywords;

  // ---- HIGH（×12）----
  if (!name) {
    issues.push({ rule: 'missing-name', severity: 'high', message: 'package.json 缺少 name 字段' });
  }
  if (version == null) {
    issues.push({ rule: 'missing-version', severity: 'high', message: 'package.json 缺少 version 字段' });
  } else if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    issues.push({ rule: 'invalid-version', severity: 'high', message: `version "${version}" 不是合法 semver（应为 x.y.z）` });
  }
  // 私有包(private:true)不对外发布，license 非必填；公开发布包必须声明
  if (!priv && !license) {
    issues.push({ rule: 'missing-license', severity: 'high', message: 'package.json 缺少 license 字段（公开发布包必须声明许可证）' });
  }

  // ---- MEDIUM（×6）----
  const wildcards = [];
  for (const f of DEP_FIELDS) {
    const deps = pkg[f];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (isWildcardRange(range)) wildcards.push(`${dep}@${range}`);
    }
  }
  if (wildcards.length) {
    const shown = wildcards.slice(0, 10).join(', ');
    issues.push({
      rule: 'wildcard-dependency',
      severity: 'medium',
      message: `存在模糊版本范围依赖（版本漂移风险）：${shown}${wildcards.length > 10 ? ' …' : ''}`,
    });
  }
  if (!engines || !engines.node) {
    issues.push({ rule: 'missing-engines', severity: 'medium', message: 'package.json 缺少 engines.node（未声明 Node 版本范围）' });
  }
  if (!repository) {
    issues.push({ rule: 'missing-repository', severity: 'medium', message: 'package.json 缺少 repository（不利发现与贡献）' });
  }
  if (!scripts.test) {
    issues.push({ rule: 'missing-test-script', severity: 'medium', message: 'package.json scripts 缺少 test（CI 无法自动验证）' });
  }
  if (!description) {
    issues.push({ rule: 'missing-description', severity: 'medium', message: 'package.json 缺少 description（不利 npm 发现）' });
  }

  // ---- LOW（×3）----
  if (!author) {
    issues.push({ rule: 'missing-author', severity: 'low', message: 'package.json 缺少 author' });
  }
  if (!type) {
    issues.push({ rule: 'missing-type', severity: 'low', message: 'package.json 缺少 type（ESM/CJS 歧义，默认 commonjs）' });
  }
  if (!Array.isArray(keywords) || keywords.length === 0) {
    issues.push({ rule: 'missing-keywords', severity: 'low', message: 'package.json 缺少 keywords（不利 npm 发现）' });
  }

  // 锁文件版本过旧（只读本地，与 repodoctor 查"锁文件存在性"互补不重叠）
  const dir = path.dirname(pkgPath);
  const lockPath = path.join(dir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (typeof lock.lockfileVersion === 'number' && lock.lockfileVersion < 2) {
        issues.push({ rule: 'lockfile-outdated', severity: 'low', message: `package-lock.json lockfileVersion=${lock.lockfileVersion} 过旧（建议升级到 2 或 3）` });
      }
    } catch (_) { /* 锁文件损坏不致命，跳过 */ }
  }

  return { pkg, issues, raw };
}

function computeScore(issues) {
  let score = 100;
  for (const it of issues) score -= PENALTY[it.severity] || 0;
  return Math.max(0, score);
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

const SEV_TAG = { high: 'HIGH', medium: 'MED ', low: 'LOW ' };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };

function printReport(pkgPath, ctx) {
  const { pkg, issues } = ctx;
  const score = computeScore(issues);
  const lines = [];
  lines.push(`pkgdoctor v${VERSION} — package.json 配置卫生体检`);
  if (pkg && pkg.name) {
    lines.push(`包：${pkg.name}${pkg.version ? '@' + pkg.version : ''}`);
  }
  lines.push(`目标：${pkgPath}`);
  lines.push(`健康分：${score}/100  等级 ${grade(score)}`);
  lines.push('');
  if (issues.length === 0) {
    lines.push('未发现问题。配置卫生良好。');
  } else {
    const sorted = [...issues].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    for (const it of sorted) {
      lines.push(`  [${SEV_TAG[it.severity]}] ${it.rule}: ${it.message}`);
    }
  }
  const h = issues.filter((i) => i.severity === 'high').length;
  const m = issues.filter((i) => i.severity === 'medium').length;
  const l = issues.filter((i) => i.severity === 'low').length;
  lines.push('');
  lines.push(`汇总：共 ${issues.length} 项（高 ${h} / 中 ${m} / 低 ${l}）`);
  return { score, lines };
}

function gateFails(opts, ctx) {
  const { issues } = ctx;
  const score = computeScore(issues);
  const h = issues.filter((i) => i.severity === 'high').length;
  const m = issues.filter((i) => i.severity === 'medium').length;
  if (opts.failOnHigh && h > 0) return { fail: true, reason: `存在 ${h} 个 HIGH 问题` };
  if (opts.maxHigh != null && h > opts.maxHigh) return { fail: true, reason: `HIGH 问题 ${h} > --max-high ${opts.maxHigh}` };
  if (opts.maxMedium != null && m > opts.maxMedium) return { fail: true, reason: `MEDIUM 问题 ${m} > --max-medium ${opts.maxMedium}` };
  if (opts.maxIssues != null && issues.length > opts.maxIssues) return { fail: true, reason: `问题总数 ${issues.length} > --max-issues ${opts.maxIssues}` };
  if (opts.minScore != null && score < opts.minScore) return { fail: true, reason: `健康分 ${score} < --min-score ${opts.minScore}` };
  return { fail: false };
}

function resolveTarget(target) {
  const p = target || process.cwd();
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    console.error(`[错误] 目标不存在：${p}`);
    process.exit(2);
  }
  return stat.isDirectory() ? path.join(p, 'package.json') : p;
}

function printHelp() {
  console.log(`pkgdoctor v${VERSION} — 零依赖 package.json 配置卫生体检

用法：
  pkgdoctor [目录或 package.json 路径] [选项]

选项：
  --json              输出 JSON（含 score / counts / issues）
  --quiet             仅显示 CI 门禁结果
  --fail-on-high     存在任意 HIGH 问题即失败（exit 2）
  --max-high N        HIGH 问题超过 N 失败
  --max-medium N     MEDIUM 问题超过 N 失败
  --max-issues N     问题总数超过 N 失败
  --min-score N      健康分低于 N 失败
  -V, --version      显示版本
  -h, --help         显示帮助

示例：
  pkgdoctor . --fail-on-high --min-score 80
  pkgdoctor ./packages/core --json
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }

  const pkgPath = resolveTarget(opts.target);
  const ctx = scanPackageJson(pkgPath);

  if (opts.json) {
    const score = computeScore(ctx.issues);
    const out = {
      file: pkgPath,
      score,
      grade: grade(score),
      counts: {
        high: ctx.issues.filter((i) => i.severity === 'high').length,
        medium: ctx.issues.filter((i) => i.severity === 'medium').length,
        low: ctx.issues.filter((i) => i.severity === 'low').length,
        total: ctx.issues.length,
      },
      issues: ctx.issues,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    const { lines } = printReport(pkgPath, ctx);
    console.log(lines.join('\n'));
  }

  const gate = gateFails(opts, ctx);
  // json 模式下只输出纯 JSON，门禁结果通过退出码表达（避免文本污染 JSON）
  if (gate.fail) {
    if (!opts.json && !opts.quiet) console.log(`\nCI 门禁：FAIL — ${gate.reason}`);
    process.exit(2);
  }
  if (!opts.json && !opts.quiet) console.log('\nCI 门禁：PASS');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs, scanPackageJson, computeScore, grade, isWildcardRange,
  SEMVER_RE, gateFails, VERSION,
};

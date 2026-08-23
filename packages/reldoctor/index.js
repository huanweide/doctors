#!/usr/bin/env node
'use strict';

/*
 * reldoctor — 零依赖发布卫生体检 CLI
 *
 * 解决一个极常见的发布事故：代码改了，但 version / git tag / CHANGELOG
 * 三者脱节（忘了打 tag、version 没跟上、CHANGELOG 没更新）。
 * 零依赖单文件，纯 fs + 系统 git 只读，不联网、不执行用户代码。
 *
 * 与 repodoctor(仓库卫生) / docdoctor(文档) / commitdoctor(提交消息) 拼成 git 层治理四件套。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- 参数解析（数值/路径/布尔 三类分离，避免 cycscan 的 parseInt(NaN) 致命 bug）----
const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-issues', '--min-score']);
const STR_FLAGS = new Set(['--root']);
const BOOL_FLAGS = new Set(['--fail-on-high', '--json']);

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    failOnHigh: false,
    json: false,
    maxHigh: Infinity,
    maxMedium: Infinity,
    maxIssues: Infinity,
    minScore: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-V') {
      process.stdout.write('reldoctor 1.0.0\n');
      process.exit(0);
    }
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (BOOL_FLAGS.has(a)) {
      if (a === '--fail-on-high') opts.failOnHigh = true;
      if (a === '--json') opts.json = true;
      continue;
    }
    if (NUM_FLAGS.has(a)) {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) {
        process.stderr.write(`错误：标志 ${a} 需要整数参数\n`);
        process.exit(2);
      }
      if (a === '--max-high') opts.maxHigh = v;
      else if (a === '--max-medium') opts.maxMedium = v;
      else if (a === '--max-issues') opts.maxIssues = v;
      else if (a === '--min-score') opts.minScore = v;
      continue;
    }
    if (STR_FLAGS.has(a)) {
      opts.root = argv[++i];
      continue;
    }
    if (!a.startsWith('-')) {
      // 位置参数也当作扫描根（与 --root 等价），统一 doctors <sub> <path> 语法
      opts.root = a;
      continue;
    }
    process.stderr.write(`未知标志：${a}\n`);
    process.exit(2);
  }
  return opts;
}

// ---- semver 解析与比较（零依赖，不引入 semver 包）----
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, raw: v };
}

function cmpSemver(a, b) {
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // 无预发布 > 有预发布
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre && b.pre) return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
  return 0;
}

function isValidSemver(v) {
  return parseSemver(v) !== null;
}

// ---- git 调用封装（execFileSync + cwd 传入，绝不拼 shell，杜绝注入）----
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return null; // 非 git 仓库 / 无权限 / 命令失败，一律降级为“无数据”而非崩溃
  }
}

function isGitRepo(root) {
  return git(['rev-parse', '--is-inside-work-tree'], root) === 'true';
}

function getTags(root) {
  const out = git(['tag', '-l'], root);
  if (out === null) return null;
  return out.split('\n').map((t) => t.trim()).filter(Boolean);
}

function getCommitsSinceTag(root, tag) {
  const out = git(['rev-list', `${tag}..HEAD`, '--count'], root);
  if (out === null) return null;
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

// ---- 健康分 ----
const SEV_WEIGHT = { high: 20, medium: 12, low: 6 };

function computeScore(issues) {
  let penalty = 0;
  for (const it of issues) penalty += SEV_WEIGHT[it.severity] || 0;
  return Math.max(0, 100 - penalty);
}

// ---- 核心扫描 ----
function scan(root) {
  const issues = [];
  let version = null;
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg.version === 'string') version = pkg.version;
    } catch (e) {
      // 坏 JSON 静默跳过，不崩
    }
  }

  const gitRepo = isGitRepo(root);
  let tags = [];
  if (gitRepo) {
    const t = getTags(root);
    if (t) tags = t;
  }

  const parsedTags = tags
    .map((raw) => ({ raw, sv: parseSemver(raw) }))
    .filter((x) => x.sv);
  parsedTags.sort((a, b) => cmpSemver(a.sv, b.sv));
  const latest = parsedTags.length ? parsedTags[parsedTags.length - 1] : null;
  const latestRaw = latest ? latest.raw : null;

  // R4 version-not-semver
  if (version !== null && version !== '' && !isValidSemver(version)) {
    issues.push({
      id: 'version-not-semver',
      severity: 'medium',
      message: `package.json version "${version}" 不符合 semver (应为 x.y.z)`,
    });
  }

  const versionOk = version && isValidSemver(version);

  // R1 version-tag-mismatch
  if (versionOk && latest) {
    if (cmpSemver(parseSemver(version), latest.sv) !== 0) {
      issues.push({
        id: 'version-tag-mismatch',
        severity: 'high',
        message: `package.json version ${version} 与最新 tag ${latestRaw} 不一致（发版前需对齐）`,
      });
    }
  }

  // R2 untagged-commits
  if (gitRepo && latestRaw) {
    const n = getCommitsSinceTag(root, latestRaw);
    if (n !== null && n > 0) {
      issues.push({
        id: 'untagged-commits',
        severity: 'high',
        message: `最新 tag ${latestRaw} 之后还有 ${n} 个未打 tag 的提交（代码已改但没发版）`,
      });
    }
  }

  // never-released
  if (versionOk && gitRepo && parsedTags.length === 0) {
    issues.push({
      id: 'never-released',
      severity: 'low',
      message: `package.json 声明 version ${version}，但仓库从未打过任何 semver tag`,
    });
  }

  // R5 tag-prefix-inconsistent
  if (parsedTags.length >= 2) {
    const hasV = parsedTags.some((x) => /^v/.test(x.raw));
    const noV = parsedTags.some((x) => !/^v/.test(x.raw));
    if (hasV && noV) {
      issues.push({
        id: 'tag-prefix-inconsistent',
        severity: 'low',
        message: 'tag 命名不一致：部分带 v 前缀（如 v1.0.0）部分不带（如 1.0.0）',
      });
    }
  }

  // CHANGELOG 相关
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const hasChangelog = fs.existsSync(changelogPath);
  if (!hasChangelog) {
    issues.push({
      id: 'no-changelog',
      severity: 'low',
      message: '缺 CHANGELOG.md（发布变更记录基本盘，建议补齐）',
    });
  } else if (versionOk) {
    const content = fs.readFileSync(changelogPath, 'utf8');
    const re = new RegExp('\\b' + version.replace(/\./g, '\\.') + '\\b');
    if (!re.test(content)) {
      issues.push({
        id: 'changelog-missing-version',
        severity: 'medium',
        message: `CHANGELOG.md 不含当前 version ${version} 的章节`,
      });
    } else if (!/^#{1,3}\s*\[?unreleased\]?/im.test(content)) {
      issues.push({
        id: 'no-unreleased-section',
        severity: 'low',
        message: 'CHANGELOG.md 无 Unreleased 段（建议保留用于归集未发版变更）',
      });
    }
  }

  const score = computeScore(issues);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const it of issues) counts[it.severity]++;
  return { issues, score, counts, version, latestRaw, gitRepo, tagCount: parsedTags.length };
}

// ---- 报告 ----
const SYM = { high: '✗', medium: '⚠', low: '·', pass: '✓' };

function buildReport(result, root, opts) {
  const lines = [];
  lines.push('reldoctor · 发布卫生体检');
  lines.push('目录: ' + root);
  lines.push('');

  // 摘要通过的维度
  const passLines = [];
  if (result.version) {
    passLines.push(`version = ${result.version}`);
  } else {
    passLines.push('version = (无 package.json)');
  }
  passLines.push(`latest tag = ${result.latestRaw || '(无)'}`);
  lines.push(passLines.join('   '));
  lines.push('');

  if (result.issues.length === 0) {
    lines.push(`${SYM.pass} 全部通过：version / tag / CHANGELOG 三者一致，无发布卫生问题`);
  } else {
    for (const it of result.issues) {
      const tag = it.severity === 'high' ? '高危' : it.severity === 'medium' ? '中危' : '低危';
      lines.push(`${SYM[it.severity]} ${tag} [${it.id}] ${it.message}`);
    }
  }

  lines.push('');
  const c = result.counts;
  lines.push(`健康分: ${result.score}/100   (高危 ${c.high} · 中危 ${c.medium} · 低危 ${c.low})`);
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) {
    process.stderr.write(`错误：目录不存在：${root}\n`);
    process.exit(2);
  }
  const result = scan(root);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(buildReport(result, root, opts) + '\n');
  }

  // CI 门禁
  let failed = false;
  if (opts.failOnHigh && result.counts.high > 0) failed = true;
  if (result.counts.high > opts.maxHigh) failed = true;
  if (result.counts.medium > opts.maxMedium) failed = true;
  if (result.issues.length > opts.maxIssues) failed = true;
  if (result.score < opts.minScore) failed = true;

  process.exit(failed ? 1 : 0);
}

const HELP_TEXT = `reldoctor — 零依赖发布卫生体检 CLI

用法:
  reldoctor [--root <dir>] [--fail-on-high] [--max-high N] [--max-medium N]
           [--max-issues N] [--min-score N] [--json] [--version|-V] [--help|-h]

检测维度（version / tag / CHANGELOG 三角）:
  version-tag-mismatch     高危   package.json version 与最新 tag 不一致
  untagged-commits         高危   最新 tag 后仍有未打 tag 的提交
  version-not-semver       中危   version 不符合 semver
  changelog-missing-version 中危  CHANGELOG 不含当前 version 章节
  never-released           低危   有 version 但从未打过 tag
  tag-prefix-inconsistent  低危   tag 命名带/不带 v 前缀混用
  no-changelog             低危   缺 CHANGELOG.md
  no-unreleased-section    低危   CHANGELOG 无 Unreleased 段

CI 门禁:
  --fail-on-high          出现任何高危即失败（exit 1）
  --max-high N            高危数超过 N 失败
  --max-medium N          中危数超过 N 失败
  --max-issues N          总问题数超过 N 失败
  --min-score N           健康分低于 N 失败
  --json                  输出 JSON（便于流水线解析）
`;

// 导出供测试（被 require 时不执行 main）
module.exports = { parseArgs, parseSemver, cmpSemver, isValidSemver, computeScore, scan };

if (require.main === module) main();

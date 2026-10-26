#!/usr/bin/env node
'use strict';

/*
 * ghadoctor — GitHub Actions 配置卫生体检 CLI（零依赖单文件）
 *
 * family 第 18 轴：CI 配置卫生（git 层治理第五件，与 repodoctor / docdoctor /
 * commitdoctor / reldoctor 拼成 git 层治理五件套）。
 *
 * 差异化：actionlint / zizmor 是重型（需装 / 编译 / 配置），ghadoctor 是
 * 零依赖单文件、确定性强、开箱即跑 + 健康分 + CI 门禁，填补"轻量零依赖"
 * 缝隙（与 family 一贯范式一致：重型工具占满 → 我们做零依赖轻量版）。
 *
 * 能力：扫描 .github/workflows/*.yml|*.yaml，检测 CI 安全/配置坏味道
 * （unpinned-action / script-injection / broad-permissions / pr-target-checkout /
 * missing-permissions / hardcoded-secret / no-timeout / no-concurrency），给
 * 0-100 健康分 + --json + CI 门禁。
 *
 * 约束：纯 fs 只读，不执行、不联网、不调 yaml 解析库（line-scanner + 轻量
 * 缩进跟踪，确定性强）。输出禁用 emoji（用 [HIGH]/[MED]/[LOW]）。
 *
 * 门禁契约（family 门禁三态，第 9.9 / 10.2 / 11.1 轮固化）：
 *   pass(0)        配置了阈值 + 输入可信 + 指标达标
 *   fail(2)        配置了阈值 + 至少一项不达标
 *   inconclusive(3) 未配置任何阈值（纯报告模式） 或 扫描输入为空（结论不可信）
 *   空扫描不得给满分（有害指标）：basisComplete=false 时健康分一律 null。
 */

const fs = require('fs');
const path = require('path');

const USAGE =
  '用法: ghadoctor [--root <dir>] [--json] [--fail-on-high] [--max-high N] ' +
  '[--max-medium N] [--max-issues N] [--min-score N] [--quiet]';

// ---------------------------------------------------------------------------
// 规则与权重
// ---------------------------------------------------------------------------

// 严重度扣分（健康分基础 100）
const PENALTY = { high: 15, medium: 8, low: 4 };

// 可变 action 引用（未 pin 到 40 字符 commit SHA）
// 匹配 uses: owner/repo@v4 | @main | @master | @latest | @head | @stable
const MUTABLE_REF = /^(\s*)(?:-\s+)?uses:\s*['"]?([^\s'"]+?)@(v\d[\w.-]*|main|master|latest|head|stable)['"]?\s*(?:#.*)?$/;

// 脚本注入：run 步里直接插值不可信输入（PR/issue 标题、head_ref 等）
const SCRIPT_INJECTION = /\$\{\{\s*github\.(?:event|head_ref|pr_|pull_request|sha|ref_name|ref)\b[^}]*\}\}/;

// 硬编码密钥/密码（保守：仅报低频高危模式，排除 ${{ secrets.* }} 引用）
const SECRET_PATTERNS = [
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"${{][^\s'"]{4,}/i,
  /(?:token|api[_-]?key|apikey|secret|access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/i,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN\s+(?:RSA|EC|OPENSSH|PRIVATE)\s+KEY-----/,
];

// ---------------------------------------------------------------------------
// 工作流发现
// ---------------------------------------------------------------------------

function isWorkflowName(name) {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return false;
  if (lower.includes('readme')) return false;
  return true;
}

function findWorkflowFiles(root) {
  const wfDir = path.join(root, '.github', 'workflows');
  const out = [];
  if (!fs.existsSync(wfDir)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && isWorkflowName(e.name)) out.push(full);
    }
  };
  walk(wfDir);
  return out;
}

// ---------------------------------------------------------------------------
// 单文件扫描（line-scanner + 轻量 run-body 缩进跟踪）
// ---------------------------------------------------------------------------

function scanWorkflow(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return [];
  }
  if (stat.size > 5 * 1024 * 1024) return []; // 超大文件跳过防 OOM
  const text = fs.readFileSync(absPath, 'utf8');
  const rawLines = text.split(/\r?\n/);
  const issues = [];

  let inRun = false;
  let runIndent = 0;
  let hasPermissions = false;
  let hasConcurrency = false;
  let hasTimeout = false;
  let prTarget = false;       // 本文件含 pull_request_target 触发
  let hasCheckout = false;    // 本文件含 actions/checkout

  const stripComment = (s) => s.replace(/#.*$/, ''); // 粗去行尾 # 注释（引号内 # 罕见于 workflow，接受近似）

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNo = i + 1;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    // 空行/纯注释：不更新结构状态，但 run body 内的注释仍算 run 上下文
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // 顶层/作业级键：结束当前 run body
    const isKeyLine = /^\s*[A-Za-z_][\w.-]*\s*:/.test(raw);
    if (inRun && isKeyLine && indent <= runIndent) {
      inRun = false;
    }

    // permissions / concurrency / timeout-minutes / 触发事件
    if (/^permissions\s*:/i.test(trimmed)) {
      hasPermissions = true;
      if (/write-all/i.test(trimmed)) {
        issues.push({ rule: 'broad-permissions', severity: 'high', line: lineNo,
          message: 'permissions: write-all 给 token 整库读写，应最小权限仅声明所需 scope' });
      }
    }
    if (/^concurrency\s*:/i.test(trimmed)) hasConcurrency = true;
    if (/timeout-minutes\s*:/i.test(trimmed)) hasTimeout = true;
    if (/^\s+pull_request_target\s*:/i.test(raw)) prTarget = true;

    // unpinned-action
    const um = raw.match(MUTABLE_REF);
    if (um) {
      issues.push({ rule: 'unpinned-action', severity: 'high', line: lineNo,
        message: `Action 引用未锁定到 commit SHA: ${um[2]}@${um[3]}（可变引用可被上游 repoint 成恶意代码，应 pin 到 40 字符 SHA）` });
    }

    // checkout（用于 pr-target-checkout 组合判定）
    if (/actions\/checkout@/i.test(trimmed)) hasCheckout = true;

    // run: 块起点（run: | 或 run: > 或内联 run: xxx）
    const runBlock = raw.match(/^(\s*)(?:-\s+)?run\s*:\s*(\||>)?\s*$/);
    const runInline = raw.match(/^(\s*)(?:-\s+)?run\s*:\s*(.+)$/);
    if (runBlock) {
      inRun = true;
      runIndent = indent;
    } else if (runInline) {
      inRun = true;
      runIndent = indent;
      checkRunBody(runInline[2], lineNo, issues);
      inRun = false; // 单行 run 立即结束
    } else if (inRun && indent > runIndent) {
      checkRunBody(raw, lineNo, issues);
    }

    // hardcoded-secret（全局逐行，env / run 均覆盖）
    if (!/\$\{\{\s*secrets\s*\./.test(trimmed)) {
      for (const p of SECRET_PATTERNS) {
        if (p.test(stripComment(raw))) {
          issues.push({ rule: 'hardcoded-secret', severity: 'medium', line: lineNo,
            message: '工作流中疑似硬编码密钥/密码（应改用 ${{ secrets.* }} 或从 Secrets 注入）' });
          break;
        }
      }
    }
  }

  // 文件级规则
  if (prTarget && hasCheckout) {
    issues.push({ rule: 'pr-target-checkout', severity: 'high', line: 0,
      message: 'pull_request_target 触发下 checkout PR head 代码，以特权 token 运行不可信代码（应 checkout base 或限制权限为只读）' });
  }
  if (!hasPermissions) {
    issues.push({ rule: 'missing-permissions', severity: 'medium', line: 0,
      message: '工作流未显式声明 permissions，默认继承 repo/组织权限（常过宽），应加 permissions: {} 或最小 scope' });
  }
  if (!hasConcurrency) {
    issues.push({ rule: 'no-concurrency', severity: 'low', line: 0,
      message: '未声明 concurrency，并发触发可能冲突（部署类工作流应加 concurrency 防止并发覆盖）' });
  }
  if (!hasTimeout) {
    issues.push({ rule: 'no-timeout', severity: 'low', line: 0,
      message: '未设置 timeout-minutes，作业可能无限挂起占用 runner' });
  }

  return dedupe(issues);
}

// run body 检测脚本注入
function checkRunBody(body, lineNo, issues) {
  const clean = body.replace(/#.*$/, '');
  if (SCRIPT_INJECTION.test(clean)) {
    issues.push({ rule: 'script-injection', severity: 'high', line: lineNo,
      message: 'run 步直接插值不可信输入（${{ github.event.* }} 等）进入 shell，存在脚本注入风险（应改用环境变量或审核动作）' });
  }
}

// 同文件同规则同行去重（放宽：同规则同 message 去重）
function dedupe(issues) {
  const seen = new Set();
  const out = [];
  for (const it of issues) {
    const key = `${it.rule}|${it.line}|${it.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 健康分
// ---------------------------------------------------------------------------

function scoreFile(issues) {
  let penalty = 0;
  for (const it of issues) penalty += PENALTY[it.severity] || 0;
  return Math.max(0, 100 - penalty);
}

// ---------------------------------------------------------------------------
// CLI 参数解析（三类分离：数值 / 路径 / 布尔）
// ---------------------------------------------------------------------------

const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-issues', '--min-score']);
const STR_FLAGS = new Set(['--root']);
const BOOL_FLAGS = new Set(['--json', '--fail-on-high', '--quiet', '--help', '-h']);

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    json: false,
    failOnHigh: false,
    quiet: false,
    maxHigh: Infinity,
    maxMedium: Infinity,
    maxIssues: Infinity,
    minScore: -1,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (BOOL_FLAGS.has(a)) {
      // --json/--fail-on-high/--quiet 置 true
      if (a === '--json') opts.json = true;
      else if (a === '--fail-on-high') opts.failOnHigh = true;
      else if (a === '--quiet') opts.quiet = true;
      continue;
    }
    if (STR_FLAGS.has(a)) {
      const v = argv[++i];
      // 缺值或下一个 token 是另一个选项 → 视为缺值（防止把 --json 当目录名吞掉）
      if (v === undefined || v.startsWith('-')) { fail(`选项 ${a} 缺少路径参数`); return; }
      opts.root = v;
      continue;
    }
    if (NUM_FLAGS.has(a)) {
      const raw = argv[++i];
      // 缺值 / 空串 / 非有限数 / 非整数 → 一律拒绝（NaN 静默传播是家族头号坑）
      const tv = String(raw === undefined ? '' : raw).trim();
      if (tv === '' || !Number.isFinite(Number(tv)) || !Number.isInteger(Number(tv))) {
        fail(`选项 ${a} 需要整数参数`);
        return;
      }
      if (a === '--max-high') opts.maxHigh = Number(tv);
      else if (a === '--max-medium') opts.maxMedium = Number(tv);
      else if (a === '--max-issues') opts.maxIssues = Number(tv);
      else if (a === '--min-score') opts.minScore = Number(tv);
      continue;
    }
    if (a === '--') continue;
    // 位置参数当作 root
    if (!a.startsWith('-')) { opts.root = a; continue; }
    fail(`未知选项: ${a}（家族铁律：任何未知选项一律退出码 2，不得静默忽略）`);
    return;
  }
  return opts;
}

function fail(msg) {
  const e = new Error(msg);
  e.isUsage = true;
  throw e;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(
        'ghadoctor — GitHub Actions 配置卫生体检 CLI（零依赖单文件）\n\n' +
        '用法:\n' +
        '  ghadoctor [--root <dir>]           扫描当前/指定目录的 .github/workflows\n' +
        '  ghadoctor --json                   输出纯 JSON（不含其他文本）\n' +
        '  ghadoctor --fail-on-high           存在 HIGH 问题时退出码 2\n' +
        '  ghadoctor --max-high N             HIGH 超过 N 退出码 2\n' +
        '  ghadoctor --max-medium N           超过 N 退出码 2\n' +
        '  ghadoctor --max-issues N           问题总数超过 N 退出码 2\n' +
        '  ghadoctor --min-score N            总体健康分低于 N 退出码 2\n' +
        '  ghadoctor --quiet                  仅打印总览\n'
      );
      return;
    }

    let root = opts.root;
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) { fail(`根路径不是目录: ${root}`); return; }
    } catch {
      fail(`根路径不存在: ${root}`);
      return;
    }

    const files = findWorkflowFiles(root);
    const fileReports = [];
    let totalHigh = 0, totalMedium = 0, totalLow = 0;

    for (const f of files) {
      const issues = scanWorkflow(f);
      let h = 0, m = 0, l = 0;
      for (const it of issues) {
        if (it.severity === 'high') h++;
        else if (it.severity === 'medium') m++;
        else l++;
      }
      totalHigh += h; totalMedium += m; totalLow += l;
      fileReports.push({
        path: f,
        score: scoreFile(issues),
        counts: { high: h, medium: m, low: l },
        issues,
      });
    }

    const totalIssues = totalHigh + totalMedium + totalLow;
    const basisComplete = files.length > 0;
    const overall = basisComplete
      ? Math.round(fileReports.reduce((s, r) => s + r.score, 0) / fileReports.length)
      : null; // 空扫描给 null，绝不给满分（有害指标，第 11 轮）

    const summary = {
      files: files.length,
      issues: totalIssues,
      high: totalHigh,
      medium: totalMedium,
      low: totalLow,
      score: overall,
      basisComplete,
    };

    // 门禁三态（第 9.9 / 10.2 / 11.1 轮固化）
    const configured = opts.failOnHigh
      || opts.maxHigh !== Infinity
      || opts.maxMedium !== Infinity
      || opts.maxIssues !== Infinity
      || opts.minScore >= 0;

    let gateState, gateReason, exitCode = 0, fails = [];
    if (!configured) {
      gateState = 'inconclusive';
      gateReason = '未配置任何门禁阈值（纯报告模式，退出码恒为 0）';
      exitCode = 0;
    } else if (!basisComplete) {
      gateState = 'inconclusive';
      gateReason = '未扫描到任何工作流文件，门禁结论不可信（输入为空）';
      exitCode = 3;
    } else {
      let passed = true;
      if (opts.failOnHigh && totalHigh > 0) { passed = false; fails.push(`存在 HIGH 问题: ${totalHigh}`); }
      if (totalHigh > opts.maxHigh) { passed = false; fails.push(`HIGH ${totalHigh} > ${opts.maxHigh}`); }
      if (totalMedium > opts.maxMedium) { passed = false; fails.push(`MEDIUM ${totalMedium} > ${opts.maxMedium}`); }
      if (totalIssues > opts.maxIssues) { passed = false; fails.push(`ISSUES ${totalIssues} > ${opts.maxIssues}`); }
      if (opts.minScore >= 0 && overall < opts.minScore) { passed = false; fails.push(`SCORE ${overall} < ${opts.minScore}`); }
      gateState = passed ? 'pass' : 'fail';
      gateReason = passed ? '' : fails.join('; ');
      exitCode = passed ? 0 : 2;
    }
    const gate = { state: gateState, configured, basisComplete, reason: gateReason, passed: gateState === 'pass', fails };

    if (opts.json) {
      const out = { files: fileReports, summary, gate };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      printText(fileReports, summary, gate, opts.quiet);
    }

    process.exitCode = exitCode; // 用 exitCode 而非 process.exit，避免截断 stdout（第 7.3 轮）
  } catch (e) {
    if (e && e.isUsage) {
      process.stderr.write(`ghadoctor: ${e.message}\n`);
      process.stderr.write(USAGE + '\n');
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

function printText(fileReports, summary, gate, quiet) {
  const w = process.stdout.write.bind(process.stdout);
  w('ghadoctor · GitHub Actions 配置卫生体检\n\n');
  if (fileReports.length === 0) {
    w('未找到 .github/workflows 下的工作流文件。\n');
  }
  for (const r of fileReports) {
    w(`${r.path}\n`);
    if (r.issues.length === 0) {
      w('  [OK] 无问题\n');
    } else {
      for (const it of r.issues) {
        const tag = it.severity === 'high' ? '[HIGH]' : it.severity === 'medium' ? '[MED]' : '[LOW]';
        const loc = it.line > 0 ? `L${it.line} ` : '';
        w(`  ${tag} ${loc}${it.rule}: ${it.message}\n`);
      }
    }
    w(`  健康分: ${r.score}\n\n`);
  }
  if (!quiet) {
    w('总览: 扫描 ' + summary.files + ' 文件, ' + summary.issues + ' 问题 (' +
      summary.high + ' HIGH / ' + summary.medium + ' MED / ' + summary.low + ' LOW)\n');
    if (summary.basisComplete) {
      w('总体健康分: ' + summary.score + '\n');
    } else {
      w('总体健康分: 无法评估（未扫描到任何工作流文件，数字无意义）\n');
    }
  }
  // 门禁状态行必须始终打印（防止「没消息就是通过」的误读，第 10.2 轮）
  if (gate.state === 'pass') w('CI 门禁: PASS\n');
  else if (gate.state === 'fail') w('CI 门禁: FAIL (' + gate.reason + ')\n');
  else w('CI 门禁: 未启用（' + gate.reason + '）\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  findWorkflowFiles,
  scanWorkflow,
  scoreFile,
  parseArgs,
  MUTABLE_REF,
  SCRIPT_INJECTION,
  SECRET_PATTERNS,
};

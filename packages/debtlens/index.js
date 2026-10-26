#!/usr/bin/env node
'use strict';

/*
 * debtlens — 零依赖单文件 Node CLI · 技术债密度扫描器
 *
 *   doctor  静态扫描（默认）：注释锚定识别各类技术债标记（完整清单见下方 TAGS 常量），
 *           按严重度加权统计密度，给出健康分 + CI 门禁。
 *
 * 设计铁律（继承 family 方法沉淀）：
 *   - 纯本地、零依赖、离线、单文件，跨平台（Windows posix 路径）。
 *   - 注释锚定扫描：标记必须跟在注释符(// # <!-- /*)之后，且扫描前先剥离
 *     字符串字面量，双重降误报（排除变量名与字符串内的伪标记）。
 *   - 门禁阈值一律严格校验：非数字 / 非整数 / 负数 / 空串 / 缺值 / 未知标记名 一律 exit 2，
 *     绝不静默放行。门禁参数写错 = 门禁不存在。
 *   - 门禁三态：pass(0) / fail(2) / inconclusive(3)。
 *     未配阈值、或扫描输入为空 → inconclusive(3)，绝不谎报「通过」。
 *   - 输入为空时不输出健康分（健康分是有害指标：扫 0 个文件报 100 分会让用户停止思考）。
 *   - root 必须 statSync 先验存在且为目录，错误路径不谎报"通过"。
 *   - 大文件（>5MB）跳过，避免 OOM。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 上限，跳过防 OOM
const SOFT_DENSITY = 8;                  // 每千行标记数软阈值（超过给警告）
const SCORE_FREE = 1;                    // 每千行允许加权债务（不扣分）
const SCORE_K = 25;                      // 超出部分扣分系数

// 技术债标记定义：tag / 严重度 / 权重
const TAGS = [
  { tag: 'TODO',       severity: 'high',   weight: 3 },
  { tag: 'FIXME',      severity: 'high',   weight: 3 },
  { tag: 'XXX',        severity: 'medium', weight: 2 },
  { tag: 'HACK',       severity: 'medium', weight: 2 },
  { tag: 'OPTIMIZE',   severity: 'medium', weight: 2 },
  { tag: 'REFACTOR',   severity: 'medium', weight: 2 },
  { tag: 'NOTE',       severity: 'low',    weight: 1 },
  { tag: 'DEPRECATED', severity: 'low',    weight: 1 }
];

const KNOWN_TAGS = new Set(TAGS.map(t => t.tag));

// 注释锚定：标记前必须跟注释符（// # <!-- /*），中间允许少量空白/词。
// 例：注释锚定能识别各类标记，具体清单见下方 TAGS 常量定义。
const COMMENT_ANCHOR = /(?:\/\/|#|<!--|\/\*)\s*\w*?\s*(TODO|FIXME|XXX|HACK|OPTIMIZE|REFACTOR|NOTE|DEPRECATED)\b/ig;
// 剥离字符串字面量（'...' "..." `...`），降低字符串内伪标记误报
const STRIP_STRINGS = /(["'`])(?:\\.|(?!\1).)*\1/g;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  'coverage', '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.cache',
  '.tmp', 'tmp', 'vendor', 'bower_components', '.idea', '.vscode'
]);

const SRC_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.rb', '.go', '.java', '.c', '.h', '.cpp', '.cc', '.hpp',
  '.cs', '.php', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash',
  '.yml', '.yaml', '.toml', '.json', '.md', '.vue', '.svelte'
]);

// 门禁阈值类选项：必须是 >= 0 的数字
const NUM_FLAGS = new Set(['--max-density', '--max-weighted']);
// 门禁阈值类选项：必须是 >= 0 的整数
const INT_FLAGS = new Set(['--max-total']);
// 门禁三态
const GATE_STATE = { PASS: 'pass', FAIL: 'fail', INCONCLUSIVE: 'inconclusive' };
const EXIT_FOR_STATE = { pass: 0, fail: 2, inconclusive: 3 };

// 哨兵异常：帮助 / 用法错误。用于把「参数错误」与「运行异常」分成两条干净的退出路径。
class HelpExit extends Error {}
class UsageExit extends Error {
  constructor(message, code) { super(message); this.code = code === undefined ? 2 : code; }
}

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

function packageVersion() {
  const pkg = readJsonSafe(path.join(__dirname, 'package.json'));
  return pkg && pkg.version ? pkg.version : '0.0.0';
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function scanFile(full) {
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (_) { return null; }
  const stripped = text.replace(STRIP_STRINGS, '""'); // 字符串变空串，保留长度
  const lines = stripped.split('\n');
  const hits = [];
  COMMENT_ANCHOR.lastIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    while ((m = COMMENT_ANCHOR.exec(line)) !== null) {
      const tag = m[1].toUpperCase();
      if (TAGS.some(t => t.tag === tag)) hits.push(tag);
    }
  }
  return { hits, lineCount: lines.length };
}

function scanRoot(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SRC_EXT.has(ext)) continue;
      if (fileSize(full) > MAX_FILE_BYTES) continue;
      files.push(full);
    }
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
  const byTag = {};
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byFile = {};
  let totalTags = 0;
  let totalWeighted = 0;
  let srcLines = 0;
  let taggedFiles = 0;
  for (const t of TAGS) byTag[t.tag] = 0;

  for (const full of files) {
    const res = scanFile(full);
    if (!res) continue;
    if (res.hits.length) {
      byFile[full] = (byFile[full] || 0) + res.hits.length;
      taggedFiles++;
    }
    for (const tag of res.hits) {
      byTag[tag]++;
      const def = TAGS.find(t => t.tag === tag);
      bySeverity[def.severity]++;
      totalWeighted += def.weight;
      totalTags++;
    }
    srcLines += res.lineCount;
  }

  const density = srcLines > 0 ? totalTags / (srcLines / 1000) : 0;
  const weightedDensity = srcLines > 0 ? totalWeighted / (srcLines / 1000) : 0;
  // 健康分是有害指标：扫描输入为空时没有健康可言，返回 null 而不是 100。
  const basisComplete = files.length > 0 && srcLines > 0;
  const score = basisComplete ? computeScore(weightedDensity) : { score: null, verdict: '无法评估' };

  return {
    root, files: files.length, srcLines, taggedFiles,
    totalTags, totalWeighted, byTag, bySeverity,
    basisComplete,
    density: Number(density.toFixed(2)),
    weightedDensity: Number(weightedDensity.toFixed(2)),
    healthScore: score.score,
    verdict: score.verdict,
    topFiles: topN(byFile, 10)
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
  if (score < 40) verdict = '债务沉重';
  else if (score < 70) verdict = '债务偏高';
  else if (score < 90) verdict = '基本健康';
  return { score, verdict };
}

// ---------------------------------------------------------------------------
// 警告 + 门禁
// ---------------------------------------------------------------------------

function buildWarnings(a) {
  const warnings = [];
  if (a.files === 0) warnings.push('no-source: 未扫描到任何源码文件');
  if (a.basisComplete && a.density > SOFT_DENSITY) {
    warnings.push('high-density: 技术债密度偏高 (' + a.density + ' 标记/千行，软阈值 ' + SOFT_DENSITY + ')');
  }
  if (a.bySeverity.high > 0) {
    warnings.push('has-high-severity: 存在阻塞级标记 (TODO/FIXME) 共 ' + a.bySeverity.high + ' 个');
  }
  return warnings;
}

/**
 * 门禁三态判定。
 * 判定顺序：① 是否配了阈值 → ② 输入是否可信 → ③ 是否有不达标项。
 * 顺序不能颠倒：输入为空时先报「通过」是本家族最恶劣的失败模式（假绿灯）。
 */
function buildGateState({ files, srcLines, basisComplete, opts, gate, warnings }) {
  const configured = opts.maxDensity !== undefined || opts.maxWeighted !== undefined ||
    opts.maxTotal !== undefined || !!opts.failOnTags || !!opts.failOnIssues;
  if (!configured) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: false,
      reason: '未配置任何门禁阈值；本次输出一律不构成「门禁通过」结论。' +
              '请显式传入 --max-density / --max-weighted / --max-total / --fail-on-tags / --fail-on-issues 之一。'
    };
  }
  if (files === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: true,
      reason: '扫描输入为空：0 个源码文件，门禁结论不可信（而非「通过」）。' +
              '请确认 --root 指向真实源码目录，且目录下有受支持扩展名的文件。'
    };
  }
  if (!basisComplete || srcLines === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: true,
      reason: '扫描到的文件全部无可解析内容（总行数 0），门禁结论不可信。'
    };
  }
  if (gate && gate.length) {
    return { state: GATE_STATE.FAIL, configured: true, reason: '存在 ' + gate.length + ' 项不达标。' };
  }
  return { state: GATE_STATE.PASS, configured: true, reason: '全部已配置门禁项达标。' };
}

function exitCodeFor(state) {
  return EXIT_FOR_STATE[state] === undefined ? 3 : EXIT_FOR_STATE[state];
}

/**
 * 计算门禁不达标项列表（不含三态判定）。
 * 阈值合法性已在 parseArgs 阶段用 UsageExit 拦掉，这里只做比较。
 */
function collectGateFailures(a, args, warnings) {
  const gate = [];
  if (args.maxDensity !== undefined && a.density > args.maxDensity) {
    gate.push('密度 ' + a.density + ' > --max-density ' + args.maxDensity);
  }
  if (args.maxWeighted !== undefined && a.weightedDensity > args.maxWeighted) {
    gate.push('加权密度 ' + a.weightedDensity + ' > --max-weighted ' + args.maxWeighted);
  }
  if (args.maxTotal !== undefined && a.totalTags > args.maxTotal) {
    gate.push('总标记数 ' + a.totalTags + ' > --max-total ' + args.maxTotal);
  }
  if (args.failOnTags) {
    const want = String(args.failOnTags).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    for (const w of want) {
      if ((a.byTag[w] || 0) > 0) gate.push('出现禁止标记 ' + w + ' (' + a.byTag[w] + ' 个)');
    }
  }
  if (args.failOnIssues && warnings.length > 0) {
    gate.push('存在 ' + warnings.length + ' 条警告');
  }
  return gate;
}

/** 兼容旧调用：返回 { code, gate }，code 由三态推导。 */
function applyGate(a, args, warnings) {
  const gate = collectGateFailures(a, args, warnings || []);
  const state = buildGateState({
    files: a.files, srcLines: a.srcLines,
    basisComplete: a.basisComplete !== undefined ? a.basisComplete : (a.files > 0 && a.srcLines > 0),
    opts: args, gate, warnings: warnings || []
  });
  return { code: exitCodeFor(state.state), gate, state };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usageError(msg) {
  throw new UsageExit('[debtlens] 错误：' + msg, 2);
}

/**
 * 严格数值参数校验。
 * 陷阱：Number('') === 0、parseInt('5abc') === 5、parseFloat('abc') === NaN。
 * 三者都会让错误的门禁阈值静默生效，因此必须显式排除空串并禁止尾随垃圾。
 */
function parseNumberFlag(flag, raw, { integer }) {
  if (raw === undefined) usageError(flag + ' 缺少数值参数');
  if (typeof raw !== 'string' || raw.trim() === '') usageError(flag + ' 需要数值参数（收到空值）');
  if (raw.trim().startsWith('-')) usageError(flag + ' 需要非负数（收到: ' + raw + '）');
  // 尾随垃圾检测：'5abc' / '1.2.3' / '0x10'
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) {
    usageError(flag + ' 需要十进制数字（收到: ' + raw + '）');
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) usageError(flag + ' 需要有限数字（收到: ' + raw + '）');
  if (integer && !Number.isInteger(v)) usageError(flag + ' 需要非负整数（收到: ' + raw + '）');
  return v;
}

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'doctor' || a === 'scan') { args._.push(a); continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--version' || a === '-V') { args.version = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--fail-on-issues') { args.failOnIssues = true; continue; }
    if (a === '--root') {
      const v = argv[++i];
      if (v === undefined) usageError('--root 缺少目录参数');
      if (v.trim() === '') usageError('--root 需要非空目录路径');
      if (v.startsWith('-')) usageError('--root 缺少目录参数（收到标志: ' + v + '）');
      args.root = v;
      continue;
    }
    if (NUM_FLAGS.has(a) || INT_FLAGS.has(a)) {
      args[a === '--max-density' ? 'maxDensity'
        : a === '--max-weighted' ? 'maxWeighted'
        : 'maxTotal'] = parseNumberFlag(a, argv[++i], { integer: INT_FLAGS.has(a) });
      continue;
    }
    if (a === '--fail-on-tags') {
      const v = argv[++i];
      if (v === undefined) usageError('--fail-on-tags 缺少标记名参数');
      if (v.trim() === '') usageError('--fail-on-tags 需要至少一个标记名');
      if (v.startsWith('-')) usageError('--fail-on-tags 缺少标记名参数（收到标志: ' + v + '）');
      const want = v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (!want.length) usageError('--fail-on-tags 需要至少一个标记名');
      const unknown = want.filter(t => !KNOWN_TAGS.has(t));
      if (unknown.length) {
        usageError('--fail-on-tags 含未知标记名: ' + unknown.join(',') +
                    '；可用标记: ' + Array.from(KNOWN_TAGS).join(',') +
                    '（门禁参数写错 = 门禁不存在，故此处必须报错而非静默通过）');
      }
      args.failOnTags = want.join(',');
      continue;
    }
    if (a.startsWith('-')) {
      usageError('未知选项: ' + a + '（用 --help 查看可用选项；门禁参数写错 = 门禁不存在）');
    }
    usageError('未知参数: ' + a + '（位置参数只接受 doctor / scan）');
  }
  return args;
}

function printHelp() {
  console.log([
    'debtlens — 零依赖单文件技术债密度扫描 CLI',
    '',
    '版本: ' + packageVersion(),
    '',
    '用法:',
    '  debtlens [doctor] [--root <dir>] [--json] [--max-density <n>] [--max-weighted <n>]',
    '                       [--max-total <n>] [--fail-on-tags <csv>] [--fail-on-issues]',
    '',
    '  doctor  静态扫描（默认）：注释锚定识别各类技术债标记，按严重度加权统计密度，',
    '         给健康分 + CI 门禁（完整标记清单见源码 TAGS 常量）',
    '',
    '门禁（阈值非法一律 exit 2，绝不静默放行）：',
    '  --max-density <n>   标记密度(标记/千行) 超过则失败    [非负数字]',
    '  --max-weighted <n>  加权密度(加权/千行) 超过则失败  [非负数字]',
    '  --max-total <n>     总标记数超过则失败              [非负整数]',
    '  --fail-on-tags <csv>  出现任一指定标记则失败        [必须是已知标记名]',
    '  --fail-on-issues    存在任何警告则失败',
    '',
    '退出码契约:',
    '  0  pass          已配置门禁且全部达标',
    '  2  fail          已配置门禁且存在不达标项 / 参数非法',
    '  3  inconclusive  未配置门禁阈值，或扫描输入为空 —— 结论不可信，**不等于通过**',
    '',
    '其他：',
    '  --version, -V       打印版本号',
    '  --help, -h          打印本帮助',
    '',
    '健康分：每千行允许加权债务 ' + SCORE_FREE + ' 不扣分，超出按系数 ' + SCORE_K + ' 扣，0-100。',
    '      扫描输入为空时健康分为 null（无法评估），不会给出 100 分误导你。'
  ].join('\n'));
}

function printReport(a, warnings, gate, gateState) {
  console.log('debtlens · 技术债密度扫描 · root=' + a.root);
  console.log('  扫描源码文件 : ' + a.files);
  console.log('  源码总行数   : ' + a.srcLines);
  console.log('  含债文件数   : ' + a.taggedFiles);
  console.log('  技术债标记   : ' + a.totalTags + ' (加权 ' + a.totalWeighted + ')');
  console.log('  严重度分布   : high=' + a.bySeverity.high + ' medium=' + a.bySeverity.medium + ' low=' + a.bySeverity.low);
  console.log('  密度         : ' + a.density + ' 标记/千行');
  console.log('  加权密度     : ' + a.weightedDensity + ' 加权/千行');
  const tagLine = TAGS.filter(t => a.byTag[t.tag] > 0).map(t => t.tag + '=' + a.byTag[t.tag]).join('  ');
  if (tagLine) console.log('  标记明细     : ' + tagLine);
  if (a.topFiles.length) {
    console.log('  债务 Top 文件:');
    for (const f of a.topFiles) console.log('    - ' + f.path + ' (' + f.count + ')');
  }
  if (a.basisComplete) {
    console.log('  健康分       : ' + a.healthScore + ' / 100  [' + a.verdict + ']');
  } else {
    console.log('  健康分       : 无法评估（扫描输入为空，扫描 0 个源码文件）');
  }
  if (a.elapsed !== undefined) console.log('  耗时         : ' + a.elapsed + ' ms');
  if (warnings.length) {
    console.log('  警告:');
    for (const w of warnings) console.log('    [警告] ' + w);
  } else {
    console.log('  警告: 无');
  }
  // 门禁状态始终显式打印，包括 pass —— 沉默的绿灯是假绿灯的温床。
  const label = gateState.state === GATE_STATE.PASS ? '通过'
    : gateState.state === GATE_STATE.FAIL ? '失败'
    : '未决（结论不可信，不等于通过）';
  console.log('  门禁: ' + label + '  [state=' + gateState.state + ' configured=' + gateState.configured + ']');
  console.log('    理由: ' + gateState.reason);
  if (gate && gate.length) {
    for (const g of gate) console.log('    [失败] ' + g);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.version) {
    console.log('debtlens ' + packageVersion());
    return 0;
  }

  const root = path.resolve(args.root);
  if (!isDir(root)) {
    usageError('root 不是有效目录 -> ' + root);
  }

  const t0 = Date.now();
  const a = analyze(root);
  a.elapsed = Date.now() - t0;
  const warnings = buildWarnings(a);
  const gate = collectGateFailures(a, args, warnings);
  const gateState = buildGateState({
    files: a.files, srcLines: a.srcLines, basisComplete: a.basisComplete,
    opts: args, gate, warnings
  });
  const code = exitCodeFor(gateState.state);

  if (args.json) {
    const report = {
      mode: 'doctor', root, files: a.files, srcLines: a.srcLines,
      taggedFiles: a.taggedFiles, totalTags: a.totalTags, totalWeighted: a.totalWeighted,
      byTag: a.byTag, bySeverity: a.bySeverity, density: a.density,
      weightedDensity: a.weightedDensity,
      basisComplete: a.basisComplete,
      healthScore: a.healthScore, verdict: a.verdict,
      topFiles: a.topFiles, elapsed: a.elapsed, warnings,
      gate: {
        state: gateState.state,
        configured: gateState.configured,
        reason: gateState.reason,
        failures: gate
      }
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(a, warnings, gate, gateState);
  }
  return code;
}

function run(argv) {
  try {
    return main(argv);
  } catch (e) {
    if (e instanceof HelpExit) return 0;
    if (e instanceof UsageExit) {
      console.error(e.message);
      process.exitCode = e.code;
      return e.code;
    }
    console.error('[debtlens] 运行异常: ' + (e && e.message));
    process.exitCode = 1;
    return 1;
  }
}

module.exports = {
  TAGS, SRC_EXT, SKIP_DIRS, KNOWN_TAGS, MAX_FILE_BYTES, SOFT_DENSITY, SCORE_FREE, SCORE_K,
  GATE_STATE, EXIT_FOR_STATE, NUM_FLAGS, INT_FLAGS,
  HelpExit, UsageExit,
  readJsonSafe, isDir, isFile, fileSize, countLines, packageVersion,
  scanFile, scanRoot, analyze, computeScore, buildWarnings,
  buildGateState, exitCodeFor, collectGateFailures, applyGate, parseArgs, main, run
};

if (require.main === module) {
  // 用 exitCode 而非 process.exit()：后者会截断异步刷写的 stdout，导致 --json 输出残缺。
  process.exitCode = run(process.argv.slice(2));
}

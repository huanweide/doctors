#!/usr/bin/env node
'use strict';

// secscan v1.0.0 —— 零依赖 JS/TS 安全反模式静态扫描 CLI
// family 第七轴：安全反模式（devdoctor 只扫明文密钥，本工具扫「不安全 API 使用模式」）
// 设计：逐字符 tokenizer 把注释/字符串剥成空格（保留换行）→ 在裸代码上检测危险模式，
//       字符串区单独检测明文 http://。规则正则一律用 new RegExp(字符串) 构造，
//       使模式字符串处于引号内被 tokenizer 剥离，避免 index.js 自身被自己报（dogfood 归零）。

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

// 默认扫描的扩展名。铁律：这是不可变的模块级常量，任何调用方都不得修改它。
// 历史缺陷：run() 曾用 SUPPORTED_EXT.clear() 处理 --ext，等于改写模块级共享状态——
// 编排入口（enghealth 等）同进程内先跑一次带 --ext 的调用后，后续所有调用都会
// 静默漏扫其余扩展名，并照常输出「未发现问题」。安全扫描器谎报干净，后果极严重。
// 现在 --ext 只作用于本次调用的局部集合。
const DEFAULT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte']);
const SUPPORTED_EXT = new Set(DEFAULT_EXTENSIONS); // 仅用于兼容旧导出，勿修改
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', '.cache', 'tmp', '.idea', '.vscode', 'bin', 'obj'
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 跳过防 OOM

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

// 规则定义：id / severity / title / advice
// 注意：title/advice 不得含会触发自身规则的裸字面量（如 http:// 写在字符串里会被 S4 自报）
const RULES = {
  S1: { id: 'S1', severity: 'high', title: '动态代码执行 eval()/new Function()', advice: '用 vm 沙箱或移除动态执行，避免代码注入（RCE）。' },
  S2: { id: 'S2', severity: 'high', title: 'child_process 命令拼接（命令注入）', advice: '用 execFile + 数组参数，或对用户输入严格白名单校验，禁止字符串拼接命令。' },
  S3: { id: 'S3', severity: 'high', title: 'TLS 证书验证被禁用', advice: '移除 rejectUnauthorized:false 与 NODE_TLS_REJECT_UNAUTHORIZED=0，否则中间人可劫持。' },
  S4: { id: 'S4', severity: 'medium', title: '明文 HTTP 传输（建议改用 HTTPS）', advice: '改为 https://，明文传输易被窃听/中间人。' },
  S5: { id: 'S5', severity: 'medium', title: 'SQL 语句字符串拼接（SQL 注入）', advice: '改用参数化查询 / 预编译语句，禁止拼接用户输入进 SQL。' },
  S6: { id: 'S6', severity: 'medium', title: 'Math.random() 用于安全上下文', advice: '安全用途（token/secret/id/nonce）改用 crypto.randomBytes / randomUUID。' },
  S7: { id: 'S7', severity: 'low', title: 'child_process.exec 常量命令（审查）', advice: '常量命令风险低，但建议迁移到 execFile 以收紧参数语义。' }
};

// 规则正则用字符串构造：模式处于引号内 → 被 tokenizer 剥离 → index.js 自身不会被自报
const RE = {
  eval: new RegExp('\\beval\\s*\\(', 'g'),
  newFunc: new RegExp('\\bnew\\s+Function\\s*\\(', 'g'),
  exec: new RegExp('\\b(?:exec|execSync|execFile|execFileSync)\\s*\\(', 'g'),
  tls: new RegExp('rejectUnauthorized\\s*:\\s*false', 'g'),
  tlsEnv: new RegExp('NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*(?:0|\'0\'|"0"|false)', 'g'),
  mathRandom: new RegExp('\\bMath\\.random\\s*\\(', 'g')
};
// S4 用正则字面量（code 区），S4 只报 string token，故自身不被报
const HTTP_RE = /http:\/\//g;
// SQL 关键字（code 区正则，S5 仅扫 string token，故自身不被报）
const SQL_KW = /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|MERGE)\b/i;
const SECURE_KW = /\b(?:token|secret|key|nonce|session|cookie|otp|salt|iv|password|passwd|auth|csrf|jwt|apikey|api_key)\b/i;

// ---------- 逐字符 tokenizer：标记每个字符属于 code / string / comment ----------
function isRegexContext(prev) {
  return prev === '' || '=([,:!&|?{;'.includes(prev);
}

function tokenize(src) {
  const n = src.length;
  const types = new Array(n).fill('code');
  let i = 0;
  let prevNonSpace = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') { types[j] = 'comment'; j++; }
      i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      types[i] = 'comment'; types[i + 1] = 'comment';
      while (j < n) {
        types[j] = 'comment';
        if (src[j] === '*' && src[j + 1] === '/') { types[j + 1] = 'comment'; j += 2; break; }
        j++;
      }
      i = j; continue;
    }
    // 正则字面量：/ 非注释且处于正则上下文（避免把 /re/ 内的裸引号误判为字符串起点）
    if (c === '/' && isRegexContext(prevNonSpace)) {
      let j = i + 1;
      let inClass = false;
      types[i] = 'code';
      while (j < n) {
        const d = src[j];
        if (d === '\\') { types[j] = 'code'; types[j + 1] = 'code'; j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']' && inClass) inClass = false;
        else if (d === '/' && !inClass) { types[j] = 'code'; j++; break; }
        else types[j] = 'code';
        j++;
      }
      while (j < n && /[a-z]/i.test(src[j])) { types[j] = 'code'; j++; } // flags
      i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      types[i] = 'string';
      while (j < n) {
        if (src[j] === '\\') { types[j] = 'string'; types[j + 1] = 'string'; j += 2; continue; }
        if (src[j] === quote) { types[j] = 'string'; j++; break; }
        types[j] = 'string'; j++;
      }
      i = j; continue;
    }
    if (!/\s/.test(c)) prevNonSpace = c;
    i++;
  }
  return types;
}

function lineAt(src, idx) {
  let line = 1;
  for (let k = 0; k < idx && k < src.length; k++) {
    if (src[k] === '\n') line++;
  }
  return line;
}

function getRegion(src, idx, radiusLines) {
  const target = lineAt(src, idx);
  const lines = src.split('\n');
  const start = Math.max(0, target - 1 - radiusLines);
  const end = Math.min(lines.length, target + radiusLines);
  return lines.slice(start, end).join('\n');
}

// ---------- 扫描单个源码文本，返回 issue 列表 ----------
function scanText(src) {
  const n = src.length;
  const types = tokenize(src);
  let codeText = '';
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === 'code') codeText += src[i];
    else codeText += (src[i] === '\n' ? '\n' : ' ');
  }

  const issues = [];
  const push = (idx, ruleId) => {
    const r = RULES[ruleId];
    issues.push({ line: lineAt(src, idx), id: r.id, severity: r.severity, title: r.title, advice: r.advice });
  };

  // S1 eval / new Function（仅裸代码区）
  for (const m of codeText.matchAll(RE.eval)) push(m.index, 'S1');
  for (const m of codeText.matchAll(RE.newFunc)) push(m.index, 'S1');

  // S2 / S7 child_process exec 系列——仅在引用 child_process 的文件中标记。
  // 否则会误报正则对象的 .exec() 方法（如 re.exec(content)），这是最常见的误报源。
  //
  // 严重度判定铁律（按第一实参形态，而非「首字符是不是引号」）：
  //   1) 字符串/模板字面量里含插值或拼接  -> S2 HIGH（命令注入，最危险形态）
  //   2) 首参是完全静态的常量字面量    -> S7 low（审查即可，Node 自己也会警告）
  //   3) 首参是变量 / 模板无插值         -> S2 HIGH（命令内容不可控）
  //   4) 数组参数形式 execFile(cmd,[a,b]) -> 降为 S7 low（Node 不经过 shell，无注入面）
  // 历史缺陷：旧实现只看 codeText 里首字符是否引号，而 codeText 已把字符串抹成空格，
  //   于是 exec('ls '+x)（真危险）被判 low、execFile(cmd,[a])（安全）被判 high，
  //   且模板插值 execSync(`rm -rf ${p}`) 直接漏检——恰好把最危险的形态判反了。
  const hasChildProcess = /require\s*\(\s*['"]child_process['"]\s*\)|from\s*['"]child_process['"]|import[^\n]*\bchild_process\b/.test(src);
  if (hasChildProcess) {
    // 必须在原始 src 上匹配调用位置：codeText 已把字符串抹成空格，
    // 且 tokenizer 可能把 {...} 误判为正则字面量而多吞字符，导致两者索引不对齐
    // （实测 {execSync} 解构写法会让偏移错 4 字符，模板串实参直接丢失）。
    const rawExec = /\b(exec|execSync|execFile|execFileSync)\s*\(/g;
    for (const m of src.matchAll(rawExec)) {
      const callName = m[1];
      // 区分「child_process 实例/命名空间的 .exec()」与「正则对象的 .exec()」：
      //   cp.exec(x) / childProcess.exec(x)  ->  真调用，要判
      //   re.exec(x) / pattern.exec(x)       ->  正则方法，与命令注入无关
      // 判据：点号前是 cp / child_process / childProcess / spawn 之类才认；
      // 裸 exec( 前若有标识符字符（re.exec）则跳过。
      if (m.index > 0) {
        const prev = src[m.index - 1];
        if (prev === '.') {
          const before = src.slice(Math.max(0, m.index - 30), m.index - 1);
          if (!/\b(?:cp|child_process|childProcess|child|proc|proc2|nodeProcess)\s*$/.test(before)) continue;
        } else if (/[.\w$]/.test(prev)) {
          continue;
        }
      }
      const rawAfter = src.slice(m.index + m[0].length);     // 原始 src，保留引号与插值
      if (/^\s*\)/.test(rawAfter)) continue;                 // 空参，跳过

      const usesArrayArgs = /\b(?:execFile|execFileSync)\b/.test(callName);
      if (usesArrayArgs) {
        // execFile/execFileSync 不经过 shell，数组参数形式无命令注入面
        push(m.index, 'S7');
        continue;
      }

      const firstArg = readFirstArg(rawAfter);
      if (!firstArg) continue;                               // 解析不出实参，跳过（不谎报）
      if (firstArg.dynamic) {
        push(m.index, 'S2');                                 // 插值 / 拼接 / 变量
      } else {
        push(m.index, 'S7');                                 // 纯静态常量
      }
    }
  }

  // S3 TLS 验证禁用（rejectUnauthorized:false 在 code 区；环境变量 = "0" 含字符串，用原始 src 保留）
  for (const m of codeText.matchAll(RE.tls)) push(m.index, 'S3');
  for (const m of src.matchAll(RE.tlsEnv)) {
    if (types[m.index] === 'code') push(m.index, 'S3'); // 仅真实代码区，跳过 advice 等字符串
  }

  // S4 明文 http:// —— 仅在字符串区（URL 字面量基本在字符串）
  HTTP_RE.lastIndex = 0;
  for (const m of src.matchAll(HTTP_RE)) {
    if (types[m.index] === 'string') push(m.index, 'S4');
  }

  // S5 SQL 字符串拼接 —— SQL 关键字在字符串里，需扫字符串 token + 拼接
  let k = 0;
  while (k < n) {
    if (types[k] === 'string') {
      let end = k;
      while (end < n && types[end] === 'string') end++;
      const seg = src.slice(k, end);
      if (SQL_KW.test(seg)) {
        // 拼接识别：字符串前(x + "..")、字符串后(".." + x)、字符串内模板(${)
        const ctxLeft = src.slice(Math.max(0, k - 4), k + 1);      // 含开头引号
        const ctxRight = src.slice(end - 1, Math.min(n, end + 4)); // 含结尾引号
        const hasConcat = /\+\s*[`'"]/.test(ctxLeft) ||
          /[`'"]\s*\+/.test(ctxRight) ||
          /[`'"]\s*\$\{|[`'"]\s*\$\{/.test(seg);
        if (hasConcat) push(k, 'S5');
      }
      k = end; continue;
    }
    k++;
  }

  // S6 Math.random 安全上下文（附近有安全关键词才报，避免噪声）
  for (const m of codeText.matchAll(RE.mathRandom)) {
    const region = getRegion(src, m.index, 2);
    if (SECURE_KW.test(region)) push(m.index, 'S6');
  }

  // 同文件同规则同行的去重
  const seen = new Set();
  const dedup = [];
  for (const it of issues) {
    const key = it.id + ':' + it.line;
    if (!seen.has(key)) { seen.add(key); dedup.push(it); }
  }
  return dedup;
}

// 读取 child_process 调用的第一个实参，判断其为「静态字面量」还是「动态」
// 返回 { dynamic: boolean }；解析不出（空参 / 立即调用等）时返回 null
function readFirstArg(after) {
  const s = after.replace(/^\s+/, '');
  const ch = s[0];
  if (ch === "'" || ch === '"') {
    // 普通字符串：找闭合引号（跳过转义），其后若紧跟 + 或 ${ 视区则是拼接 -> 动态
    let i = 1;
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === ch) break;
      i++;
    }
    if (i >= s.length) return { dynamic: false };           // 未闭合，退化为静态（不谎报）
    const rest = s.slice(i + 1);
    if (/^\s*(?:\+|\$\{)/.test(rest)) return { dynamic: true }; // 'a' + x
    if (/^\s*[,)]/.test(rest)) return { dynamic: false };        // 纯字面量
    return { dynamic: true };
  }
  if (ch === '`') {
    // 模板字面量：内部出现 ${...} 即为动态插值（最危险的命令注入形态）
    const close = s.indexOf('`', 1);
    const body = close === -1 ? s.slice(1) : s.slice(1, close);
    return { dynamic: body.includes('${') };
  }
  if (ch === ')' || ch === ',') return null;                 // 无实参
  // 变量 / 函数调用 / 表达式 —— 命令内容不可控
  return { dynamic: true };
}

// dogfood 归零豁免：精确到「相对路径」，且必须同时满足「文件名是自身测试文件」
// 这两条硬约束，避免把真实业务代码里的同名文件一并放过。
// 背景：本工具的 dogfood 纪律要求扫描自身仓库归零，而 test.js / smoke-cli.js 里
// 故意写着 cp.exec(userCmd)、execFileSync(...) 这类「反面样本」字符串，
// 它们是测试语料而非真实漏洞。放宽豁免（如按目录名豁免整个 tests/）会让
// 真正的漏洞藏进测试目录，反而破坏归零纪律的价值。
function isDogfoodExempt(absPath, root) {
  const base = path.basename(absPath);
  if (base !== 'test.js' && base !== 'smoke-cli.js') return false;
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  // 只豁免仓库根目录下的这两个文件，不豁免任何子目录里的同名文件
  return rel === 'test.js' || rel === 'scripts/smoke-cli.js';
}

// ---------- 目录递归扫描 ----------
function walk(dir, out, extSet) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, out, extSet);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (extSet.has(ext)) out.push(abs);
    }
  }
}

function scanDir(root, extensions, exempt) {
  // 每次调用用局部集合，绝不污染模块级 SUPPORTED_EXT
  const extSet = extensions && extensions.length ? new Set(extensions) : SUPPORTED_EXT;
  const files = [];
  walk(root, files, extSet);
  const allIssues = [];
  let totalLines = 0;
  let scannedFiles = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); }
    catch { continue; }
    if (Buffer.byteLength(src, 'utf8') > MAX_FILE_BYTES) continue;
    if (exempt && exempt(f)) continue;
    const issues = scanText(src);
    for (const it of issues) allIssues.push({ file: f, ...it });
    totalLines += src.split('\n').length;
    scannedFiles++;
  }
  return { issues: allIssues, files: scannedFiles, lines: totalLines };
}

// ---------- 健康分 ----------
function computeScore(issues, lines) {
  let w = 0;
  for (const it of issues) w += SEVERITY_WEIGHT[it.severity];
  const freeW = lines / 1000;
  const excess = Math.max(0, w - freeW);
  const deduction = excess * 12;
  return Math.max(0, Math.round(100 - deduction));
}

// ---------- 参数解析（三类分离：数值/路径/布尔） ----------
const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-low', '--max-issues']);
const STR_FLAGS = new Set(['--root', '--ext']);
const BOOL_FLAGS = new Set(['--json', '--fail-on-high', '--version', '-V', '--help', '-h']);

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    ext: null,
    json: false,
    failOnHigh: false,
    maxHigh: null,
    maxMedium: null,
    maxLow: null,
    maxIssues: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (NUM_FLAGS.has(a)) {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) { console.error('[secscan] 数值参数无效: ' + a + ' 需要整数'); process.exit(2); }
      if (a === '--max-high') opts.maxHigh = v;
      else if (a === '--max-medium') opts.maxMedium = v;
      else if (a === '--max-low') opts.maxLow = v;
      else if (a === '--max-issues') opts.maxIssues = v;
    } else if (STR_FLAGS.has(a)) {
      opts[a === '--root' ? 'root' : 'ext'] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--json') opts.json = true;
      else if (a === '--fail-on-high') opts.failOnHigh = true;
      else if (a === '--version' || a === '-V') { console.log('secscan v' + VERSION); process.exit(0); }
      else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    } else if (!a.startsWith('-')) {
      opts.root = a;
    } else {
      console.error('[secscan] 未知参数: ' + a);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    'secscan v' + VERSION + ' —— 零依赖 JS/TS 安全反模式静态扫描\n' +
    '用法: secscan [root] [选项]\n' +
    '  --root <dir>          扫描根目录（默认当前目录）\n' +
    '  --ext <csv>          仅扫描指定扩展名，如 js,ts,tsx\n' +
    '  --json               输出 JSON\n' +
    '  --fail-on-high       存在 high 即失败（exit 2）\n' +
    '  --max-high <n>       high 上限，超出失败\n' +
    '  --max-medium <n>     medium 上限\n' +
    '  --max-low <n>        low 上限\n' +
    '  --max-issues <n>     总问题数上限\n' +
    '  -V, --version        版本\n' +
    '  -h, --help           帮助\n' +
    '规则: S1 eval/new Function | S2 exec 拼接 | S3 TLS 禁用 | S4 明文 HTTP\n' +
    '      S5 SQL 拼接 | S6 Math.random 安全上下文 | S7 exec 常量命令'
  );
}

// ---------- 主运行 ----------
function run(argv) {
  const opts = parseArgs(argv);

  // --ext 只构造本次调用的局部扩展名集合，不再改写模块级状态
  let extList = null;
  if (opts.ext) {
    extList = opts.ext.split(',').map(e => '.' + e.trim().replace(/^\./, '')).filter(e => e !== '.');
    if (!extList.length) {
      console.error('[secscan] --ext 未给出有效扩展名');
      process.exit(2);
    }
  }

  let stat;
  try { stat = fs.statSync(opts.root); }
  catch {
    console.error('[secscan] 根目录不存在: ' + opts.root);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    console.error('[secscan] 不是目录: ' + opts.root);
    process.exit(2);
  }

  const { issues, files, lines } = scanDir(opts.root, extList, (f) => isDogfoodExempt(f, opts.root));
  const score = computeScore(issues, lines);

  const counts = { high: 0, medium: 0, low: 0 };
  for (const it of issues) counts[it.severity]++;

  if (opts.json) {
    console.log(JSON.stringify({ score, files, lines, counts, issues }, null, 2));
  } else {
    console.log('secscan v' + VERSION + ' · 安全反模式扫描');
    console.log('扫描 ' + files + ' 文件 / ' + lines + ' 行');
    if (issues.length === 0) {
      console.log('  未发现安全反模式。');
    } else {
      const order = { high: 0, medium: 1, low: 2 };
      issues.slice().sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line)
        .forEach(it => {
          const rel = path.relative(opts.root, it.file);
          console.log('  ' + it.id + '  ' + it.severity.padEnd(6) + '  ' +
            rel + ':' + it.line + '   ' + it.title);
        });
    }
    console.log('健康分: ' + score + '/100');
    console.log('  high=' + counts.high + ' medium=' + counts.medium + ' low=' + counts.low);
  }

  let failed = false;
  const fail = (msg) => { failed = true; if (!opts.json) console.log('门禁失败: ' + msg); };
  if (opts.failOnHigh && counts.high > 0) fail('存在 ' + counts.high + ' 处 high 级反模式');
  if (opts.maxHigh != null && counts.high > opts.maxHigh) fail('--max-high ' + opts.maxHigh + ' 超限(' + counts.high + ')');
  if (opts.maxMedium != null && counts.medium > opts.maxMedium) fail('--max-medium ' + opts.maxMedium + ' 超限(' + counts.medium + ')');
  if (opts.maxLow != null && counts.low > opts.maxLow) fail('--max-low ' + opts.maxLow + ' 超限(' + counts.low + ')');
  if (opts.maxIssues != null && issues.length > opts.maxIssues) fail('--max-issues ' + opts.maxIssues + ' 超限(' + issues.length + ')');

  if (failed) process.exit(2);
  process.exit(0);
}

if (require.main === module) {
  run(process.argv.slice(2));
}

module.exports = { scanText, scanDir, computeScore, tokenize, parseArgs, run, RULES, RE, VERSION, SUPPORTED_EXT, DEFAULT_EXTENSIONS, isDogfoodExempt };

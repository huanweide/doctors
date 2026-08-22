#!/usr/bin/env node
'use strict';

/*
 * devdoctor — 零依赖单文件 Node CLI · 四维项目体检中心
 *   bloat   依赖胖瘦（node_modules 体积 / 最大包 / 可原生替代候选）
 *   license 许可证合规（SPDX 分类：宽松 / 弱传染 / 强传染 / 未知）
 *   cycles  依赖环检测（JS/TS 相对导入构建 DAG，迭代 DFS 防栈溢出）
 *   secrets 明文密钥扫描（.env 与源码里 AWS / 私钥 / Token / JWT 等）
 *   doctor  一键全检，综合健康分 + CI 门禁
 *
 * 设计铁律（继承 family 方法沉淀）：
 *   - 纯本地、零依赖、离线、单文件，跨平台（Windows posix 路径）。
 *   - 门禁阈值一律 Number.isFinite 校验，非整数 exit 2，绝不静默放行。
 *   - root 必须 statSync 先验存在且为目录，错误路径不谎报"通过"。
 *   - 大文件（>5MB）跳过，避免 OOM；坏 JSON 静默跳过不崩。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 上限

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return 0;
  }
}

// 递归计算目录体积（跳过符号链接环），含嵌套 node_modules
function dirSize(root) {
  let total = 0;
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!seen.has(full)) {
          seen.add(full);
          stack.push(full);
        }
      } else if (e.isFile()) {
        total += fileSize(full);
      }
    }
  }
  return total;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function requireRoot(root) {
  if (!isDir(root)) {
    process.stderr.write(`[devdoctor] 错误：路径不存在或不是目录：${root}\n`);
    process.exit(2);
  }
  return root;
}

function parseThreshold(raw, optName) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`[devdoctor] 错误：${optName} 必须是数字，收到「${raw}」\n`);
    process.exit(2);
  }
  return n;
}

// ---------------------------------------------------------------------------
// bloat · 依赖胖瘦
// ---------------------------------------------------------------------------

// 常被"过度依赖"、多数可用 Node 原生 / 几行代码替代的包（仅作信息提示，不强制判定）
const REDUNDANT_CANDIDATES = new Set([
  'lodash', 'lodash.merge', 'moment', 'left-pad', 'is-odd', 'is-even',
  'colors', 'chalk', 'dotenv', 'uuid', 'querystring', 'commander', 'yargs',
  'axios', 'date-fns', 'ramda', 'underscore', 'mkdirp', 'rimraf', 'glob',
  'deep-equal', 'object-assign', 'clsx', 'classnames', 'strip-ansi',
  'is-buffer', 'ms', 'pretty-bytes', 'bytes',
]);

function pkgName(p) {
  // 支持 scoped 包：@scope/name
  const parts = p.split('/');
  if (p.startsWith('@') && parts.length >= 2) return parts[0] + '/' + parts[1];
  return parts[0];
}

function analyzeBloat(root, opts) {
  opts = opts || {};
  const nm = path.join(root, 'node_modules');
  if (!isDir(nm)) {
    return { found: false, totalMb: 0, pkgCount: 0, topBig: [], redundant: [] };
  }
  const total = dirSize(nm);
  const topBig = [];
  const redundant = [];
  const seenPkgs = new Set();

  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      let pj = null;
      const isScoped = e.name.startsWith('@');
      if (isScoped) {
        let sub;
        try {
          sub = fs.readdirSync(full, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const s of sub) {
          if (!s.isDirectory()) continue;
          const p = path.join(full, s.name);
          registerPkg(p);
        }
      } else {
        registerPkg(full);
      }
    }
  }

  function registerPkg(pkgDir) {
    const pjPath = path.join(pkgDir, 'package.json');
    const pj = readJsonSafe(pjPath);
    if (!pj || !pj.name) return;
    if (seenPkgs.has(pj.name)) return;
    seenPkgs.add(pj.name);
    const sz = dirSize(pkgDir);
    topBig.push({ name: pj.name, size: sz });
    if (REDUNDANT_CANDIDATES.has(pkgName(pj.name))) {
      redundant.push({ name: pj.name, size: sz });
    }
  }

  visit(nm);
  topBig.sort((a, b) => b.size - a.size);
  const totalMb = total / (1024 * 1024);
  const topBigMb = topBig.slice(0, 10).map((x) => ({
    name: x.name,
    mb: +(x.size / (1024 * 1024)).toFixed(3),
    pct: total ? +((x.size / total) * 100).toFixed(1) : 0,
  }));
  const redundantMb = redundant.reduce((s, x) => s + x.size, 0) / (1024 * 1024);
  return {
    found: true,
    totalMb: totalMb,
    pkgCount: seenPkgs.size,
    topBig: topBigMb,
    redundant: redundant.map((x) => ({ name: x.name, mb: +(x.size / (1024 * 1024)).toFixed(3) })),
    redundantMb: +redundantMb.toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// license · 许可证合规
// ---------------------------------------------------------------------------

// 宽松（permissive）
const PERMISSIVE = new Set([
  'MIT', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'APACHE-2.0', 'ISC', 'UNLICENSE',
  'MIT-0', 'BLUEOAK-1.0.0', 'PYTHON-2.0', 'ZLIB', 'WTFPL', '0BSD', 'CC0-1.0',
  'BSD', 'BSD-2', 'BSD-3', 'APACHE', 'BOOST-1.0', 'X11', 'MITNFA',
]);
// 弱传染（weak copyleft）
const WEAK = new Set([
  'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'EUPL-1.2', 'CDDL-1.0',
  'LGPL', 'LGPL-2.0', 'MPL', 'EPL',
]);
// 强传染（strong copyleft）
const STRONG = new Set([
  'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'AGPL', 'GPL',
]);

function normToken(t) {
  return String(t).toUpperCase().replace(/\s+/g, '').replace(/[-_]/g, '-');
}

// 分类单个 license token → 'permissive' | 'weak' | 'strong' | 'unknown'
function classifyLicenseToken(token) {
  const t = normToken(token);
  // 注意顺序：LGPL 必须先在弱类匹配，否则被 gpl 关键字吞成强传染误判
  if (WEAK.has(t) || /LGPL/.test(t)) return 'weak';
  if (STRONG.has(t) || /AGPL/.test(t) || /GPL/.test(t)) return 'strong';
  if (PERMISSIVE.has(t)) return 'permissive';
  return 'unknown';
}

function classifyLicense(licenseField) {
  // 支持 license 字符串 / licenses 数组 / licenses.type
  let raw = [];
  if (typeof licenseField === 'string') {
    raw = [licenseField];
  } else if (Array.isArray(licenseField)) {
    raw = licenseField.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean);
  } else if (licenseField && typeof licenseField === 'object' && licenseField.type) {
    raw = [licenseField.type];
  }
  if (raw.length === 0) return 'unknown';

  const rank = { permissive: 0, weak: 1, strong: 2, unknown: 3 };

  // SPDX 表达式：OR 优先级低（取最宽松），AND 段内取最严格；整体保守取最严
  function classifyExpr(expr) {
    expr = String(expr).replace(/[()]/g, ' '); // 剥离 SPDX 括号
    const orParts = String(expr).split(/\s+OR\s+/i);
    let orBest = 'strong'; // 初始最严，OR 取 min
    let first = true;
    for (const part of orParts) {
      const andTokens = part.split(/\s+AND\s+/i).map((t) => t.trim()).filter(Boolean);
      let andWorst = 'permissive';
      for (const tok of andTokens) {
        const c = classifyLicenseToken(tok);
        if (rank[c] > rank[andWorst]) andWorst = c;
      }
      if (first || rank[andWorst] < rank[orBest]) { orBest = andWorst; first = false; }
    }
    return orBest;
  }

  let worst = 'permissive';
  for (const expr of raw) {
    const c = classifyExpr(expr);
    if (rank[c] > rank[worst]) worst = c;
  }
  return worst;
}

function extractLicenseField(pj) {
  if (!pj) return null;
  if (pj.license) return pj.license;
  if (pj.licenses) return pj.licenses;
  // 部分包把 license 写进 package.json 的 "licenses" 旧格式
  return null;
}

function analyzeLicense(root) {
  const nm = path.join(root, 'node_modules');
  const result = {
    found: false,
    total: 0,
    permissive: 0,
    weak: 0,
    strong: 0,
    unknown: 0,
    strongList: [],
    weakList: [],
    unknownList: [],
  };
  if (!isDir(nm)) return result;
  result.found = true;

  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('@')) {
        let sub;
        try {
          sub = fs.readdirSync(full, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const s of sub) if (s.isDirectory()) scanPkg(path.join(full, s.name));
      } else {
        scanPkg(full);
      }
    }
  }

  function scanPkg(pkgDir) {
    const pj = readJsonSafe(path.join(pkgDir, 'package.json'));
    if (!pj || !pj.name) return;
    result.total++;
    const cat = classifyLicense(extractLicenseField(pj));
    if (cat === 'permissive') result.permissive++;
    else if (cat === 'weak') { result.weak++; result.weakList.push(pkgDir); }
    else if (cat === 'strong') { result.strong++; result.strongList.push(pkgDir); }
    else { result.unknown++; result.unknownList.push(pkgDir); }
  }

  visit(nm);
  return result;
}

// ---------------------------------------------------------------------------
// cycles · 依赖环检测
// ---------------------------------------------------------------------------

const SRC_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const IMPORT_RES = [
  /from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function extractRelativeImports(content) {
  const specs = new Set();
  for (const re of IMPORT_RES) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const s = m[1];
      if (s.startsWith('./') || s.startsWith('../')) specs.add(s);
    }
  }
  return [...specs];
}

// files: [{ path, content }]
function buildGraph(files) {
  const nodes = new Set();
  const edges = new Map();
  const pathSet = new Set(files.map((f) => f.path));
  // 在已提供的 files 集合内解析相对导入目标，不查磁盘（纯函数、可测、CLI 复用）
  function resolveInFiles(file, spec) {
    const dir = path.dirname(file);
    const base = path.resolve(dir, spec);
    const candidates = [
      base,
      base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '.mjs', base + '.cjs',
      path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
      path.join(base, 'index.js'), path.join(base, 'index.jsx'),
    ];
    for (const c of candidates) if (pathSet.has(c)) return c;
    return null;
  }
  for (const f of files) {
    nodes.add(f.path);
    const specs = extractRelativeImports(f.content);
    const targets = [];
    for (const spec of specs) {
      const t = resolveInFiles(f.path, spec);
      if (t) {
        nodes.add(t);
        targets.push(t);
      }
    }
    edges.set(f.path, targets);
  }
  return { nodes, edges };
}

// 迭代 DFS（显式栈 + 三色）检测所有简单环，返回环路径数组（已去重）
function detectCycles(graph) {
  const adj = graph.edges;
  const color = new Map(); // undefined=white, 1=gray, 2=black
  const cycles = [];
  const seenCycles = new Set();

  for (const start of graph.nodes) {
    if (color.get(start) === 2) continue;
    const stack = [{ node: start, i: 0, path: [start] }];
    color.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) || [];
      if (frame.i < neighbors.length) {
        const nxt = neighbors[frame.i++];
        const c = color.get(nxt);
        if (c === 1) {
          const idx = frame.path.indexOf(nxt);
          if (idx >= 0) {
            const cyc = frame.path.slice(idx).concat(nxt);
            const key = [...new Set(cyc)].sort().join('|');
            if (!seenCycles.has(key)) {
              seenCycles.add(key);
              cycles.push(cyc);
            }
          }
        } else if (c === undefined) {
          color.set(nxt, 1);
          stack.push({ node: nxt, i: 0, path: frame.path.concat(nxt) });
        }
      } else {
        color.set(frame.node, 2);
        stack.pop();
      }
    }
  }
  return cycles;
}

function orphansOf(graph) {
  const targets = new Set();
  for (const ts of graph.edges.values()) for (const t of ts) targets.add(t);
  const orphans = [];
  for (const n of graph.nodes) if (!targets.has(n)) orphans.push(n);
  return orphans;
}

function hubsOf(graph, topN) {
  const cnt = new Map();
  for (const ts of graph.edges.values()) {
    const u = new Set(ts);
    for (const t of u) cnt.set(t, (cnt.get(t) || 0) + 1);
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN || 10);
}

// ---------------------------------------------------------------------------
// secrets · 明文密钥扫描
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { type: 'AWS Access Key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, fixed: true },
  { type: 'Private Key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, fixed: true },
  { type: 'GitHub Token', re: /\bgh[po]_[A-Za-z0-9]{36,}\b/, fixed: true },
  { type: 'Google API Key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/, fixed: true },
  { type: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, fixed: true },
  { type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, fixed: true },
  {
    type: 'Generic Secret',
    re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"]([^'"]{12,})['"]/i,
    fixed: false,
    minLen: 12,
  },
  {
    // .env 常见无引号明文密码（与引号版互补，且仅限 password 类避免与 AWS/GitHub 等固定格式重复）
    type: 'Env Password',
    re: /(?:password|passwd|pwd)\s*[:=]\s*([^\s'"]{12,})/i,
    fixed: false,
    minLen: 12,
  },
];

const SECRET_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.json', '.yaml', '.yml', '.toml', '.ini', '.env']);
const SECRET_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', '.cache', 'vendor']);

function isSecretFile(name) {
  if (/\.env/.test(name)) return true;
  const ext = path.extname(name).toLowerCase();
  return SECRET_EXT.has(ext);
}

// 扫描单段文本，返回 [{ type, line, sample }]
function scanSecretsInText(text, minLen) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of SECRET_PATTERNS) {
      // 预编译带 g 的全局正则，每次重置 lastIndex，避免非全局 exec 同位置死循环（OOM 风险）
      const re = pat._re || (pat._re = new RegExp(pat.re.source, pat.re.flags.includes('i') ? 'gi' : 'g'));
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const val = m[1] || m[0];
        if (!pat.fixed && val.length < (pat.minLen || minLen || 12)) continue;
        // 脱敏：固定格式密钥仅泄露极少前缀 + 全掩码，不暴露尾部（防 token 末段被识别）
        const sample = pat.fixed
          ? (val.slice(0, 4) + '****')
          : (pat.type + ' (len=' + val.length + ')');
        findings.push({ type: pat.type, line: i + 1, sample });
      }
    }
  }
  return findings;
}

// 遍历目录收集密钥
function scanSecrets(root, opts) {
  opts = opts || {};
  const findings = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SECRET_SKIP_DIRS.has(e.name)) continue; // .git / node_modules / dist / build ...
        stack.push(path.join(cur, e.name));
      } else if (e.isFile()) {
        if (!isSecretFile(e.name)) continue;
        const full = path.join(cur, e.name);
        if (fileSize(full) > MAX_FILE_BYTES) continue;
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch (_) {
          continue;
        }
        const fs2 = scanSecretsInText(content, opts.minLen);
        for (const f of fs2) {
          findings.push({ file: path.relative(root, full), line: f.line, type: f.type, sample: f.sample });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// doctor · 一键全检
// ---------------------------------------------------------------------------

function runDoctor(root, opts) {
  opts = opts || {};
  const bloat = analyzeBloat(root, opts);
  const license = analyzeLicense(root);
  const cycles = (() => {
    const files = collectSourceFiles(root);
    const graph = buildGraph(files);
    return { graph, cycles: detectCycles(graph), orphans: orphansOf(graph), hubs: hubsOf(graph) };
  })();
  const secrets = scanSecrets(root, opts);

  let penalty = 0;
  if (bloat.found) penalty += Math.min(20, bloat.totalMb / 5);
  penalty += license.strong * 5;
  penalty += license.unknown * 1;
  penalty += cycles.cycles.length * 15;
  penalty += secrets.length * 10;
  const health = Math.max(0, Math.round(100 - penalty));

  return { bloat, license, cycles, secrets, health };
}

function collectSourceFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SECRET_SKIP_DIRS.has(e.name)) continue;
        if (e.name === 'node_modules') continue; // cycles 只分析项目内源码
        stack.push(path.join(cur, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SRC_EXT.has(ext)) continue;
        const full = path.join(cur, e.name);
        if (fileSize(full) > MAX_FILE_BYTES) continue;
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch (_) {
          continue;
        }
        files.push({ path: full, content });
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 报告格式化
// ---------------------------------------------------------------------------

function fmtMb(mb) {
  if (!isFinite(mb)) return '0 MB';
  if (mb > 0 && mb < 1) return (mb * 1024).toFixed(1) + ' KB';
  return mb.toFixed(2) + ' MB';
}

function reportBloat(r) {
  const out = ['\n=== bloat · 依赖胖瘦 ==='];
  if (!r.found) { out.push('  未找到 node_modules，跳过。'); return out.join('\n'); }
  out.push(`  包总数：${r.pkgCount}`);
  out.push(`  node_modules 体积：${fmtMb(r.totalMb)}`);
  out.push('  Top 大包：');
  for (const b of r.topBig) out.push(`    - ${b.name}  ${b.mb} MB  (${b.pct}%)`);
  if (r.redundant.length) {
    out.push(`  可原生替代候选（共 ${fmtMb(r.redundantMb)}）：`);
    for (const x of r.redundant) out.push(`    - ${x.name}  ${x.mb} MB`);
  }
  return out.join('\n');
}

function reportLicense(r) {
  const out = ['\n=== license · 许可证合规 ==='];
  if (!r.found) { out.push('  未找到 node_modules，跳过。'); return out.join('\n'); }
  out.push(`  扫描包数：${r.total}`);
  out.push(`  宽松：${r.permissive}  弱传染：${r.weak}  强传染：${r.strong}  未知：${r.unknown}`);
  if (r.strongList.length) out.push('  强传染：' + r.strongList.map(shortPkg).join(', '));
  if (r.weakList.length) out.push('  弱传染：' + r.weakList.map(shortPkg).join(', '));
  if (r.unknownList.length) out.push('  未知：' + r.unknownList.map(shortPkg).join(', '));
  return out.join('\n');
}

function shortPkg(p) { const i = p.lastIndexOf('node_modules'); return i >= 0 ? p.slice(i + 'node_modules'.length + 1) : p; }

function reportCycles(r) {
  const out = ['\n=== cycles · 依赖环 ==='];
  out.push(`  模块节点：${r.graph.nodes.size}  边：${countEdges(r.graph)}`);
  if (r.cycles.length === 0) out.push('  无依赖环。');
  else {
    out.push(`  发现 ${r.cycles.length} 个环：`);
    r.cycles.forEach((c, i) => out.push(`    环${i + 1}: ` + c.map(shortPkg).join(' → ')));
  }
  if (r.orphans.length) out.push(`  孤儿模块（未被引用）：${r.orphans.length}`);
  if (r.hubs.length) out.push('  被依赖最多：' + r.hubs.slice(0, 5).map((h) => shortPkg(h[0]) + '(' + h[1] + ')').join(', '));
  return out.join('\n');
}

function countEdges(g) { let n = 0; for (const ts of g.edges.values()) n += ts.length; return n; }

function reportSecrets(r) {
  const out = ['\n=== secrets · 明文密钥扫描 ==='];
  if (r.length === 0) { out.push('  未发现疑似明文密钥。'); return out.join('\n'); }
  out.push(`  发现 ${r.length} 处疑似泄露：`);
  for (const f of r) out.push(`    [${f.type}] ${f.file}:${f.line}  ${f.sample}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI 子命令
// ---------------------------------------------------------------------------

function cmdBloat(argv) {
  const { root, flags } = parseArgs(argv);
  requireRoot(root);
  const r = analyzeBloat(root);
  process.stdout.write(reportBloat(r) + '\n');
  if (flags['max-mb'] != null) {
    const max = parseThreshold(flags['max-mb'], '--max-mb');
    if (r.found && r.totalMb > max) {
      process.stdout.write(`\n[门禁] node_modules 体积 ${r.totalMb}MB 超过上限 ${max}MB → FAIL\n`);
      process.exit(1);
    }
  }
  if (flags['max-redundant'] != null) {
    const max = parseThreshold(flags['max-redundant'], '--max-redundant');
    if (r.found && r.redundant.length > max) {
      process.stdout.write(`\n[门禁] 可原生替代候选 ${r.redundant.length} 超过上限 ${max} → FAIL\n`);
      process.exit(1);
    }
  }
}

function cmdLicense(argv) {
  const { root, flags } = parseArgs(argv);
  requireRoot(root);
  const r = analyzeLicense(root);
  process.stdout.write(reportLicense(r) + '\n');
  if (flags['fail-on']) {
    const mode = String(flags['fail-on']).toLowerCase();
    const hit = mode === 'unknown' ? (r.unknown > 0)
      : mode === 'weak' ? (r.weak + r.strong > 0)
      : mode === 'strong' ? (r.strong > 0)
      : false;
    if (hit) {
      process.stdout.write(`\n[门禁] 触发 fail-on=${mode} → FAIL\n`);
      process.exit(1);
    }
  }
  if (flags['max'] != null) {
    const max = parseThreshold(flags['max'], '--max');
    if (r.unknown > max) {
      process.stdout.write(`\n[门禁] 未知许可证 ${r.unknown} 超过上限 ${max} → FAIL\n`);
      process.exit(1);
    }
  }
}

function cmdCycles(argv) {
  const { root, flags } = parseArgs(argv);
  requireRoot(root);
  const files = collectSourceFiles(root);
  const graph = buildGraph(files);
  const cycles = detectCycles(graph);
  const orphans = orphansOf(graph);
  const hubs = hubsOf(graph);
  const r = { graph, cycles, orphans, hubs };
  process.stdout.write(reportCycles(r) + '\n');
  if (flags['fail-on-cycle'] && cycles.length > 0) {
    process.stdout.write(`\n[门禁] 发现 ${cycles.length} 个依赖环 → FAIL\n`);
    process.exit(1);
  }
  if (flags['max-cycles'] != null) {
    const max = parseThreshold(flags['max-cycles'], '--max-cycles');
    if (cycles.length > max) {
      process.stdout.write(`\n[门禁] 依赖环 ${cycles.length} 超过上限 ${max} → FAIL\n`);
      process.exit(1);
    }
  }
}

function cmdSecrets(argv) {
  const { root, flags } = parseArgs(argv);
  requireRoot(root);
  const r = scanSecrets(root);
  process.stdout.write(reportSecrets(r) + '\n');
  if (flags['fail-on-secret'] && r.length > 0) {
    process.stdout.write(`\n[门禁] 发现 ${r.length} 处疑似明文密钥 → FAIL\n`);
    process.exit(1);
  }
  if (flags['max'] != null) {
    const max = parseThreshold(flags['max'], '--max');
    if (r.length > max) {
      process.stdout.write(`\n[门禁] 疑似密钥 ${r.length} 超过上限 ${max} → FAIL\n`);
      process.exit(1);
    }
  }
}

function cmdDoctor(argv) {
  const { root } = parseArgs(argv);
  requireRoot(root);
  const r = runDoctor(root);
  process.stdout.write(reportBloat(r.bloat) + '\n');
  process.stdout.write(reportLicense(r.license) + '\n');
  process.stdout.write(reportCycles(r.cycles) + '\n');
  process.stdout.write(reportSecrets(r.secrets) + '\n');
  process.stdout.write(`\n=== 综合健康分 ===\n  ${r.health} / 100\n`);
  if (r.health < 70) process.stdout.write('  [警告] 健康分偏低，建议处理上方红点。\n');
}

// 简单参数解析：首位置参为 root（默认 cwd），其余 --key value / --flag
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const root = positional[0] ? path.resolve(positional[0]) : process.cwd();
  return { root, flags };
}

function printHelp() {
  process.stdout.write([
    'devdoctor — 零依赖单文件 Node CLI · 四维项目体检中心',
    '',
    '用法：',
    '  devdoctor bloat   [dir] [--max-mb N] [--max-redundant N]   依赖胖瘦',
    '  devdoctor license [dir] [--fail-on unknown|weak|strong] [--max N]  许可证合规',
    '  devdoctor cycles  [dir] [--fail-on-cycle] [--max-cycles N]  依赖环',
    '  devdoctor secrets [dir] [--fail-on-secret] [--max N]        明文密钥扫描',
    '  devdoctor doctor  [dir]                                     一键全检 + 健康分',
    '  devdoctor help                                              本帮助',
    '',
    '特性：纯本地、零依赖、离线、单文件、跨平台；全部子命令可进 CI 门禁。',
  ].join('\n') + '\n');
}

function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'bloat': return cmdBloat(rest);
    case 'license': return cmdLicense(rest);
    case 'cycles': return cmdCycles(rest);
    case 'secrets': return cmdSecrets(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'help': case undefined: case '-h': case '--help': return printHelp();
    default:
      process.stderr.write(`[devdoctor] 未知子命令：${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('[devdoctor] 运行异常：' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(3);
  }
}

module.exports = {
  // utils
  readJsonSafe, dirSize, isDir, fileSize, pkgName,
  // bloat
  analyzeBloat, REDUNDANT_CANDIDATES,
  // license
  classifyLicense, classifyLicenseToken, analyzeLicense,
  // cycles
  extractRelativeImports, buildGraph, detectCycles, orphansOf, hubsOf,
  // secrets
  scanSecretsInText, scanSecrets, SECRET_PATTERNS,
  // doctor
  runDoctor, collectSourceFiles,
};

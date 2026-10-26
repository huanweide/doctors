#!/usr/bin/env node
'use strict';

/**
 * chaineye — 依赖链眼
 * 零依赖单文件 Node CLI。构建仓库 import 图谱，回答「改了 X，谁会受影响」。
 *
 * 支持静态分析：JavaScript / TypeScript / Python / Go 的相对导入。
 * 仅用 Node 内置模块（fs / path），`git clone` 即可跑，无 node_modules。
 */

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

// 默认忽略的目录（不进入扫描）
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.workbuddy', '.vscode', '.idea',
  'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache',
  'vendor', '__pycache__', '.venv', 'venv', 'target', 'bin',
  '.turbo', '.svelte-kit'
]);

// 支持的源文件扩展名
const SUPPORTED_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go'
]);

// 解析相对导入时尝试补的扩展名 / 目录索引（确定性顺序）
const RESOLVE_SUFFIXES = [
  '', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json',
  '.py', '.go',
  '/index.js', '/index.ts', '/index.jsx', '/index.tsx',
  '/__init__.py'
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// ---------- 解析 import 语句，返回本文件依赖的相对路径 ----------
function parseImports(content, ext) {
  const deps = [];
  if (ext === '.py') {
    // import x / from x import y / from . import y / from ..x.y import z
    // 把相对模块名转成相对路径：前导点表层级（1 个 = 当前目录，2 个 = 上一级），
    // 剩余的点换成斜杠（Python 包分隔符 . 对应目录分隔 /）。
    const re = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
    let m;
    while ((m = re.exec(content))) {
      const mod = m[1] || m[2];
      if (!mod || !mod.startsWith('.')) continue;
      let level = 0, i = 0;
      while (i < mod.length && mod[i] === '.') { level++; i++; }
      const rest = mod.slice(i).replace(/\./g, '/'); // 仅包路径里的点换斜杠
      let rp;
      if (level === 1) rp = './' + rest;
      else rp = '../'.repeat(level - 1) + rest;
      deps.push(rp);
    }
  } else if (ext === '.go') {
    // import "x"   /   import ( "x" "y" )
    const re = /import\s*(?:\(([\s\S]*?)\)|"([^"]+)")/g;
    let m;
    while ((m = re.exec(content))) {
      if (m[2] !== undefined) {
        if (m[2].startsWith('.')) deps.push(m[2]);
      } else if (m[1] !== undefined) {
        const inner = m[1].match(/"([^"]+)"/g) || [];
        for (const s of inner) {
          const p = s.slice(1, -1);
          if (p.startsWith('.')) deps.push(p);
        }
      }
    }
  } else {
    // JS / TS: import ... from 'x' / import 'x' / export ... from 'x' / require('x') / import('x')
    const re = /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(content))) {
      const mod = m[1] || m[2] || m[3] || m[4];
      if (mod && (mod.startsWith('.') || mod.startsWith('/'))) deps.push(mod);
    }
  }
  return deps;
}

// ---------- 把相对导入解析成仓库内真实文件路径（解析不到返回 null） ----------
function resolveDep(importerRel, dep, root, nodes) {
  const base = path.posix.dirname(importerRel);
  let rel;
  if (dep.startsWith('/')) {
    rel = dep.slice(1);
  } else {
    rel = path.posix.normalize(path.posix.join(base, dep));
  }
  if (rel.startsWith('..') || rel.startsWith('/')) {
    // 解析到仓库外或绝对路径 → 不计入仓库内边
    if (rel.startsWith('..')) return null;
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = rel + suffix;
    if (nodes && nodes.has(candidate)) return candidate; // 命中已知节点，免 statSync
    const full = path.join(root, candidate);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return candidate;
    } catch (_) { /* not found, try next */ }
  }
  return null;
}

// ---------- 递归扫描仓库内所有源文件 ----------
function scanFiles(root) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SUPPORTED_EXT.has(ext)) {
          files.push(toPosix(path.relative(root, full)));
        }
      }
    }
  }
  walk(root);
  return files;
}

// ---------- 构建依赖图 ----------
// adj:  node -> Set(它依赖的本地文件)
// radj: node -> Set(依赖它的本地文件，即反向边)
function buildGraph(root) {
  let st;
  try { st = fs.statSync(root); }
  catch (_) { throw new Error('仓库根目录不存在或无法访问: ' + root); }
  if (!st.isDirectory()) throw new Error('不是目录: ' + root);
  const files = scanFiles(root);
  const nodes = new Set(files);
  const adj = new Map();
  const radj = new Map();
  for (const f of files) {
    adj.set(f, new Set());
    radj.set(f, new Set());
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    let content;
    try {
      const fp = path.join(root, f);
      const fst = fs.statSync(fp);
      if (fst.size > 5 * 1024 * 1024) continue; // 跳过超大文件解析，防 OOM
      content = fs.readFileSync(fp, 'utf8');
    } catch (_) {
      continue;
    }
    const deps = parseImports(content, ext);
    for (const dep of deps) {
      const target = resolveDep(f, dep, root, nodes);
      if (target && nodes.has(target)) {
        adj.get(f).add(target);
        radj.get(target).add(f);
      }
    }
  }
  return { nodes, adj, radj, files };
}

// ---------- 影响范围：改了 target，沿反向依赖链向上传递，返回所有受影响文件 ----------
function impact(target, radj) {
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const n = stack.pop();
    const ups = radj.get(n);
    if (!ups) continue;
    for (const up of ups) {
      if (!seen.has(up)) {
        seen.add(up);
        stack.push(up);
      }
    }
  }
  seen.delete(target);
  return [...seen].sort();
}

// ---------- 直接上游：谁直接 import 了 target（一层） ----------
function directImporters(target, radj) {
  return [...(radj.get(target) || [])].sort();
}

// ---------- 循环依赖：返回所有处在环中的节点 ----------
function findCycleNodes(adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const inCycle = new Set();
  for (const n of adj.keys()) color.set(n, WHITE);

  // 显式栈迭代 DFS（三色标记），避免深依赖链递归导致栈溢出
  for (const start of adj.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack = [{ node: start, iter: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const neighbors = [...(adj.get(top.node) || [])];
      if (top.iter < neighbors.length) {
        const v = neighbors[top.iter++];
        const cv = color.get(v);
        if (cv === GRAY) {
          const idx = stack.findIndex((s) => s.node === v);
          for (let k = idx; k < stack.length; k++) inCycle.add(stack[k].node);
        } else if (cv === WHITE) {
          color.set(v, GRAY);
          stack.push({ node: v, iter: 0 });
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
  return inCycle;
}

// ---------- 孤立文件：无入边且无出边 ----------
function findOrphans(nodes, adj, radj) {
  const orphans = [];
  for (const n of nodes) {
    const out = (adj.get(n) || new Set()).size;
    const inc = (radj.get(n) || new Set()).size;
    if (out === 0 && inc === 0) orphans.push(n);
  }
  return orphans.sort();
}

// ---------- 枢纽文件：被依赖最多（入度 Top） ----------
function topHubs(nodes, radj, k = 15) {
  const arr = [];
  for (const n of nodes) {
    arr.push({ file: n, indeg: (radj.get(n) || new Set()).size });
  }
  arr.sort((a, b) => b.indeg - a.indeg || a.file.localeCompare(b.file));
  return arr.slice(0, k);
}

// ---------- 汇总统计 ----------
function computeStats(graph) {
  const { nodes, adj, radj } = graph;
  let edges = 0;
  for (const s of adj.values()) edges += s.size;
  const cycleNodes = findCycleNodes(adj);
  const orphans = findOrphans(nodes, adj, radj);
  return {
    files: nodes.size,
    edges,
    cycleCount: cycleNodes.size,
    orphanCount: orphans.length
  };
}

// ---------- 把用户输入的目标参数归一化到图内节点 ----------
function resolveTargetArg(arg, nodes, root) {
  if (!arg) return null;
  let t = arg;
  // 绝对路径 → 折算成相对仓库根的路径（小白常直接粘贴 IDE 里的绝对路径）
  if (path.isAbsolute(t)) {
    t = path.posix.relative(toPosix(root || '.'), toPosix(t));
  }
  if (t.startsWith('./')) t = t.slice(2);
  t = toPosix(t);
  t = path.posix.normalize(t);
  if (nodes.has(t)) return t;
  // 纯文件名（无路径分隔，如 c.js）→ 在仓库内按 basename 递归查找
  if (!t.includes('/')) {
    const base = path.posix.basename(t);
    for (const n of nodes) {
      if (path.posix.basename(n) === base) return n;
    }
  }
  for (const s of RESOLVE_SUFFIXES) {
    if (nodes.has(t + s)) return t + s;
  }
  return null;
}

// ---------- 输出与门禁 ----------
function printOverview(stats, flags) {
  const lines = [];
  lines.push('chaineye 依赖链眼 · 仓库概览');
  lines.push('  源文件       : ' + stats.files);
  lines.push('  依赖边       : ' + stats.edges);
  lines.push('  循环依赖节点 : ' + stats.cycleCount);
  lines.push('  孤立文件     : ' + stats.orphanCount);

  const reasons = [];
  if (stats.cycleCount > flags.maxCycles) {
    reasons.push('循环依赖 ' + stats.cycleCount + ' > 上限 ' + flags.maxCycles);
  }
  if (stats.orphanCount > flags.maxOrphans) {
    reasons.push('孤立文件 ' + stats.orphanCount + ' > 上限 ' + flags.maxOrphans);
  }
  if (flags.failOnCycle && stats.cycleCount > 0) {
    reasons.push('存在循环依赖 (' + stats.cycleCount + ')');
  }

  if (reasons.length) {
    lines.push('  CI 门禁      : 不通过');
    for (const r of reasons) lines.push('    - ' + r);
    return { ok: false, text: lines.join('\n') };
  }
  lines.push('  CI 门禁      : 通过');
  return { ok: true, text: lines.join('\n') };
}

function printHelp() {
  return [
    'chaineye — 依赖链眼：零依赖单文件 Node CLI，构建仓库 import 图谱',
    '',
    '用法：',
    '  chaineye [root]                      仓库概览 + CI 门禁',
    '  chaineye impact <file> [root]        改了 file，谁会受影响（反向依赖闭包）',
    '  chaineye why   <file> [root]         谁直接 import 了 file（一层上游）',
    '  chaineye cycles [root]               列出所有处在循环依赖中的文件',
    '  chaineye orphans [root]              列出孤立文件（无入边无出边）',
    '  chaineye hubs   [root]               枢纽文件 Top（被依赖最多）',
    '',
    '全局选项：',
    '  --json               机器可读 JSON 输出（适合 CI 消费）',
    '  --root <dir>         指定仓库根目录（默认 "."）',
    '  --max-cycles <N>     循环依赖节点数上限（超过则不通过）',
    '  --max-orphans <N>    孤立文件数上限（超过则不通过）',
    '  --fail-on-cycle      只要存在循环依赖就不通过',
    '',
    '示例：',
    '  chaineye . --max-cycles 0 --fail-on-cycle   # CI 里强制零循环依赖',
    '  chaineye impact src/core/parser.js          # 改了 parser，谁要跟着改',
    '  npx chaineye . --json                       # 拿 JSON 给流水线用',
    '',
    '支持：JavaScript / TypeScript / Python / Go 的相对导入静态分析。'
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let command = 'overview';
  let target = null;
  let root = '.';
  const flags = { json: false, maxCycles: Infinity, maxOrphans: Infinity, failOnCycle: false };
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { console.log(printHelp()); process.exit(0); }
    else if (a === '--json') flags.json = true;
    else if (a === '--fail-on-cycle') flags.failOnCycle = true;
    else if (a === '--max-cycles') {
      const v = parseInt(args[++i], 10);
      if (!Number.isFinite(v)) { console.error('错误：--max-cycles 需要一个整数'); process.exit(2); }
      flags.maxCycles = v;
    }
    else if (a === '--max-orphans') {
      const v = parseInt(args[++i], 10);
      if (!Number.isFinite(v)) { console.error('错误：--max-orphans 需要一个整数'); process.exit(2); }
      flags.maxOrphans = v;
    }
    else if (a === '--root') root = args[++i];
    else positionals.push(a);
  }

  const KNOWN = ['impact', 'why', 'cycles', 'orphans', 'hubs', 'overview', 'help'];
  const TARGETED = new Set(['impact', 'why']); // 这些命令的第一个位置参数是 target
  if (positionals.length >= 1) {
    const first = positionals[0];
    if (KNOWN.includes(first)) {
      command = first;
      if (positionals.length >= 2) {
        if (TARGETED.has(command)) target = positionals[1];
        else root = positionals[1];
      }
      if (positionals.length >= 3 && TARGETED.has(command)) root = positionals[2];
    } else {
      root = first;
      if (positionals.length >= 2) target = positionals[1];
    }
  }

  if (command === 'help') {
    console.log(printHelp());
    process.exit(0);
  }

  let graph;
  try {
    graph = buildGraph(root);
  } catch (e) {
    console.error('无法扫描仓库根目录 "' + root + '": ' + e.message);
    process.exit(2);
  }

  switch (command) {
    case 'overview': {
      const stats = computeStats(graph);
      if (flags.json) {
        console.log(JSON.stringify(stats, null, 2));
        process.exit(0);
      }
      const r = printOverview(stats, flags);
      console.log(r.text);
      process.exit(r.ok ? 0 : 1);
    }
    case 'impact': {
      const t = resolveTargetArg(target, graph.nodes, root);
      if (!t) {
        const raw = target.startsWith('./') ? target.slice(2) : target;
        const cand = path.join(root, toPosix(raw));
        if (fs.existsSync(cand)) {
          console.error('找不到目标文件: ' + target + '（路径存在，但不是受支持的源文件类型；支持 ' + [...SUPPORTED_EXT].join(' ') + '）');
        } else {
          console.error('找不到目标文件: ' + target + '\n  提示：请用相对仓库根的路径（如 src/c.js），或项目内的文件名（如 c.js）。');
        }
        process.exit(2);
      }
      const aff = impact(t, graph.radj);
      if (flags.json) {
        console.log(JSON.stringify({ target: t, affected: aff, count: aff.length }, null, 2));
      } else if (aff.length === 0) {
        console.log('改了 ' + t + '：该文件没有上游调用方（没有任何文件 import 它），改动不会向上波及其他文件。');
      } else {
        console.log('改了 ' + t + '，以下 ' + aff.length + ' 个文件会受影响（沿依赖链向上传递）：');
        aff.forEach((f) => console.log('  ' + f));
      }
      process.exit(0);
    }
    case 'why': {
      const t = resolveTargetArg(target, graph.nodes, root);
      if (!t) {
        console.error('找不到目标文件: ' + target + '\n  提示：请用相对仓库根的路径（如 src/c.js），或项目内的文件名（如 c.js）。');
        process.exit(2);
      }
      const ups = directImporters(t, graph.radj);
      if (flags.json) {
        console.log(JSON.stringify({ target: t, importers: ups, count: ups.length }, null, 2));
      } else {
        console.log('直接依赖 ' + t + ' 的文件（' + ups.length + ' 个）：');
        ups.forEach((f) => console.log('  ' + f));
      }
      process.exit(0);
    }
    case 'cycles': {
      const cn = findCycleNodes(graph.adj);
      if (flags.json) {
        console.log(JSON.stringify([...cn].sort(), null, 2));
      } else {
        console.log('循环依赖涉及 ' + cn.size + ' 个文件：');
        [...cn].sort().forEach((f) => console.log('  ' + f));
      }
      process.exit(0);
    }
    case 'orphans': {
      const orph = findOrphans(graph.nodes, graph.adj, graph.radj);
      if (flags.json) {
        console.log(JSON.stringify(orph, null, 2));
      } else {
        console.log('孤立文件（无入边无出边）' + orph.length + ' 个：');
        orph.forEach((f) => console.log('  ' + f));
      }
      process.exit(0);
    }
    case 'hubs': {
      const hubs = topHubs(graph.nodes, graph.radj, 15);
      if (flags.json) {
        console.log(JSON.stringify(hubs, null, 2));
      } else {
        console.log('枢纽文件 Top（被依赖最多，改它们影响最大）：');
        hubs.forEach((h, i) => console.log('  ' + (i + 1) + '. ' + h.file + '  (' + h.indeg + ' 个依赖方)'));
      }
      process.exit(0);
    }
    default: {
      console.log(printHelp());
      process.exit(0);
    }
  }
}

module.exports = {
  parseImports, resolveDep, scanFiles, buildGraph,
  impact, directImporters, findCycleNodes, findOrphans,
  topHubs, computeStats, toPosix, resolveTargetArg, printHelp, VERSION
};

if (require.main === module) {
  main();
}

'use strict';

/**
 * chaineye 单元测试（零依赖，仅用 Node 内置 assert + fs + os + path）
 * 运行：node test.js   退出码 0 = 全绿，非 0 = 有失败
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ce = require('./index.js');

// 跑子进程执行 CLI，返回 { code, out }
function runCli(args) {
  try {
    const out = cp.execFileSync(process.execPath, [path.join(__dirname, 'index.js')].concat(args), { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const code = (e.status === null || e.status === undefined) ? 1 : e.status;
    return { code, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
  }
}

// 构造临时 fixture 仓库
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chaineye-'));
  const files = {
    'a.js': "import { b } from './b.js';\nimport './c.js';\n",
    'b.js': "import './c.js';\n",
    'c.js': "// leaf, imports nothing\n",
    'd.js': "const a = require('./a.js');\n",  // d 依赖 a（a 不被 d 反向依赖，不构成环）
    'e.js': "// orphan: no imports, nobody imports it\n",
    'x.js': "import './y.js';\n",
    'y.js': "import './x.js';\n",
    'sub/f.py': "# leaf python module\n",
    'sub/g.py': "from .f import h\nimport os\n"   // python 相对导入，跨扩展名解析到 sub/f.py
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

console.log('chaineye 单元测试');

// ---------- 1. 解析器 ----------
test('parseImports 解析 ES import/from', () => {
  const r = ce.parseImports("import x from './b.js';\nimport './c';\nexport * from './d.ts';", '.js');
  assert.ok(r.includes('./b.js'));
  assert.ok(r.includes('./c'));
  assert.ok(r.includes('./d.ts'));
});

test('parseImports 解析 require / 动态 import', () => {
  const r = ce.parseImports("const a = require('./a.js');\nfoo(import('./lazy.js'));", '.js');
  assert.ok(r.includes('./a.js'));
  assert.ok(r.includes('./lazy.js'));
});

test('parseImports 忽略裸模块（第三方）', () => {
  const r = ce.parseImports("import React from 'react';", '.js');
  assert.strictEqual(r.length, 0);
});

test('parseImports 解析 Python 相对导入（模块名转路径）', () => {
  const r = ce.parseImports("from . import c\nfrom ..x import y\nimport os\n", '.py');
  assert.ok(r.includes('./'));      // from . import c  →  ./
  assert.ok(r.includes('../x'));    // from ..x import y →  ../x
  assert.strictEqual(r.includes('os'), false);
});

test('parseImports 解析 Go 相对导入', () => {
  const r = ce.parseImports('import (\n  "./a"\n  "./b"\n)\nimport "fmt"\n', '.go');
  assert.ok(r.includes('./a'));
  assert.ok(r.includes('./b'));
});

// ---------- 2. 图构建 / 解析依赖 ----------
test('buildGraph 构建节点与边', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  assert.ok(g.nodes.has('a.js'));
  assert.ok(g.nodes.has('sub/g.py'));
  // a 依赖 b、c
  assert.ok(g.adj.get('a.js').has('b.js'));
  assert.ok(g.adj.get('a.js').has('c.js'));
  // d 依赖 a（require 解析）；a 不再反向依赖 d，故不构成环
  assert.ok(g.adj.get('d.js').has('a.js'));
  // python './f' 解析成 sub/f.py（跨扩展名：.py 节点）
  assert.ok(g.adj.get('sub/g.py').has('sub/f.py'));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 3. 影响范围 ----------
test('impact 反向依赖闭包正确', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  // 改 c.js → a、b、d 都会受影响（c<-b, c<-a, b<-a, a<-d）
  const aff = ce.impact('c.js', g.radj);
  assert.deepStrictEqual(aff, ['a.js', 'b.js', 'd.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('impact 叶子节点返回空集', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const aff = ce.impact('e.js', g.radj);
  assert.deepStrictEqual(aff, []);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 4. 直接上游 ----------
test('directImporters 只给一层', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const ups = ce.directImporters('c.js', g.radj);
  assert.deepStrictEqual(ups, ['a.js', 'b.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 5. 循环依赖 ----------
test('findCycleNodes 识别双向环', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const cn = ce.findCycleNodes(g.adj);
  assert.ok(cn.has('x.js'));
  assert.ok(cn.has('y.js'));
  // a/b/c/d 不应在环中
  assert.strictEqual(cn.has('a.js'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 6. 孤立文件 ----------
test('findOrphans 孤立文件正确', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const orph = ce.findOrphans(g.nodes, g.adj, g.radj);
  assert.ok(orph.includes('e.js'));
  // a/b/c/d 互相有边，不是孤立
  assert.strictEqual(orph.includes('a.js'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 7. 枢纽文件 ----------
test('topHubs 按入度排序', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const hubs = ce.topHubs(g.nodes, g.radj, 3);
  // c.js 被 a、b 依赖 → indeg 2，应排第一
  assert.strictEqual(hubs[0].file, 'c.js');
  assert.strictEqual(hubs[0].indeg, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 8. 统计 ----------
test('computeStats 计数正确', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  const s = ce.computeStats(g);
  assert.strictEqual(s.files, 9);          // a,b,c,d,e,x,y,sub/f.js,sub/g.py
  assert.strictEqual(s.cycleCount, 2);     // x, y
  assert.strictEqual(s.orphanCount, 1);    // e
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 9. resolveTargetArg 健壮性 ----------
test('resolveTargetArg 兼容 ./ 前缀与缺扩展名', () => {
  const root = makeFixture();
  const g = ce.buildGraph(root);
  assert.strictEqual(ce.resolveTargetArg('./c.js', g.nodes), 'c.js');
  assert.strictEqual(ce.resolveTargetArg('c', g.nodes), 'c.js');
  assert.strictEqual(ce.resolveTargetArg('nope.js', g.nodes), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 10. 真实自测：扫描本仓库自带目录不崩溃 ----------
test('buildGraph 对真实目录可运行（无异常）', () => {
  const g = ce.buildGraph(__dirname);
  assert.ok(g.nodes.has('index.js'));
  const s = ce.computeStats(g);
  assert.ok(s.files >= 1);
});

// ---------- 11. CLI 集成测试（覆盖魔王轮转修复项） ----------
test('printHelp 含工具名', () => {
  assert.ok(ce.printHelp().includes('chaineye'));
});

test('--help / -h 退出 0 且打印用法', () => {
  const r1 = runCli(['--help']);
  assert.strictEqual(r1.code, 0);
  assert.ok(r1.out.includes('chaineye'));
  const r2 = runCli(['-h']);
  assert.strictEqual(r2.code, 0);
});

test('--max-cycles 非整数退出 2（不静默放行）', () => {
  const r = runCli(['.', '--max-cycles', 'abc']);
  assert.strictEqual(r.code, 2);
});

test('错误根目录退出 2', () => {
  const r = runCli(['/this/path/does/not/exist']);
  assert.strictEqual(r.code, 2);
});

test('cycles 支持位置 root 参数', () => {
  const root = makeFixture();
  const r = runCli(['cycles', root]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('x.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('impact 无上游时给出友好提示', () => {
  const root = makeFixture();
  const r = runCli(['impact', 'e.js', root]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('没有上游调用方'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('impact 找不到目标区分路径存在但非源文件', () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello');
  const r = runCli(['impact', 'notes.txt', root]);
  assert.strictEqual(r.code, 2);
  assert.ok(r.out.includes('不是受支持的源文件'));
  fs.rmSync(root, { recursive: true, force: true });
});

console.log('');
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);

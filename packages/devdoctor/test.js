'use strict';

/*
 * devdoctor 自包含单测（零依赖，仅用 node:assert + node:child_process）
 * 运行：node test.js   —— 全绿 exit 0，任一失败 exit 1
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const D = require('./index.js');
const CLI = path.join(__dirname, 'index.js');

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

// ---------------------------------------------------------------------------
// license 分类
// ---------------------------------------------------------------------------

(function testLicenseClassify() {
  assert.strictEqual(D.classifyLicenseToken('MIT'), 'permissive');
  assert.strictEqual(D.classifyLicenseToken('Apache-2.0'), 'permissive');
  assert.strictEqual(D.classifyLicenseToken('ISC'), 'permissive');
  // LGPL 必须先于 GPL 匹配 → 弱传染，而非被 gpl 关键字吞成强传染
  assert.strictEqual(D.classifyLicenseToken('LGPL-3.0'), 'weak');
  assert.strictEqual(D.classifyLicenseToken('lgpl-2.1'), 'weak');
  assert.strictEqual(D.classifyLicenseToken('MPL-2.0'), 'weak');
  assert.strictEqual(D.classifyLicenseToken('GPL-3.0'), 'strong');
  assert.strictEqual(D.classifyLicenseToken('AGPL-3.0'), 'strong');
  assert.strictEqual(D.classifyLicenseToken(''), 'unknown');
  assert.strictEqual(D.classifyLicenseToken('WTFPL'), 'permissive');

  // OR 表达式取最宽松
  assert.strictEqual(D.classifyLicense('MIT OR GPL-3.0'), 'permissive');
  // AND 表达式取最严格
  assert.strictEqual(D.classifyLicense('MIT AND GPL-3.0'), 'strong');
  // 数组 / 旧格式
  assert.strictEqual(D.classifyLicense([{ type: 'ISC' }]), 'permissive');
  assert.strictEqual(D.classifyLicense('(MIT OR Apache-2.0)'), 'permissive');
  ok('license 分类（宽松/弱/强/未知/表达式）正确');
})();

// ---------------------------------------------------------------------------
// bloat 真实扫描（构造临时 node_modules）
// ---------------------------------------------------------------------------

(function testBloat() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-bloat-'));
  const nm = path.join(tmp, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  // 一个普通包
  fs.mkdirSync(path.join(nm, 'some-lib'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'some-lib', 'package.json'), JSON.stringify({ name: 'some-lib', version: '1.0.0' }));
  fs.writeFileSync(path.join(nm, 'some-lib', 'index.js'), 'x'.repeat(1000));
  // 一个冗余候选（lodash）
  fs.mkdirSync(path.join(nm, 'lodash'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.0.0' }));
  fs.writeFileSync(path.join(nm, 'lodash', 'index.js'), 'y'.repeat(500));

  const r = D.analyzeBloat(tmp);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.pkgCount, 2);
  assert.ok(r.totalMb > 0);
  assert.ok(r.redundant.some((x) => x.name === 'lodash'));
  assert.strictEqual(D.analyzeBloat('/nonexistent-path-xyz').found, false);
  ok('bloat 真实扫描（包数/体积/冗余候选/缺目录降级）正确');
})();

// ---------------------------------------------------------------------------
// license 真实扫描
// ---------------------------------------------------------------------------

(function testLicenseScan() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-lic-'));
  const nm = path.join(tmp, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  const make = (name, lic) => {
    fs.mkdirSync(path.join(nm, name), { recursive: true });
    fs.writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: lic }));
  };
  make('a', 'MIT');
  make('b', 'GPL-3.0');
  make('c', 'LGPL-2.1');
  make('d', 'UNLICENSED-XXX'); // 未知
  const r = D.analyzeLicense(tmp);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.permissive, 1);
  assert.strictEqual(r.strong, 1);
  assert.strictEqual(r.weak, 1);
  assert.strictEqual(r.unknown, 1);
  // 坏 JSON 静默跳过
  fs.mkdirSync(path.join(nm, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'broken', 'package.json'), '{ not json');
  const r2 = D.analyzeLicense(tmp);
  assert.strictEqual(r2.total, 4);
  ok('license 真实扫描（计数 + 坏 JSON 跳过）正确');
})();

// ---------------------------------------------------------------------------
// cycles 环检测
// ---------------------------------------------------------------------------

(function testCycles() {
  const base = path.resolve('/fake/project');
  const files = [
    { path: path.join(base, 'a.js'), content: "import './b.js';" },
    { path: path.join(base, 'b.js'), content: "import './c.js';" },
    { path: joinOrphan(base, 'c.js'), content: "import './a.js';" }, // 环 a→b→c→a
    { path: path.join(base, 'd.js'), content: "import './e.js';" },
    { path: path.join(base, 'e.js'), content: "const x=1;" }, // 无环
  ];
  function joinOrphan(b, n) { return path.join(b, n); }
  const graph = D.buildGraph(files);
  const cycles = D.detectCycles(graph);
  assert.ok(cycles.length >= 1, '应检测到至少一个环');
  // 环应含 a,b,c
  const flat = cycles[0];
  assert.ok(['a.js', 'b.js', 'c.js'].every((n) => flat.some((p) => p.endsWith(n))));
  const orphans = D.orphansOf(graph);
  // d→e 但无人引用 d，d 是孤儿；e 被引用不是孤儿；a/b/c 互引成环
  assert.ok(orphans.some((p) => p.endsWith('d.js')), 'd.js 应为孤儿（无入边）');
  assert.strictEqual(orphans.length, 1);
  ok('cycles 环检测（a→b→c→a 环 + 孤儿识别 + 迭代 DFS 防栈溢出）正确');
})();

// ---------------------------------------------------------------------------
// secrets 扫描正则边界
// ---------------------------------------------------------------------------

(function testSecrets() {
  const text = [
    'aws key AKIAIOSFODNN7EXAMPLE in code',
    '-----BEGIN RSA PRIVATE KEY-----',
    'const t = "ghp_' + 'a'.repeat(36) + '";',
    'API_KEY="abcdefghijklmnopqrstuvwxyz012345";',  // 36 字符，应报
    'password = "short";',  // 过短，不应报
    'DB_PASSWORD=supersecretpassword123',  // 无引号 env 明文密码，应报 Env Password
    'const normal = "hello world";',  // 不应误报
  ].join('\n');
  const f = D.scanSecretsInText(text);
  const types = f.map((x) => x.type);
  assert.ok(types.includes('AWS Access Key ID'));
  assert.ok(types.includes('Private Key'));
  assert.ok(types.includes('GitHub Token'));
  assert.ok(types.includes('Generic Secret'));
  assert.ok(types.includes('Env Password'));
  assert.ok(!types.includes('const normal'));
  // 短密码不应触发
  const shortOnly = D.scanSecretsInText('password = "short";');
  assert.strictEqual(shortOnly.length, 0);
  ok('secrets 正则（AWS/私钥/GitHub/通用/无引号env密码 + 短值/正常行不误报）正确');
})();

// ---------------------------------------------------------------------------
// doctor 真实目录（构造一个含源码的项目）
// ---------------------------------------------------------------------------

(function testDoctor() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-doc-'));
  fs.writeFileSync(path.join(tmp, 'src.js'), "import './src2.js';\nconst k='ghp_" + 'b'.repeat(36) + "';\n");
  fs.writeFileSync(path.join(tmp, 'src2.js'), "module.exports=1;\n");
  const r = D.runDoctor(tmp);
  assert.ok(typeof r.health === 'number');
  assert.ok(r.health >= 0 && r.health <= 100);
  assert.ok(r.cycles.cycles.length === 0);
  assert.ok(r.secrets.length >= 1); // 含伪造 GitHub token
  ok('doctor 综合体检（健康分范围 + 源码环/密钥）正确');
})();

// ---------------------------------------------------------------------------
// CLI 门禁防呆：非数字阈值一律 exit 2（继承 chaineye 方法沉淀）
// ---------------------------------------------------------------------------

(function testGateBadThreshold() {
  let code = -1, errOut = '';
  try {
    execFileSync(process.execPath, [CLI, 'bloat', process.cwd(), '--max-mb', 'abc'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    code = e.status;
    errOut = e.stderr ? e.stderr.toString() : '';
  }
  assert.strictEqual(code, 2, '非数字阈值应 exit 2，而非静默放行');
  assert.ok(/必须是数字/.test(errOut), '应给出明确报错');
  ok('CLI 门禁防呆（非数字阈值 exit 2）正确');
})();

// ---------------------------------------------------------------------------
// CLI 未知子命令 exit 2
// ---------------------------------------------------------------------------

(function testUnknownCmd() {
  let code = -1;
  try {
    execFileSync(process.execPath, [CLI, 'frobnicate'], { stdio: 'ignore' });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  ok('CLI 未知子命令 exit 2');
})();

console.log(`\n全部 ${pass} 个测试组通过 ✅`);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classify, classifyToken, normalizeLicense, findPackages, gateViolations,
  buildBasis, readDeclared, isLocalRef,
} = require('./index.js');

function makePkg(dir, name, version, license) {
  const p = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version, license }));
  return p;
}

function makeRoot(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  return root;
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('classifyToken 基础分类', () => {
  assert.strictEqual(classifyToken('MIT'), 'permissive');
  assert.strictEqual(classifyToken('Apache-2.0'), 'permissive');
  assert.strictEqual(classifyToken('GPL-3.0'), 'strong');
  assert.strictEqual(classifyToken('AGPL-3.0'), 'strong');
  assert.strictEqual(classifyToken('LGPL-2.1'), 'weak');
  assert.strictEqual(classifyToken('MPL-2.0'), 'weak');
  assert.strictEqual(classifyToken('CC-BY-4.0'), 'unknown');
  assert.strictEqual(classifyToken(''), 'unknown');
});

test('classify OR 取最严格（合规保守）', () => {
  assert.strictEqual(classify('MIT OR Apache-2.0'), 'permissive');
  assert.strictEqual(classify('MIT OR GPL-3.0'), 'strong');
  assert.strictEqual(classify('(MIT OR Apache-2.0) AND GPL-3.0'), 'strong');
  assert.strictEqual(classify('ISC AND BSD-3-Clause'), 'permissive');
});

test('classify 未知与私有声明', () => {
  assert.strictEqual(classify(''), 'unknown');
  assert.strictEqual(classify('UNLICENSED'), 'unknown');
  assert.strictEqual(classify('SEE LICENSE IN LICENSE'), 'unknown');
  assert.strictEqual(classify('Custom'), 'unknown');
});

test('normalizeLicense 兼容多格式', () => {
  assert.strictEqual(normalizeLicense({ license: 'MIT' }), 'MIT');
  assert.strictEqual(normalizeLicense({ licenses: [{ type: 'ISC' }] }), 'ISC');
  assert.strictEqual(normalizeLicense({}), '');
  assert.strictEqual(normalizeLicense(null), '');
});

test('findPackages 递归扫描含 scoped 与嵌套 node_modules', () => {
  const root = tmp('licguard-');
  try {
    makePkg(root, 'foo', '1.0.0', 'MIT');
    const scoped = path.join(root, 'node_modules', '@scope', 'x');
    fs.mkdirSync(scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, 'package.json'), JSON.stringify({ name: '@scope/x', version: '1.0.0', license: 'ISC' }));
    makePkg(root, 'bar', '1.0.0', 'BSD-3-Clause');
    makePkg(path.join(root, 'node_modules', 'bar'), 'baz', '2.0.0', 'GPL-3.0');
    const pkgs = findPackages(root);
    const names = pkgs.map(p => p.name).sort();
    assert.ok(names.includes('foo'), '应包含 foo');
    assert.ok(names.includes('bar'), '应包含 bar');
    assert.ok(names.includes('@scope/x'), '应包含 scoped 包 @scope/x');
    assert.ok(names.includes('baz'), '应递归扫描嵌套 node_modules 内的 baz');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gateViolations 各模式', () => {
  const s = { permissive: 5, weak: 1, strong: 2, unknown: 3 };
  assert.strictEqual(gateViolations(s, 'strong'), 2);
  assert.strictEqual(gateViolations(s, 'unknown'), 3);
  assert.strictEqual(gateViolations(s, 'weak'), 1);
  assert.strictEqual(gateViolations(s, 'copyleft'), 6);
  assert.strictEqual(gateViolations(s, 'all'), 6);
  assert.strictEqual(gateViolations(s, 'danger'), 5);
  assert.strictEqual(gateViolations(s, null), 0);
});

// ---- 以下为「扫描基不完整」回归 ----

test('核心回归：声明 GPL 依赖但未安装时必须被检出（旧实现报0 个包 + 退出 0）', () => {
  const root = tmp('licguard-missing-');
  try {
    makeRoot(root, {
      name: 'demo',
      version: '1.0.0',
      dependencies: { 'gpl-lib': '^1.0.0' },
    });
    const basis = buildBasis(root);
    assert.strictEqual(basis.installed.length, 0, 'node_modules 不存在时已安装应为 0');
    assert.strictEqual(basis.missing.length, 1, '未安装的声明依赖必须被记为 missing');
    assert.strictEqual(basis.missing[0].name, 'gpl-lib');
    assert.strictEqual(basis.missing[0].notInstalled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('已安装的声明依赖不得被误判为 missing', () => {
  const root = tmp('licguard-ok-');
  try {
    makeRoot(root, { name: 'demo', dependencies: { foo: '^1.0.0' } });
    makePkg(root, 'foo', '1.0.0', 'MIT');
    const basis = buildBasis(root);
    assert.strictEqual(basis.missing.length, 0);
    assert.strictEqual(basis.installed.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('devDependencies / optional / peer 同样纳入缺失判定', () => {
  const root = tmp('licguard-fields-');
  try {
    makeRoot(root, {
      name: 'demo',
      dependencies: { a: '1' },
      devDependencies: { b: '1' },
      optionalDependencies: { c: '1' },
      peerDependencies: { d: '1' },
    });
    const basis = buildBasis(root);
    const names = basis.missing.map(m => m.name).sort();
    assert.deepStrictEqual(names, ['a', 'b', 'c', 'd']);
    const fields = basis.missing.map(m => m.declaredIn).sort();
    assert.deepStrictEqual(fields, ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('本地/远端来源引用不参与 missing 判定（workspace:/file:/git+）', () => {
  assert.strictEqual(isLocalRef('workspace:*'), true);
  assert.strictEqual(isLocalRef('file:../x'), true);
  assert.strictEqual(isLocalRef('link:../y'), true);
  assert.strictEqual(isLocalRef('git+https://a/b.git'), true);
  assert.strictEqual(isLocalRef('^1.0.0'), false);
  assert.strictEqual(isLocalRef('1.2.3'), false);

  const root = tmp('licguard-local-');
  try {
    makeRoot(root, {
      name: 'demo',
      dependencies: { 'local-pkg': 'workspace:*', 'remote-pkg': 'github:a/b' },
    });
    const basis = buildBasis(root);
    assert.strictEqual(basis.missing.length, 0, '本地与 git 来源不应算「未安装」');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无 package.json 且无 node_modules 时必须报告 manifest缺失，而不是静默 0 包', () => {
  const root = tmp('licguard-empty-');
  try {
    const basis = buildBasis(root);
    assert.strictEqual(basis.hasManifest, false);
    assert.strictEqual(basis.hasNodeModules, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('坏掉的 package.json 必须被标记为 invalid', () => {
  const root = tmp('licguard-bad-');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
    const basis = buildBasis(root);
    assert.strictEqual(basis.manifestInvalid, true);
    assert.strictEqual(basis.hasManifest, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('node_modules 内坏 JSON 的包不得让整个扫描崩掉', () => {
  const root = tmp('licguard-badpkg-');
  try {
    makeRoot(root, { name: 'demo', dependencies: { broken: '1', good: '1' } });
    makePkg(root, 'good', '1.0.0', 'MIT');
    const broken = path.join(root, 'node_modules', 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), '{{{');
    const basis = buildBasis(root);
    assert.strictEqual(basis.installed.length, 1);
    assert.strictEqual(basis.missing.length, 0, '目录存在即视为已安装，不因package.json 坏掉而误报缺失');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDeclared 无 package.json 时返回 null', () => {
  const root = tmp('licguard-nomanifest-');
  try {
    assert.strictEqual(readDeclared(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
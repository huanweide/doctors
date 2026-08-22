#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const mod = require('./index.js');

const IDX = path.join(__dirname, 'index.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgdoctor-'));

function writePkg(obj, dir) {
  const d = dir || path.join(TMP, 'p' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(obj, null, 2));
  return d;
}

function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [IDX, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ---- 纯函数：扫描器 ----
test('干净 package.json → 0 问题 score 100', () => {
  const d = writePkg({
    name: 'demo', version: '1.0.0', license: 'MIT', type: 'commonjs',
    engines: { node: '>=18' }, repository: { type: 'git', url: 'x' },
    scripts: { test: 'node --test' }, description: 'd', author: 'a', keywords: ['a'],
  });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.strictEqual(ctx.issues.length, 0);
  assert.strictEqual(mod.computeScore(ctx.issues), 100);
});

test('缺 license（非私有）→ HIGH', () => {
  const d = writePkg({ name: 'x', version: '1.0.0' });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'missing-license' && i.severity === 'high'));
});

test('私有包缺 license → 不报 HIGH', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', private: true });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(!ctx.issues.some((i) => i.rule === 'missing-license'));
});

test('模糊依赖 → MEDIUM', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT', dependencies: { 'left-pad': '*' } });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'wildcard-dependency' && i.severity === 'medium'));
});

test('workspace: 依赖不误报', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT', dependencies: { 'pkg-a': 'workspace:*' } });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(!ctx.issues.some((i) => i.rule === 'wildcard-dependency'));
});

test('file:/git:/github: 依赖不误报', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT', dependencies: { p: 'file:../p', q: 'github:a/b' } });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(!ctx.issues.some((i) => i.rule === 'wildcard-dependency'));
});

test('缺 engines → MEDIUM', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT' });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'missing-engines'));
});

test('缺 test script → MEDIUM', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT' });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'missing-test-script'));
});

test('无效 version → HIGH', () => {
  const d = writePkg({ name: 'x', version: '1.0', license: 'MIT' });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'invalid-version' && i.severity === 'high'));
});

test('缺 name → HIGH', () => {
  const d = writePkg({ version: '1.0.0', license: 'MIT' });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'missing-name' && i.severity === 'high'));
});

test('缺失低危字段聚合 score 正确（3 low → -9 → 91）', () => {
  const d = writePkg({
    name: 'x', version: '1.0.0', license: 'MIT', engines: { node: '>=18' },
    repository: { type: 'git', url: 'x' }, scripts: { test: 't' }, description: 'd',
  });
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  const lows = ctx.issues.filter((i) => i.severity === 'low').length;
  assert.strictEqual(lows, 3);
  assert.strictEqual(mod.computeScore(ctx.issues), 91);
});

test('无效 JSON → invalid-json HIGH', () => {
  const d = path.join(TMP, 'bad' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{ bad json');
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'invalid-json'));
});

test('锁文件版本过旧 → LOW lockfile-outdated', () => {
  const d = writePkg({
    name: 'x', version: '1.0.0', license: 'MIT', type: 'commonjs',
    engines: { node: '>=18' }, repository: { type: 'git', url: 'x' },
    scripts: { test: 't' }, description: 'd', author: 'a', keywords: ['a'],
  });
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, packages: {} }));
  const ctx = mod.scanPackageJson(path.join(d, 'package.json'));
  assert.ok(ctx.issues.some((i) => i.rule === 'lockfile-outdated' && i.severity === 'low'));
});

test('isWildcardRange 边界', () => {
  assert.strictEqual(mod.isWildcardRange('*'), true);
  assert.strictEqual(mod.isWildcardRange('1.x'), true);
  assert.strictEqual(mod.isWildcardRange('1.2.*'), true);
  assert.strictEqual(mod.isWildcardRange('latest'), true);
  assert.strictEqual(mod.isWildcardRange(''), true);
  assert.strictEqual(mod.isWildcardRange('^1.2.3'), false);
  assert.strictEqual(mod.isWildcardRange('~1.2.3'), false);
  assert.strictEqual(mod.isWildcardRange('>=1.0.0'), false);
  assert.strictEqual(mod.isWildcardRange('1.2.3'), false);
  assert.strictEqual(mod.isWildcardRange('workspace:*'), false);
  assert.strictEqual(mod.isWildcardRange('file:../x'), false);
});

test('SEMVER_RE 边界', () => {
  assert.ok(mod.SEMVER_RE.test('1.0.0'));
  assert.ok(mod.SEMVER_RE.test('1.2.3-beta.1'));
  assert.ok(mod.SEMVER_RE.test('1.0.0+build.5'));
  assert.ok(!mod.SEMVER_RE.test('1.0'));
  assert.ok(!mod.SEMVER_RE.test('v1.0.0'));
  assert.ok(!mod.SEMVER_RE.test('1.0.0.0'));
});

// ---- CLI 端到端 ----
test('CLI: --fail-on-high 有 HIGH → exit 2', () => {
  const d = writePkg({ name: 'x', version: '1.0.0' }); // 缺 license → high
  const r = runCli([d, '--fail-on-high', '--quiet']);
  assert.strictEqual(r.code, 2);
});

test('CLI: 干净包 --fail-on-high → exit 0', () => {
  const d = writePkg({
    name: 'x', version: '1.0.0', license: 'MIT', type: 'commonjs',
    engines: { node: '>=18' }, repository: { type: 'git', url: 'x' },
    scripts: { test: 't' }, description: 'd', author: 'a', keywords: ['a'],
  });
  const r = runCli([d, '--fail-on-high', '--quiet']);
  assert.strictEqual(r.code, 0);
});

test('CLI: --max-high 非整数 → exit 2', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT' });
  const r = runCli([d, '--max-high', 'abc']);
  assert.strictEqual(r.code, 2);
});

test('CLI: --json 输出含 score=100', () => {
  const d = writePkg({
    name: 'x', version: '1.0.0', license: 'MIT', type: 'commonjs',
    engines: { node: '>=18' }, repository: { type: 'git', url: 'x' },
    scripts: { test: 't' }, description: 'd', author: 'a', keywords: ['a'],
  });
  const r = runCli([d, '--json']);
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(r.out);
  assert.strictEqual(j.score, 100);
  assert.strictEqual(j.counts.total, 0);
});

test('CLI: 目录缺 package.json（read-error HIGH）+ --fail-on-high → exit 2', () => {
  const d = path.join(TMP, 'empty' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  const r = runCli([d, '--fail-on-high', '--quiet']);
  assert.strictEqual(r.code, 2);
});

test('CLI: 未知选项 → exit 2', () => {
  const d = writePkg({ name: 'x', version: '1.0.0', license: 'MIT' });
  const r = runCli([d, '--nope']);
  assert.strictEqual(r.code, 2);
});

test('CLI: --min-score 低于阈值 → exit 2', () => {
  const d = writePkg({ name: 'x', version: '1.0.0' }); // 多个 high → score 低
  const r = runCli([d, '--min-score', '95', '--quiet']);
  assert.strictEqual(r.code, 2);
});

test('parseArgs 三类分离', () => {
  const o = mod.parseArgs(['--max-high', '3', '--fail-on-high', '--json', '.']);
  assert.strictEqual(o.maxHigh, 3);
  assert.strictEqual(o.failOnHigh, true);
  assert.strictEqual(o.json, true);
  assert.strictEqual(o.target, '.');
});

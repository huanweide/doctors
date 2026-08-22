'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSemver, cmpSemver, isValidSemver, computeScore, scan, parseArgs } = require('./index.js');

// ---- 纯函数 ----
test('parseSemver 正常/带 v/预发布/非法', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null, raw: '1.2.3' });
  assert.deepEqual(parseSemver('v1.0.0'), { major: 1, minor: 0, patch: 0, pre: null, raw: 'v1.0.0' });
  assert.deepEqual(parseSemver('1.0.0-beta.1').pre, 'beta.1');
  assert.equal(parseSemver('1.0'), null);
  assert.equal(parseSemver('abc'), null);
  assert.equal(parseSemver('1.2.3.4'), null);
  assert.equal(parseSemver(''), null);
});

test('cmpSemver 排序与预发布', () => {
  assert.equal(cmpSemver(parseSemver('1.0.0'), parseSemver('1.0.1')), -1);
  assert.equal(cmpSemver(parseSemver('1.1.0'), parseSemver('1.0.9')), 1);
  assert.equal(cmpSemver(parseSemver('2.0.0'), parseSemver('1.9.9')), 1);
  assert.equal(cmpSemver(parseSemver('1.0.0'), parseSemver('1.0.0')), 0);
  assert.equal(cmpSemver(parseSemver('1.0.0'), parseSemver('1.0.0-beta.1')), 1); // 正式 > 预发布
  assert.equal(cmpSemver(parseSemver('1.0.0-alpha'), parseSemver('1.0.0-beta')), -1);
});

test('isValidSemver', () => {
  assert.equal(isValidSemver('1.2.3'), true);
  assert.equal(isValidSemver('v1.0.0'), true);
  assert.equal(isValidSemver('1.0'), false);
});

test('computeScore 扣分与封底', () => {
  assert.equal(computeScore([]), 100);
  assert.equal(computeScore([{ severity: 'high' }]), 80);
  assert.equal(computeScore([{ severity: 'high' }, { severity: 'medium' }]), 68);
  assert.equal(computeScore([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }]), 62);
  const many = Array.from({ length: 10 }, () => ({ severity: 'high' }));
  assert.equal(computeScore(many), 0);
});

test('parseArgs 三类标志解析', () => {
  const o = parseArgs(['--root', '/x', '--fail-on-high', '--json', '--min-score', '80']);
  assert.equal(o.root, '/x');
  assert.equal(o.failOnHigh, true);
  assert.equal(o.json, true);
  assert.equal(o.minScore, 80);
});

// ---- git 仓库辅助 ----
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reldoctor-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  return dir;
}
function commit(dir, msg) {
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', msg], { cwd: dir });
}
function tag(dir, t) {
  execFileSync('git', ['tag', t], { cwd: dir });
}
function writePkg(dir, ver) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: ver }, null, 2));
}
function writeChangelog(dir, content) {
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), content);
}
const CLEAN_CL = '# Changelog\n\n## Unreleased\n\n## [1.0.0]\n\n- first\n';

function has(issues, id) {
  return issues.find((i) => i.id === id);
}

// ---- 集成：干净仓库得满分 ----
test('干净仓库：version==tag==CHANGELOG 三者一致，0 问题，健康分 100', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  writeChangelog(dir, CLEAN_CL);
  const r = scan(dir);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal(r.score, 100);
});

// ---- 各红点 ----
test('R1 version-tag-mismatch 高危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.1.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  writeChangelog(dir, '# Changelog\n\n## Unreleased\n\n## [1.1.0]\n\n- up\n');
  const r = scan(dir);
  const it = has(r.issues, 'version-tag-mismatch');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'high');
});

test('R2 untagged-commits 高危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  commit(dir, 'more work'); // tag 之后还有提交
  writeChangelog(dir, CLEAN_CL);
  const r = scan(dir);
  const it = has(r.issues, 'untagged-commits');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'high');
});

test('R3 changelog-missing-version 中危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  writeChangelog(dir, '# Changelog\n\n## Unreleased\n\n## [0.9.0]\n\n- old\n');
  const r = scan(dir);
  const it = has(r.issues, 'changelog-missing-version');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'medium');
});

test('R4 version-not-semver 中危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0'); // 缺 patch 字段
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  const r = scan(dir);
  const it = has(r.issues, 'version-not-semver');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'medium');
});

test('never-released 低危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0.0');
  commit(dir, 'init');
  writeChangelog(dir, CLEAN_CL);
  const r = scan(dir);
  const it = has(r.issues, 'never-released');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'low');
});

test('no-changelog 低危', () => {
  const dir = mkRepo();
  writePkg(dir, '1.0.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  const r = scan(dir);
  const it = has(r.issues, 'no-changelog');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'low');
});

test('tag-prefix-inconsistent 低危', () => {
  const dir = mkRepo();
  writePkg(dir, '2.0.0');
  commit(dir, 'init');
  tag(dir, 'v1.0.0');
  tag(dir, '2.0.0');
  writeChangelog(dir, '# Changelog\n\n## Unreleased\n\n## [2.0.0]\n\n- up\n');
  const r = scan(dir);
  const it = has(r.issues, 'tag-prefix-inconsistent');
  assert.ok(it, JSON.stringify(r.issues));
  assert.equal(it.severity, 'low');
});

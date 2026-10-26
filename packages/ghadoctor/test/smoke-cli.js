'use strict';

// ghadoctor 冒烟测试：用真实子进程验证「退出码契约 + --json 可用性 + 门禁三态」。
// 家族铁律（第 7.2 / 10.7 轮）：process.exit 只被 spawn 级测试真正验到，
// 单测 require 不到进程退出码，monkey-patch 会得到恒 null 的假绿。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'index.js');

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, both: (r.stdout || '') + (r.stderr || '') };
}

function makeWF(content, name = 'ci.yml') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-smoke-'));
  const wfDir = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, name), content);
  return dir;
}

const BAD_WF = `name: ci
on: push
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "\${{ github.event.issue.title }}"
`;
const GOOD_WF = `name: ci
on: push
permissions: {}
concurrency:
  group: ci
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
      - run: npm ci
`;

test('报告模式（无门禁）：rc=0，且始终打印门禁状态行', () => {
  const dir = makeWF(BAD_WF);
  const r = run(['--root', dir]);
  assert.equal(r.code, 0);
  assert.ok(/CI 门禁: 未启用/.test(r.out), '未配置阈值时应打印「未启用」而非「通过」');
  assert.ok(!/CI 门禁: PASS/.test(r.out), '未配置阈值绝不得谎报 PASS');
});

test('门禁 FAIL：--fail-on-high 命中 HIGH → rc=2，且 JSON gate.state=fail', () => {
  const dir = makeWF(BAD_WF);
  const r = run(['--root', dir, '--json', '--fail-on-high']);
  assert.equal(r.code, 2, '命中 HIGH 必须 rc=2');
  const j = JSON.parse(r.out);
  assert.equal(j.gate.state, 'fail');
  assert.equal(j.gate.configured, true);
  assert.equal(j.gate.passed, false);
});

test('门禁 PASS：干净工作流 + --fail-on-high → rc=0，gate.state=pass', () => {
  const dir = makeWF(GOOD_WF);
  const r = run(['--root', dir, '--json', '--fail-on-high']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.gate.state, 'pass');
  assert.equal(j.gate.passed, true);
  assert.equal(j.summary.score, 100);
  assert.equal(j.summary.basisComplete, true);
});

test('有害指标：空目录 + 配置了门禁 → rc=3（inconclusive），score=null，绝不给满分', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-empty-'));
  const r = run(['--root', dir, '--json', '--max-high', '0']);
  assert.equal(r.code, 3, '输入为空且配了门禁必须 rc=3（结论不可信）');
  const j = JSON.parse(r.out);
  assert.equal(j.summary.basisComplete, false);
  assert.equal(j.summary.score, null, '空扫描健康分必须 null，不得给 100 这种虚假满分');
  assert.equal(j.gate.state, 'inconclusive');
});

test('有害指标（文本）：空目录 + 门禁 → 输出「无法评估」而非「100」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-empty2-'));
  const r = run(['--root', dir, '--max-high', '0']);
  assert.equal(r.code, 3);
  assert.ok(/无法评估/.test(r.out), '空扫描文本必须明示无法评估');
  assert.ok(!/总体健康分: 100/.test(r.out), '不得给虚假满分 100');
});

test('参数容错：未知选项 → rc=2', () => {
  const dir = makeWF(GOOD_WF);
  const r = run(['--root', dir, '--totally-unknown']);
  assert.equal(r.code, 2);
});

test('参数容错：--max-high abc（NaN）→ rc=2', () => {
  const dir = makeWF(GOOD_WF);
  const r = run(['--root', dir, '--max-high', 'abc']);
  assert.equal(r.code, 2);
});

test('参数容错：--max-high 空串 → rc=2', () => {
  const dir = makeWF(GOOD_WF);
  const r = run(['--root', dir, '--max-high', '']);
  assert.equal(r.code, 2);
});

test('--json 输出必须是可解析 JSON（无截断）', () => {
  const dir = makeWF(GOOD_WF);
  const r = run(['--root', dir, '--json']);
  assert.equal(r.code, 0);
  let j;
  assert.doesNotThrow(() => { j = JSON.parse(r.out); });
  assert.ok(Array.isArray(j.files));
  assert.ok('gate' in j && 'summary' in j);
});

test('--help → rc=0 且打印用法', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.ok(/用法/.test(r.out) || /用法/.test(r.err));
});

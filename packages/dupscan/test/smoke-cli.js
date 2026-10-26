'use strict';
// dupscan spawn 级冒烟测试：真实起进程，验证**退出码契约**。
// 为什么必须有这一层：node --test 的单测只测导出的函数，根本不碰 process.exitCode。
// 家族历史事故——改退出码时单测全绿，只有 spawn 拦得住。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(path.resolve(__dirname, '..'), 'index.js');

function run(args) {
  const r = spawnSync('node', [INDEX, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 造一个确有重复块的项目：两个文件内容完全相同
function dupProject(prefix) {
  const d = tmpdir(prefix);
  const body = Array.from({ length: 9 }, (_, i) => 'line' + i + '();').join('\n') + '\n';
  fs.writeFileSync(path.join(d, 'a.js'), body);
  fs.writeFileSync(path.join(d, 'b.js'), body);
  return d;
}

// ---- 三态门禁：本工具唯一的价值，必须在进程级锁死 ----

test('smoke: empty dir + gate configured -> rc 3, never rc 0', () => {
  const d = tmpdir('dupscan-smoke-empty-');
  const r = run(['--root', d, '--max-issues', '0']);
  assert.strictEqual(r.code, 3, `空输入必须是 inconclusive(rc=3)，实际 rc=${r.code}：${r.stdout}`);
  assert.ok(r.stdout.includes('inconclusive'), '文本输出必须说明无法判定');
});

test('smoke: empty dir + gate params -> rc 3 even with --fail-on-high (核心假绿灯)', () => {
  // 历史缺陷：显式传了门禁参数，空输入照样 rc=0 —— 用户的门禁配置完全是摆设
  const d = tmpdir('dupscan-smoke-emptygate-');
  const r = run(['--root', d, '--max-issues', '0', '--max-lines', '0', '--fail-on-high']);
  assert.strictEqual(r.code, 3, r.stdout);
});

test('smoke: empty dir + --json -> gate.state inconclusive, basisComplete false', () => {
  const d = tmpdir('dupscan-smoke-emptyj-');
  const r = run(['--root', d, '--json', '--max-issues', '0']);
  assert.strictEqual(r.code, 3);
  const j = JSON.parse(r.stdout); // stdout 必须完整未被截断
  assert.strictEqual(j.gate.state, 'inconclusive');
  assert.strictEqual(j.basisComplete, false);
});

test('smoke: no gate thresholds at all -> rc 3', () => {
  const d = dupProject('dupscan-smoke-nogate-');
  const r = run(['--root', d]);
  assert.strictEqual(r.code, 3, '未配门禁阈值时不得返回 0');
  assert.ok(r.stdout.includes('未配置'), '应说明未配门禁');
});

test('smoke: gate configured + violation -> rc 2 (家族统一契约)', () => {
  const d = dupProject('dupscan-smoke-bad-');
  const r = run(['--root', d, '--max-issues', '0']);
  assert.strictEqual(r.code, 2, '历史实现退 1，与家族约定 2 不一致');
});

test('smoke: gate configured + within limits -> rc 0', () => {
  const d = dupProject('dupscan-smoke-good-');
  const r = run(['--root', d, '--max-issues', '50']);
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('pass'));
});

test('smoke: --max-lines gate works and fails -> rc 2', () => {
  const d = dupProject('dupscan-smoke-maxlines-');
  const r = run(['--root', d, '--max-lines', '0']);
  assert.strictEqual(r.code, 2);
});

// ---- 参数容错：门禁参数写错 = 门禁不存在，必须退 2 ----

test('smoke: unknown option -> rc 2', () => {
  assert.strictEqual(run(['--bogus']).code, 2);
});

test('smoke: --root with missing value -> rc 2 (no node internal message)', () => {
  const r = run(['--root']);
  assert.strictEqual(r.code, 2);
  assert.ok(!r.stderr.includes('must be of type string'), `不该泄漏 node 内部报错：${r.stderr}`);
  assert.ok(!r.stderr.includes('undefined'), `不该泄漏 undefined：${r.stderr}`);
});

test('smoke: --root must not swallow the following flag -> rc 2', () => {
  const r = run(['--root', '--json']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('--root'), r.stderr);
});

test('smoke: numeric flag missing value -> rc 2', () => {
  assert.strictEqual(run(['--max-issues']).code, 2);
});

test('smoke: trailing-garbage numeric flag -> rc 2 (parseInt would silently take 5)', () => {
  // 历史缺陷：parseInt('5abc') === 5 → 拼错的门禁值被静默截断，门禁根本没生效
  const d = dupProject('dupscan-smoke-nan-');
  const r = run(['--root', d, '--max-issues', '5abc']);
  assert.strictEqual(r.code, 2, 'parseInt 静默截断 = 门禁形同虚设：' + r.stderr);
});

test('smoke: empty string numeric value -> rc 2', () => {
  const d = dupProject('dupscan-smoke-empty-');
  assert.strictEqual(run(['--root', d, '--max-issues', '']).code, 2);
});

test('smoke: non-integer numeric flag -> rc 2', () => {
  const d = dupProject('dupscan-smoke-frac-');
  assert.strictEqual(run(['--root', d, '--max-issues', '1.5']).code, 2);
});

test('smoke: --min-lines 0 -> rc 2 (would degenerate n-gram into empty string)', () => {
  const d = dupProject('dupscan-smoke-minl-');
  const r = run(['--root', d, '--min-lines', '0']);
  assert.strictEqual(r.code, 2, r.stderr);
});

test('smoke: --min-lines negative -> rc 2', () => {
  const d = dupProject('dupscan-smoke-minlneg-');
  assert.strictEqual(run(['--root', d, '--min-lines', '-3']).code, 2);
});

test('smoke: negative --max-issues -> rc 2', () => {
  const d = dupProject('dupscan-smoke-neg-');
  assert.strictEqual(run(['--root', d, '--max-issues', '-1']).code, 2);
});

test('smoke: nonexistent root -> rc 2', () => {
  assert.strictEqual(run(['--root', path.join(os.tmpdir(), 'definitely-missing-xyz')]).code, 2);
});

// ---- stdout 完整性 ----

test('smoke: --json stdout is complete and parseable on gate failure', () => {
  const d = tmpdir('dupscan-smoke-json-');
  const body = Array.from({ length: 9 }, (_, i) => 'line' + i + '();').join('\n') + '\n';
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(d, `f${i}.js`), body + `\nunique${i}();\n`);
  }
  const r = run(['--root', d, '--json', '--max-issues', '0']);
  assert.strictEqual(r.code, 2);
  const j = JSON.parse(r.stdout); // process.exit() 截断 stdout 会让这里抛错
  assert.ok(j.duplicateBlocks > 0);
  assert.strictEqual(j.gate.state, 'fail');
  assert.strictEqual(j.basisComplete, true);
});

// ---- 排除规则 ----

test('smoke: real dist/ dir is excluded, src/ retained', () => {
  const d = tmpdir('dupscan-smoke-excl-');
  fs.mkdirSync(path.join(d, 'dist'));
  fs.mkdirSync(path.join(d, 'src'));
  const body = Array.from({ length: 9 }, (_, i) => 'x' + i + '();').join('\n') + '\n';
  fs.writeFileSync(path.join(d, 'dist', 'a.js'), body);
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const only = 1;\n');
  const r = run(['--root', d, '--json', '--max-issues', '50']);
  assert.strictEqual(JSON.parse(r.stdout).scanned, 1, 'dist/ 应排除，src/ 应保留');
});

test('smoke: filename containing dist/build is still scanned', () => {
  const d = tmpdir('dupscan-smoke-substr-');
  fs.writeFileSync(path.join(d, 'distribution.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(d, 'rebuild.js'), 'const b = 2;\n');
  const r = run(['--root', d, '--json', '--max-issues', '50']);
  assert.strictEqual(JSON.parse(r.stdout).scanned, 2, '名字带 dist/build 的源码不应被跳过');
});

// ---- --help / --version ----

test('smoke: --help exits 0 and documents the three exit codes', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('inconclusive'), '帮助应说明三态');
  assert.ok(r.stdout.includes('| 3 inconclusive'));
});

test('smoke: --version exits 0 and matches package.json', () => {
  const r = run(['--version']);
  assert.strictEqual(r.code, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'package.json'), 'utf8'));
  assert.ok(r.stdout.includes(pkg.version), `CLI 版本与 package.json(${pkg.version}) 漂移：${r.stdout}`);
});

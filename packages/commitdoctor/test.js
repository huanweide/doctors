'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, lintCommit, computeScore, readCommits, VERSION } = require('./index.js');

const baseOpts = { path: process.cwd(), maxCommits: 50, maxSubjectLen: 72, ignoreMerges: false, json: false, checkEmoji: true };
const mk = (over = {}) => Object.assign({}, baseOpts, over);
const c = (over = {}) => Object.assign({ hash: 'abc1234', author: 't', at: '0', subject: '', body: '', raw: '' }, over);

test('版本号存在', () => { assert.ok(/^\d+\.\d+\.\d+$/.test(VERSION)); });

test('空主题 -> empty-subject(high)', () => {
  const issues = lintCommit(c({ subject: '   ' }), mk());
  const hit = issues.find(i => i.rule === 'empty-subject');
  assert.ok(hit && hit.severity === 'high');
});

test('主题超 100 字符 -> subject-too-long(high)', () => {
  const s = 'x'.repeat(101);
  const issues = lintCommit(c({ subject: s }), mk());
  assert.ok(issues.find(i => i.rule === 'subject-too-long' && i.severity === 'high'));
});

test('主题 72-100 字符 -> subject-long(medium)', () => {
  const s = 'x'.repeat(80);
  const issues = lintCommit(c({ subject: s }), mk());
  assert.ok(issues.find(i => i.rule === 'subject-long' && i.severity === 'medium'));
});

test('主题末尾句号 -> low', () => {
  const issues = lintCommit(c({ subject: 'fix login bug.' }), mk());
  assert.ok(issues.find(i => i.rule === 'subject-trailing-period' && i.severity === 'low'));
});

test('主题前导空格 -> low', () => {
  const issues = lintCommit(c({ subject: '  fix bug' }), mk());
  assert.ok(issues.find(i => i.rule === 'subject-leading-space'));
});

test('TODO 标记 -> medium', () => {
  const issues = lintCommit(c({ subject: 'wip feature', body: 'TODO clean up later' }), mk());
  assert.ok(issues.find(i => i.rule === 'has-todo-marker' && i.severity === 'medium'));
});

test('疑似密钥 -> high', () => {
  const issues = lintCommit(c({ subject: 'add config', body: 'api_key=abcdefgh123456' }), mk());
  assert.ok(issues.find(i => i.rule === 'has-secret' && i.severity === 'high'));
});

test('私钥块 -> high', () => {
  const issues = lintCommit(c({ subject: 'x', body: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }), mk());
  assert.ok(issues.find(i => i.rule === 'has-secret'));
});

test('草稿标记 -> low', () => {
  const issues = lintCommit(c({ subject: 'TMP save', body: 'DEBUG here' }), mk());
  assert.ok(issues.find(i => i.rule === 'draft-markers'));
});

test('合并提交无描述 -> low', () => {
  const issues = lintCommit(c({ subject: 'Merge branch main', body: '' }), mk());
  assert.ok(issues.find(i => i.rule === 'merge-no-desc'));
});

test('ignore-merges 跳过合并提交检测 merge-no-desc', () => {
  const issues = lintCommit(c({ subject: 'Merge branch main', body: '' }), mk({ ignoreMerges: true }));
  assert.ok(!issues.find(i => i.rule === 'merge-no-desc'));
});

test('正文缺空行分隔 -> low', () => {
  const raw = 'subject line\nbody line no blank';
  const issues = lintCommit(c({ subject: 'subject line', body: 'body line no blank', raw }), mk());
  assert.ok(issues.find(i => i.rule === 'no-body-separator'));
});

test('emoji 默认检测 -> low；--no-check-emoji 关闭', () => {
  const on = lintCommit(c({ subject: 'fix 🐛 bug' }), mk({ checkEmoji: true }));
  assert.ok(on.find(i => i.rule === 'subject-emoji'));
  const off = lintCommit(c({ subject: 'fix 🐛 bug' }), mk({ checkEmoji: false }));
  assert.ok(!off.find(i => i.rule === 'subject-emoji'));
});

test('非标准类型前缀 -> low', () => {
  const issues = lintCommit(c({ subject: 'Fixed: login' }), mk());
  assert.ok(issues.find(i => i.rule === 'non-standard-type'));
});

test('干净提交零问题', () => {
  const issues = lintCommit(c({ subject: 'feat: add retry logic', body: '\nRetry on 503.' }), mk());
  assert.strictEqual(issues.length, 0);
});

test('健康分权重计算', () => {
  const issues = [
    { severity: 'high' }, { severity: 'high' },
    { severity: 'medium' }, { severity: 'low' },
  ];
  assert.strictEqual(computeScore(issues), 100 - (3 + 3 + 2 + 1));
});

test('parseArgs 阈值非整数 -> exit 2（通过抛错验证 Number.isFinite 校验）', () => {
  // 直接验证 NUM_FLAGS 解析逻辑：NaN 分支会 process.exit(2)
  const realExit = process.exit;
  let code = null;
  process.exit = (n) => { code = n; throw new Error('exit:' + n); };
  try {
    parseArgs(['--max-high', 'abc']);
  } catch (e) { /* 预期抛错 */ }
  process.exit = realExit;
  assert.strictEqual(code, 2);
});

// 端到端：真实临时 git 仓库
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitdoctor-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.com']);
  run(['config', 'user.name', 'tester']);
  const commit = (msg) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), String(Math.random()));
    run(['add', '-A']);
    run(['commit', '-q', '-m', msg]);
  };
  commit('feat: initial commit\n\nAdd base.');           // 干净
  commit('fix bug.');                                       // 句末句号 low
  commit('api_key=abcdefgh123456');                         // 密钥 high
  commit('WIP stuff');                                       // 草稿 low（WIP 在 TODO 集）
  return dir;
}

test('端到端：真实仓库扫描命中已知问题', () => {
  const dir = makeRepo();
  const commits = readCommits(mk({ path: dir, maxCommits: 50 }));
  assert.strictEqual(commits.length, 4);
  const all = [];
  for (const cc of commits) all.push(...lintCommit(cc, mk({ path: dir })));
  assert.ok(all.find(i => i.rule === 'subject-trailing-period'));
  assert.ok(all.find(i => i.rule === 'has-secret'));
  assert.ok(all.find(i => i.rule === 'has-todo-marker')); // WIP
  fs.rmSync(dir, { recursive: true, force: true });
});

test('端到端：非 git 目录 -> readCommits 退出码 1', () => {
  const realExit = process.exit;
  let code = null;
  process.exit = (n) => { code = n; throw new Error('exit'); };
  try { readCommits(mk({ path: os.tmpdir() })); } catch (e) { /* */ }
  process.exit = realExit;
  assert.strictEqual(code, 1);
});

test('readCommits 返回的 hash 不含换行污染（tformat 修复）', () => {
  const dir = makeRepo();
  const commits = readCommits(mk({ path: dir, maxCommits: 50 }));
  assert.ok(commits.length >= 1);
  for (const cc of commits) {
    assert.ok(!cc.hash.includes('\n'), `hash 含换行: ${JSON.stringify(cc.hash)}`);
    assert.strictEqual(cc.hash, cc.hash.trim());
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI --fail-on-high 对含 high 仓库退出码 1', () => {
  const dir = makeRepo(); // 含 api_key=... high 问题
  const r = spawnSync(process.execPath, ['index.js', '-p', dir, '--fail-on-high'], { cwd: __dirname, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI --no-check-emoji 不报未知标志且关闭 emoji 检测', () => {
  const dir = makeRepo();
  const r = spawnSync(process.execPath, ['index.js', '-p', dir, '--no-check-emoji', '--json'], { cwd: __dirname, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('subject-emoji'));
  fs.rmSync(dir, { recursive: true, force: true });
});

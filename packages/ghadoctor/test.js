'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanWorkflow, scoreFile, parseArgs, findWorkflowFiles } = require('./index.js');

// 临时工作流文件
function writeWF(content, name = 'ci.yml') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-'));
  const wfDir = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const p = path.join(wfDir, name);
  fs.writeFileSync(p, content);
  return p;
}

function rulesOf(content, name) {
  return scanWorkflow(writeWF(content, name)).map((i) => i.rule);
}
function has(content, rule, name) {
  return rulesOf(content, name).includes(rule);
}

test('unpinned-action: 可变引用 @v4 报 high', () => {
  const c = `name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  assert.ok(has(c, 'unpinned-action'));
});

test('unpinned-action: SHA pin 不报', () => {
  const c = `name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n`;
  assert.ok(!has(c, 'unpinned-action'));
});

test('unpinned-action: @main / @latest / @stable 均报', () => {
  assert.ok(has(`steps:\n  - uses: foo/bar@main\n`, 'unpinned-action'));
  assert.ok(has(`steps:\n  - uses: foo/bar@latest\n`, 'unpinned-action'));
  assert.ok(has(`steps:\n  - uses: foo/bar@stable\n`, 'unpinned-action'));
});

test('script-injection: run 步插值 github.event 报 high', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ github.event.issue.title }}"\n`;
  assert.ok(has(c, 'script-injection'));
});

test('script-injection: 普通 run 不报', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci && npm test\n`;
  assert.ok(!has(c, 'script-injection'));
});

test('broad-permissions: write-all 报 high', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions: write-all\n    steps:\n      - run: echo hi\n`;
  assert.ok(has(c, 'broad-permissions'));
});

test('pr-target-checkout: pull_request_target + checkout 报 high', () => {
  const c = `on:\n  pull_request_target:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  assert.ok(has(c, 'pr-target-checkout'));
});

test('pr-target-checkout: 普通 push 触发不报', () => {
  const c = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  assert.ok(!has(c, 'pr-target-checkout'));
});

test('missing-permissions: 无 permissions 报 medium', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  assert.ok(has(c, 'missing-permissions'));
});

test('missing-permissions: 显式 permissions: {} 不报', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions: {}\n    steps:\n      - run: echo hi\n`;
  assert.ok(!has(c, 'missing-permissions'));
});

test('hardcoded-secret: env 下裸密码报 medium（排除 \${{ secrets.* }}）', () => {
  const c = `jobs:\n  build:\n    env:\n      TOKEN: ghp_EXAMPLE_FAKE_TOKEN_FOR_TEST_PURPOSES_ONLY\n    steps:\n      - run: echo hi\n`;
  assert.ok(has(c, 'hardcoded-secret'));
});

test('hardcoded-secret: \${{ secrets.X }} 引用不报', () => {
  const c = `jobs:\n  build:\n    env:\n      TOKEN: \${{ secrets.GITHUB_TOKEN }}\n    steps:\n      - run: echo hi\n`;
  assert.ok(!has(c, 'hardcoded-secret'));
});

test('no-timeout: 无 timeout-minutes 报 low', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  assert.ok(has(c, 'no-timeout'));
});

test('no-timeout: 有 timeout-minutes 不报', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo hi\n`;
  assert.ok(!has(c, 'no-timeout'));
});

test('no-concurrency: 无 concurrency 报 low', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  assert.ok(has(c, 'no-concurrency'));
});

test('no-concurrency: 有 concurrency 不报', () => {
  const c = `concurrency:\n  group: ci-\${{ github.ref }}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  assert.ok(!has(c, 'no-concurrency'));
});

test('scoreFile: 单 high 扣分 15', () => {
  assert.equal(scoreFile([{ severity: 'high' }]), 85);
});

test('scoreFile: 多问题封底 0', () => {
  const many = Array.from({ length: 10 }, () => ({ severity: 'high' }));
  assert.equal(scoreFile(many), 0);
});

test('干净工作流: 健康分 100 且无问题', () => {
  const c = `name: ci\non: push\npermissions: {}\nconcurrency:\n  group: ci\njobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n      - run: npm ci\n`;
  const issues = scanWorkflow(writeWF(c));
  assert.equal(issues.length, 0);
  assert.equal(scoreFile(issues), 100);
});

test('去重: 同规则同行不重复计', () => {
  const c = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/checkout@v4\n`;
  const rules = scanWorkflow(writeWF(c)).filter((i) => i.rule === 'unpinned-action');
  assert.equal(rules.length, 2); // 不同行，各自独立（不是去重目标）
});

test('findWorkflowFiles: 发现 .github/workflows 下 yml/yaml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-find-'));
  const wfDir = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'a.yml'), 'on: push\n');
  fs.writeFileSync(path.join(wfDir, 'b.yaml'), 'on: push\n');
  fs.writeFileSync(path.join(wfDir, 'README.md'), 'x');
  const found = findWorkflowFiles(dir);
  assert.equal(found.length, 2);
});

test('findWorkflowFiles: 无 workflows 目录返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-empty-'));
  assert.equal(findWorkflowFiles(dir).length, 0);
});

test('parseArgs: 默认 root=cwd', () => {
  const o = parseArgs([]);
  assert.equal(o.root, process.cwd());
  assert.equal(o.json, false);
  assert.equal(o.maxHigh, Infinity);
});

test('parseArgs: --root / --json / --max-high 解析', () => {
  const o = parseArgs(['--root', '/tmp/x', '--json', '--max-high', '3']);
  assert.equal(o.root, '/tmp/x');
  assert.equal(o.json, true);
  assert.equal(o.maxHigh, 3);
});

test('parseArgs: --fail-on-high 置 true', () => {
  const o = parseArgs(['--fail-on-high']);
  assert.equal(o.failOnHigh, true);
});

test('parseArgs: --min-score 解析为数值', () => {
  const o = parseArgs(['--min-score', '80']);
  assert.equal(o.minScore, 80);
});

test('scanWorkflow: 超大文件(>5MB)跳过不崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghadoctor-big-'));
  const wfDir = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const p = path.join(wfDir, 'big.yml');
  fs.writeFileSync(p, 'a'.repeat(6 * 1024 * 1024));
  assert.deepEqual(scanWorkflow(p), []);
});

// ---- 参数容错（家族第 10.4 轮：NaN 静默传播 / 未知选项静默吞 / 缺值）----
// parseArgs 在用法错误时抛 isUsage 异常（由 main 捕获后退出码 2），单测直接断言抛异常。

test('parseArgs: --max-high abc 必须报错（NaN 静默传播坑）', () => {
  assert.throws(() => parseArgs(['--max-high', 'abc']), /整数参数/);
});

test('parseArgs: --max-high 空串必须报错（Number("")=0 静默通过坑）', () => {
  assert.throws(() => parseArgs(['--max-high', '']), /整数参数/);
});

test('parseArgs: --max-high 2.5 必须报错（小数让门禁静默失效坑）', () => {
  assert.throws(() => parseArgs(['--max-high', '2.5']), /整数参数/);
});

test('parseArgs: --min-score -1 是合法整数（不做哨兵误判）', () => {
  assert.equal(parseArgs(['--min-score', '-1']).minScore, -1);
});

test('parseArgs: --max-high 3 是合法整数', () => {
  assert.equal(parseArgs(['--max-high', '3']).maxHigh, 3);
});

test('parseArgs: 未知长选项必须报错', () => {
  assert.throws(() => parseArgs(['--totally-unknown']), /未知选项/);
});

test('parseArgs: 未知短标志 -x 必须报错（不能只拦 -- 开头）', () => {
  assert.throws(() => parseArgs(['-x']), /未知选项/);
});

test('parseArgs: --root 缺值必须报错', () => {
  assert.throws(() => parseArgs(['--root']), /缺少路径参数/);
});

test('parseArgs: --root 后接另一个选项必须报缺值（不能把 --json 当目录名吞掉）', () => {
  assert.throws(() => parseArgs(['--root', '--json']), /缺少路径参数/);
});

// ---- 门禁三态 / 有害指标：exit-code 契约由 test/smoke-cli.js 用真实进程验证 ----
// 这里仅覆盖「可被 require 直接验证」的部分：空扫描场景下 summary 由 main 计算，
// 故退出码与 score=null 统一交给 spawn 冒烟测试钉死（避免 monkey-patch process.exit 的假测试）。

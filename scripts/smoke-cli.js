#!/usr/bin/env node
'use strict';

// 统一入口冒烟测试 —— 保证 cli.js 与八个子包不会静默失效
//
// 为什么需要它：run-all-tests.js 只跑各包的 test.js。如果某天有人改了
// cli.js 的子命令映射表（SUBCOMMANDS）或某个包的 bin 路径，test.js 全绿
// 也会通过，但 `doctors repo .` 直接就坏了。这个脚本专门守这条链路。
//
// 它验证三件事：
//   1. 帮助 / 版本 / 未知子命令的退出码符合契约
//   2. 八个子命令每个都能真正启动（不是静默什么都不做）
//   3. 参数原样转发（--json 能被透传到子包）
//
// 运行：node scripts/smoke-cli.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');

// 必须与 cli.js 的 SUBCOMMANDS 保持一致（21 轴）
const EXPECTED_SUBS = [
  'a11y', 'commit', 'dev', 'doc', 'pkg', 'rel', 'repo', 'type',
  'sec', 'cyc', 'dup', 'lit', 'debug', 'debt', 'await', 'chain',
  'gha', 'lic', 'idiot', 'test', 'eng',
];

let failed = 0;
let passed = 0;

function ok(name) {
  passed++;
  console.log('  ok  ' + name);
}

function bad(name, detail) {
  failed++;
  console.error('  FAIL ' + name + '\n       ' + detail);
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// 建一个临时 git 仓库，供依赖 git 的 commitdoctor / repodoctor 使用
function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctors-smoke-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'smoke@example.com');
  g('config', 'user.name', 'Smoke Test');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# smoke\n');
  g('add', '-A');
  g('commit', '-qm', 'chore: initial commit for smoke test');
  return dir;
}

console.log('# 1. 入口契约');

// 无参数 -> 帮助，exit 0
{
  const r = run([]);
  if (r.status === 0 && /子命令/.test(r.stdout)) ok('无参数打印帮助且 exit 0');
  else bad('无参数打印帮助且 exit 0', 'status=' + r.status);
}

// --version -> 只打印版本，exit 0
{
  const r = run(['--version']);
  if (r.status === 0 && /^doctors v/.test(r.stdout.trim())) ok('--version 输出版本号且 exit 0');
  else bad('--version 输出版本号且 exit 0', 'status=' + r.status + ' out=' + JSON.stringify(r.stdout));
}

// --help -> exit 0
{
  const r = run(['--help']);
  if (r.status === 0) ok('--help exit 0');
  else bad('--help exit 0', 'status=' + r.status);
}

// 未知子命令 -> exit 2（区分于成功与门禁失败）
{
  const r = run(['definitely-not-a-real-subcommand']);
  if (r.status === 2) ok('未知子命令 exit 2');
  else bad('未知子命令 exit 2', 'status=' + r.status);
}

console.log('\n# 2. 21 个子命令逐个启动');

// 帮助文本里必须列出全部子命令（防止 SUBCOMMANDS 被误删）
{
  const r = run([]);
  const missing = EXPECTED_SUBS.filter(s => !new RegExp('^\\s+' + s + '\\s', 'm').test(r.stdout));
  if (missing.length === 0) ok('帮助文本包含全部 ' + EXPECTED_SUBS.length + ' 个子命令');
  else bad('帮助文本包含全部 ' + EXPECTED_SUBS.length + ' 个子命令', '缺失: ' + missing.join(', '));
}

const tmpRepo = makeTempGitRepo();

// 各轴的调用形态并不统一（有的吃位置参数，有的必须先选子模式、再用 --root）。
// 这里逐轴钉死正确姿势——顺便当 README 轴索引表命令列的活文档。
function argsFor(sub) {
  if (sub === 'a11y') return [sub, ROOT];
  if (sub === 'dev') return [sub, 'doctor', tmpRepo];
  if (sub === 'cyc') return [sub, 'scan', '--root', tmpRepo];
  if (sub === 'debt') return [sub, 'doctor', '--root', tmpRepo];
  if (sub === 'await') return [sub, 'scan', '--root', tmpRepo];
  if (sub === 'test') return [sub, 'doctor', '--root', tmpRepo];
  return [sub, tmpRepo];
}

try {
  for (const sub of EXPECTED_SUBS) {
    const args = argsFor(sub);
    const r = run(args);
    const out = (r.stdout || '') + (r.stderr || '');

    // 退出码只能是 0 / 1 / 2 —— 不能是 null（信号杀）或 127（找不到命令）
    if (r.status === null) {
      bad('子命令 ' + sub + ' 能启动', '被信号终止，无退出码');
      continue;
    }
    if (r.status === 127) {
      bad('子命令 ' + sub + ' 能启动', '入口文件找不到（exit 127），bin 路径可能坏了');
      continue;
    }
    // 真正跑起来应该产出输出；什么都不输出说明可能是空壳
    if (out.trim().length === 0) {
      bad('子命令 ' + sub + ' 能启动', '无任何输出，疑似空壳');
      continue;
    }
    ok('子命令 ' + sub + ' 能启动（exit ' + r.status + '）');
  }
} finally {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

console.log('\n# 3. 参数转发');

// --json 必须透传到子包（子包独立解析参数，入口不吞）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctors-json-'));
  try {
    const r = run(['type', tmp, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 下面统一断言 */ }
    if (parsed && typeof parsed === 'object') ok('--json 透传到子包且输出可解析');
    else bad('--json 透传到子包且输出可解析', 'stdout 前 120 字: ' + JSON.stringify((r.stdout || '').slice(0, 120)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 不存在的路径 -> exit 2（不是 0）
{
  const r = run(['type', path.join(os.tmpdir(), 'definitely-missing-dir-xyz')]);
  if (r.status === 2) ok('不存在的路径 exit 2');
  else bad('不存在的路径 exit 2', 'status=' + r.status);
}

console.log('\n' + (failed === 0
  ? `ALL SMOKE PASSED (${passed} assertions)`
  : `${failed} SMOKE ASSERTION(S) FAILED`));

process.exit(failed === 0 ? 0 : 1);
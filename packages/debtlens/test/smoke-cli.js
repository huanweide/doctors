#!/usr/bin/env node
'use strict';

/*
 * debtlens spawn 级 CLI 冒烟测试
 *   node test/smoke-cli.js
 *
 * 为什么必须有这个文件：`node --test` / 自写单测只测导出的函数，
 * 根本不碰 process.exitCode —— 改退出码时单测可以全绿而门禁已失效。
 * 本文件用 child_process.spawnSync 真起进程，逐条钉死「什么输入 → 什么退出码」。
 *
 * 反向覆盖：假绿灯四变体
 *   A 空输入谎报通过 / B 门禁参数完全失效 / C 未配门禁也报通过 / D JSON 只有布尔
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'index.js');

let pass = 0;
const failures = [];

function run(args, opts) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) throw r.error;
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function expectRc(name, args, wantRc, opts) {
  opts = opts || {};
  try {
    const r = run(args, opts);
    assert.strictEqual(r.rc, wantRc,
      name + '\n  期望 rc=' + wantRc + ' 实际 rc=' + r.rc +
      '\n  stdout: ' + r.out.slice(-400) + '\n  stderr: ' + r.err.slice(-400));
    if (opts.assertOut) opts.assertOut(r.out, r.err);
    pass++;
    console.log('  [OK] ' + name);
  } catch (e) {
    failures.push({ name, e });
    console.log('  [FAIL] ' + name + '\n         ' + (e && e.message));
  }
}

function expectTrue(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  [FAIL] ' + name + '\n         ' + (e && e.message)); }
}

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-s-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return tmp;
}

const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-blank-'));
const CLEAN = makeProject({
  'src/a.js': 'const x=1;\nmodule.exports=x;\n',
  'src/b.ts': 'export const y: number = 2;\n'
});
const DIRTY = makeProject({
  'src/a.js': '// TODO: a\n// FIXME: b\n// TODO: c\nconst x=1;\n'
});

// ---------------------------------------------------------------------------
// 1. 假绿灯变体 A：空输入 + 配了门禁，必须 inconclusive(3)，绝不能 0
// ---------------------------------------------------------------------------
expectRc('A 空输入 + --max-density 0 → rc=3（不是 0）', ['--root', EMPTY, '--max-density', '0'], 3);
expectRc('A 空输入 + --max-total 0 → rc=3', ['--root', EMPTY, '--max-total', '0'], 3);
expectRc('A 空输入 + --max-weighted 0 → rc=3', ['--root', EMPTY, '--max-weighted', '0'], 3);
expectRc('A 空输入 + --fail-on-tags TODO → rc=3（输入空，不因没命中而通过）',
  ['--root', EMPTY, '--fail-on-tags', 'TODO'], 3);
expectRc('A 空输入 + --fail-on-issues → rc=3（空扫描下 fail 结论不可信，inconclusive 优先于 fail）',
  ['--root', EMPTY, '--fail-on-issues'], 3);

expectTrue('A 空输入 --json 必须 basisComplete=false 且 healthScore=null', () => {
  const r = run(['--root', EMPTY, '--json', '--max-total', '0']);
  const j = JSON.parse(r.out);
  assert.strictEqual(j.files, 0);
  assert.strictEqual(j.basisComplete, false, 'basisComplete 必须 false');
  assert.strictEqual(j.healthScore, null, 'healthScore 必须是 null，不能是 100');
  assert.notStrictEqual(j.healthScore, 100);
  assert.strictEqual(j.verdict, '无法评估');
  assert.strictEqual(j.gate.state, 'inconclusive');
  assert.strictEqual(j.gate.configured, true);
});

// ---------------------------------------------------------------------------
// 2. 假绿灯变体 C：未配门禁，必须 inconclusive(3)
// ---------------------------------------------------------------------------
expectRc('C 未配任何门禁 + 干净项目 → rc=3', ['--root', CLEAN], 3);
expectRc('C 未配任何门禁 + 脏项目 → rc=3', ['--root', DIRTY], 3);
expectTrue('C 未配门禁时 gate.configured=false 且文本不得出现「门禁: 通过」', () => {
  const r = run(['--root', CLEAN]);
  assert.ok(!/门禁: 通过/.test(r.out), '未配门禁绝不能打印「门禁: 通过」，实际输出: ' + r.out);
  assert.ok(/state=inconclusive/.test(r.out), '必须打印 state=inconclusive');
  assert.ok(/configured=false/.test(r.out), '必须打印 configured=false');
});

// ---------------------------------------------------------------------------
// 3. 假绿灯变体 D：JSON 不能只有布尔，必须带 state/configured/reason
// ---------------------------------------------------------------------------
expectTrue('D JSON gate 必须是对象（state+configured+reason），不是布尔', () => {
  const r = run(['--root', DIRTY, '--json', '--max-total', '1']);
  const j = JSON.parse(r.out);
  assert.strictEqual(typeof j.gate, 'object', 'gate 必须是对象');
  assert.notStrictEqual(typeof j.gate, 'boolean');
  assert.strictEqual(j.gate.state, 'fail');
  assert.strictEqual(j.gate.configured, true);
  assert.ok(typeof j.gate.reason === 'string' && j.gate.reason.length > 0, '必须有 reason');
  assert.ok(Array.isArray(j.gate.failures));
  assert.ok(Object.prototype.hasOwnProperty.call(j, 'basisComplete'), '顶层必须有 basisComplete');
});

// ---------------------------------------------------------------------------
// 4. 真实三态：pass / fail
// ---------------------------------------------------------------------------
expectRc('pass：干净项目 + 宽松阈值 → rc=0', ['--root', CLEAN, '--max-total', '100'], 0);
expectRc('fail：脏项目 + --max-total 1 → rc=2', ['--root', DIRTY, '--max-total', '1'], 2);
expectRc('fail：脏项目 + --fail-on-tags FIXME → rc=2', ['--root', DIRTY, '--fail-on-tags', 'FIXME'], 2);
expectRc('fail：干净项目 + --fail-on-tags FIXME → rc=0（无命中）',
  ['--root', CLEAN, '--fail-on-tags', 'FIXME'], 0);
expectRc('pass：阈值恰好等于实际值 → rc=0（严格大于才失败）',
  ['--root', DIRTY, '--max-total', '3'], 0);
expectTrue('pass 时文本也必须显式打印「门禁: 通过」+ state=pass', () => {
  const r = run(['--root', CLEAN, '--max-total', '100']);
  assert.ok(/门禁: 通过/.test(r.out));
  assert.ok(/state=pass/.test(r.out));
});

// ---------------------------------------------------------------------------
// 5. 门禁参数完全失效（变体 B）——每一项都必须真拦
// ---------------------------------------------------------------------------
const badArgs = [
  ['--max-total'], ['--max-total', ''], ['--max-total', '  '],
  ['--max-total', '5abc'], ['--max-total', '2.5'], ['--max-total', '-1'],
  ['--max-total', '1e'], ['--max-total', '0x10'], ['--max-total', '+'],
  ['--max-density'], ['--max-density', ''], ['--max-density', 'abc'],
  ['--max-density', '-0.5'], ['--max-density', 'NaN'], ['--max-density', 'Infinity'],
  ['--max-weighted'], ['--max-weighted', ''], ['--max-weighted', '1.2.3'],
  ['--max-weighted', '--max-total'],
  ['--fail-on-tags'], ['--fail-on-tags', ''], ['--fail-on-tags', '  '],
  ['--fail-on-tags', 'NOTATAG'], ['--fail-on-tags', 'TODO,NOTATAG'],
  ['--fail-on-tags', 'todo2'], ['--fail-on-tags', '--max-total'],
  ['--root'], ['--root', ''], ['--root', '--json'], ['--root', '-x'],
  ['-x'], ['-z'], ['--totally-unknown'], ['--json=1'], ['-'], ['doctor2'], ['stray'],
  ['--max-totl', '5']
];
expectTrue('门禁/路径/未知选项共 ' + badArgs.length + ' 组参数错误全部 rc=2', () => {
  const bad = [];
  for (const argv of badArgs) {
    const r = run(['--root', CLEAN].concat(argv));
    if (r.rc !== 2) bad.push(JSON.stringify(argv) + ' → rc=' + r.rc);
  }
  assert.strictEqual(bad.length, 0, '这些参数错误没有被拦住:\n    ' + bad.join('\n    '));
});
expectTrue('参数错误必须走 stderr 且 stdout 为空（不得半截 JSON）', () => {
  const r = run(['--root', CLEAN, '--json', '--max-total', '5abc']);
  assert.strictEqual(r.rc, 2);
  assert.ok(r.err.trim().length > 0, '必须有 stderr 提示');
  assert.strictEqual(r.out.trim(), '', '参数错误时 stdout 必须干净，实际: ' + r.out);
});

// ---------------------------------------------------------------------------
// 6. 退出码只允许 0/2/3，绝不出现 1（1 保留给运行异常）
// ---------------------------------------------------------------------------
expectTrue('所有上述场景的退出码集合 ⊆ {0,2,3}', () => {
  const seen = new Set();
  const all = [
    ['--root', CLEAN], ['--root', DIRTY], ['--root', EMPTY],
    ['--root', CLEAN, '--max-total', '100'], ['--root', DIRTY, '--max-total', '1'],
    ['--root', EMPTY, '--max-total', '0'], ['--root', DIRTY, '--fail-on-issues'],
    ['--root', CLEAN, '--max-total', '5abc'], ['--version'], ['--help']
  ];
  const badRc = [];
  for (const argv of all) {
    const rc = run(argv).rc;
    seen.add(rc);
    if (rc !== 0 && rc !== 2 && rc !== 3) badRc.push(JSON.stringify(argv) + ' → rc=' + rc);
  }
  assert.strictEqual(badRc.length, 0, '出现非法退出码:\n    ' + badRc.join('\n    '));
  assert.ok(seen.has(0) && seen.has(2) && seen.has(3), '三种状态都应被覆盖，实际只见到 ' + [...seen].join(','));
});

// ---------------------------------------------------------------------------
// 7. --version / --help
// ---------------------------------------------------------------------------
expectRc('--version → rc=0', ['--version'], 0, {
  assertOut: (out) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(out.includes('debtlens ' + pkg.version),
      '--version 版本号必须等于 package.json 的 ' + pkg.version + '，实际: ' + out.trim());
  }
});
expectRc('-V → rc=0', ['-V'], 0);
expectRc('--help → rc=0', ['--help'], 0, {
  assertOut: (out) => {
    assert.ok(/退出码契约/.test(out), 'help 必须说明退出码契约');
    assert.ok(/inconclusive/.test(out), 'help 必须提到 inconclusive');
    assert.ok(/不等于通过/.test(out), 'help 必须强调 inconclusive 不等于通过');
  }
});
expectRc('-h → rc=0', ['-h'], 0);
expectTrue('--help 不得打印门禁通过字样', () => {
  assert.ok(!/门禁: 通过/.test(run(['--help']).out));
});

// ---------------------------------------------------------------------------
// 8. root 校验
// ---------------------------------------------------------------------------
expectRc('root 不存在 → rc=2', ['--root', path.join(os.tmpdir(), 'no-such-dir-xyz-123')], 2);
expectRc('root 是文件而非目录 → rc=2', ['--root', CLI], 2);

// ---------------------------------------------------------------------------
// 9. stdout 完整性（防 process.exit() 截断）
// ---------------------------------------------------------------------------
expectTrue('--json 输出必须是完整可解析 JSON 且含收尾大括号', () => {
  const r = run(['--root', DIRTY, '--json', '--max-total', '1']);
  assert.ok(r.out.trim().startsWith('{'), '必须以 { 开头');
  assert.ok(r.out.trim().endsWith('}'), '必须以 } 结尾（截断会导致解析失败）');
  const j = JSON.parse(r.out);   // 截断的 JSON 会在这里抛
  assert.strictEqual(j.totalTags, 3);
  assert.strictEqual(j.root, path.resolve(DIRTY));
});
expectTrue('大项目 --json 输出不被截断（200 文件）', () => {
  const big = makeProject({});
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(big, 'f' + i + '.js'),
      Array.from({ length: 20 }, (_, k) => '// TODO: item ' + k).join('\n') + '\nconst x' + i + '=1;\n');
  }
  const r = run(['--root', big, '--json', '--max-total', '1']);
  assert.ok(r.out.trim().endsWith('}'), '大输出被截断了');
  const j = JSON.parse(r.out);
  assert.strictEqual(j.files, 200);
  assert.strictEqual(j.totalTags, 4000);
});

// ---------------------------------------------------------------------------
// 10. 退出码契约的变异防逃逸：钉死每条路径的具体数字
// ---------------------------------------------------------------------------
expectTrue('逐条路径钉死退出码：pass=0 / fail=2 / 未配=3 / 空输入=3 / 参数错=2', () => {
  const cases = [
    [['--root', CLEAN, '--max-total', '999'], 0, 'pass'],
    [['--root', DIRTY, '--max-total', '1'], 2, 'fail'],
    [['--root', DIRTY, '--max-total', '0'], 2, 'fail(阈值 0 且有 3 个标记)'],
    [['--root', DIRTY], 3, '未配门禁'],
    [['--root', CLEAN], 3, '未配门禁(干净项目也是 3)'],
    [['--root', EMPTY, '--max-total', '999'], 3, '空输入(阈值极宽松也是 3)'],
    [['--root', EMPTY, '--fail-on-issues'], 3, '空输入+fail-on-issues 仍是 3（输入不可信优先）'],
    [['--root', CLEAN, '--max-total', 'abc'], 2, '参数错'],
    [['--version'], 0, '--version'],
    [['--help'], 0, '--help']
  ];
  const bad = [];
  for (const [argv, want, label] of cases) {
    const r = run(argv);
    if (r.rc !== want) bad.push(label + ': 期望 ' + want + ' 实际 ' + r.rc);
  }
  assert.strictEqual(bad.length, 0, '退出码契约漂移:\n    ' + bad.join('\n    '));
});

// ---------------------------------------------------------------------------
console.log('\ndebtlens spawn 级冒烟：' + pass + ' 项通过，' + failures.length + ' 项失败');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.e && f.message));
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}

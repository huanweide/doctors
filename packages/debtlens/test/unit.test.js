#!/usr/bin/env node
'use strict';

/*
 * debtlens 单元测试（零依赖，仅用 node:assert）
 *   node test/unit.test.js
 *
 * 只测导出的纯函数 / 三态判定 / 参数解析。
 * 退出码契约由 test/smoke-cli.js 用 spawnSync 真起进程验证 —— 单测不碰 process.exit。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'index.js'));

let pass = 0;
const failures = [];
function group(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  [FAIL] ' + name + '\n         ' + (e && e.message)); }
}

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-u-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return tmp;
}

function scanLine(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-s-'));
  const f = path.join(tmp, 'x.js');
  fs.writeFileSync(f, content);
  const res = D.scanFile(f);
  return res ? res.hits : [];
}

// ---------------------------------------------------------------------------
group('scanFile 注释锚定降误报', () => {
  assert.deepStrictEqual(scanLine('// TODO: fix'), ['TODO']);
  assert.deepStrictEqual(scanLine('const todo = 1;'), []);
  assert.deepStrictEqual(scanLine('const msg = "TODO: fake";'), []);
  assert.deepStrictEqual(scanLine('some(); // FIXME later'), ['FIXME']);
  assert.deepStrictEqual(scanLine('/* HACK */'), ['HACK']);
  assert.deepStrictEqual(scanLine('# NOTE: x'), ['NOTE']);
  assert.deepStrictEqual(scanLine('<!-- DEPRECATED -->'), ['DEPRECATED']);
  assert.deepStrictEqual(scanLine('const FIXME_LIST = []'), []);
  const two = scanLine('// TODO: a\n// OPTIMIZE: b');
  assert.ok(two.includes('TODO') && two.includes('OPTIMIZE'));
});

// ---------------------------------------------------------------------------
group('analyze 计数与 basisComplete', () => {
  const tmp = makeProject({
    'src/a.js': 'const x=1;\n// TODO: fix a\nconst y=2; // FIXME: bug here\n',
    'src/b.py': '# NOTE: refactor\nprint(1)\n',
    'src/c.js': 'const msg = "TODO: fake";\nconst t=1;\n'
  });
  const a = D.analyze(tmp);
  assert.strictEqual(a.totalTags, 3);
  assert.strictEqual(a.byTag.TODO, 1);
  assert.strictEqual(a.bySeverity.high, 2);
  assert.strictEqual(a.bySeverity.low, 1);
  assert.strictEqual(a.taggedFiles, 2);
  assert.strictEqual(a.totalWeighted, 7);
  assert.strictEqual(a.basisComplete, true, '有源码有行数 → basisComplete 必须 true');
  assert.ok(a.healthScore >= 0 && a.healthScore <= 100);
});

// ---------------------------------------------------------------------------
group('P0: 空输入不给 100 分（有害指标）', () => {
  const empty = D.analyze(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-empty-')));
  assert.strictEqual(empty.files, 0);
  assert.strictEqual(empty.basisComplete, false, '0 个文件 → basisComplete 必须 false');
  assert.strictEqual(empty.healthScore, null, '0 个文件时健康分必须是 null，不能是 100');
  assert.strictEqual(empty.verdict, '无法评估');
  // 反向断言：确认 null !== 100，避免有人「顺手改回去」
  assert.notStrictEqual(empty.healthScore, 100);
});

// ---------------------------------------------------------------------------
group('P0: 门禁三态判定顺序', () => {
  const base = { files: 10, srcLines: 100, basisComplete: true, gate: [], warnings: [] };

  // pass
  let s = D.buildGateState({ ...base, opts: { maxTotal: 0 } });
  assert.strictEqual(s.state, D.GATE_STATE.PASS);
  assert.strictEqual(D.exitCodeFor(s.state), 0, 'exitCodeFor 收 state 字符串，不是整个对象');

  // fail
  s = D.buildGateState({ ...base, opts: { maxTotal: 0 }, gate: ['总标记数 3 > --max-total 0'] });
  assert.strictEqual(s.state, D.GATE_STATE.FAIL);
  assert.strictEqual(D.exitCodeFor(s.state), 2);

  // inconclusive：未配阈值（即使输入完全正常）
  s = D.buildGateState({ ...base, opts: {} });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE, '未配门禁绝不能是 pass');
  assert.strictEqual(s.configured, false);
  assert.strictEqual(D.exitCodeFor(s.state), 3);

  // inconclusive：配了阈值但输入为空（假绿灯的头号变体）
  s = D.buildGateState({ files: 0, srcLines: 0, basisComplete: false, opts: { maxTotal: 0 }, gate: [], warnings: [] });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE, '空输入 + 已配门禁绝不能是 pass');
  assert.strictEqual(s.configured, true);
  assert.strictEqual(D.exitCodeFor(s.state), 3);

  // inconclusive：有文件但总行数为 0
  s = D.buildGateState({ files: 3, srcLines: 0, basisComplete: false, opts: { maxDensity: 0 }, gate: [], warnings: [] });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE);
  assert.strictEqual(D.exitCodeFor(s.state), 3);

  // 判定顺序：未配阈值 且 输入为空 → 报「未配阈值」（顺序固定）
  s = D.buildGateState({ files: 0, srcLines: 0, basisComplete: false, opts: {}, gate: [], warnings: [] });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE);
  assert.strictEqual(s.configured, false);
});

// ---------------------------------------------------------------------------
group('P0: --fail-on-tags 拼错标记名必须报错而非静默通过', () => {
  assert.throws(() => D.parseArgs(['--fail-on-tags', 'NOTATAG']), e => e instanceof D.UsageExit && e.code === 2);
  assert.throws(() => D.parseArgs(['--fail-on-tags', 'TODO,NOTATAG']), D.UsageExit);

  // 合法名单独解析
  const okArgs = D.parseArgs(['--fail-on-tags', 'fixme,todo']);
  assert.strictEqual(okArgs.failOnTags, 'FIXME,TODO', '应归一化为大写并去空格');

  // 部分合法 → 整体报错

  // 未知标记名即使拼得像（大小写混淆）也要报错
  assert.throws(() => D.parseArgs(['--fail-on-tags', 'Todo2']), D.UsageExit);
});

// ---------------------------------------------------------------------------
group('P0: 数值参数容错六连', () => {
  const bad = [
    ['--max-total'],                 // 缺值
    ['--max-total', ''],             // 空串（Number('')===0 的陷阱）
    ['--max-total', '   '],          // 纯空白
    ['--max-total', '5abc'],         // 尾随垃圾（parseInt 静默截断的陷阱）
    ['--max-total', '2.5'],          // 小数给整数位
    ['--max-total', '-1'],           // 负数
    ['--max-total', '0x10'],         // 十六进制
    ['--max-total', 'Infinity'],     // 非有限
    ['--max-density', ''],
    ['--max-density', 'abc'],
    ['--max-density', '-0.5'],
    ['--max-weighted', ''],
    ['--max-weighted', '1.2.3']
  ];
  for (const argv of bad) {
    assert.throws(() => D.parseArgs(argv), e => e instanceof D.UsageExit && e.code === 2,
      '应报参数错误: ' + JSON.stringify(argv));
  }
  // 合法值必须放行，且 0 是合法阈值
  assert.strictEqual(D.parseArgs(['--max-total', '0']).maxTotal, 0);
  assert.strictEqual(D.parseArgs(['--max-density', '0']).maxDensity, 0);
  assert.strictEqual(D.parseArgs(['--max-density', '1.5']).maxDensity, 1.5);
});

// ---------------------------------------------------------------------------
group('P0: --root 缺值 / 吞标志必须报错', () => {
  assert.throws(() => D.parseArgs(['--root']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--root', '']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--root', '--json']), D.UsageExit, '--root 不能吞掉下一个标志');
  assert.throws(() => D.parseArgs(['--root', '-x']), D.UsageExit);
  // 合法：相对路径、绝对路径、含空格路径都放行
  assert.strictEqual(D.parseArgs(['--root', '.']).root, '.');
  assert.strictEqual(D.parseArgs(['--root', 'a b/c']).root, 'a b/c');
});

// ---------------------------------------------------------------------------
group('P0: 未知选项一律 exit 2（短/长标志都要拦）', () => {
  for (const argv of [['-x'], ['--totally-unknown'], ['--json=1'], ['-'], ['doctor2'], ['stray-positional']]) {
    assert.throws(() => D.parseArgs(argv), D.UsageExit, '应报未知选项: ' + JSON.stringify(argv));
  }
  // 合法位置参数与标志
  assert.deepStrictEqual(D.parseArgs(['doctor'])._, ['doctor']);
  assert.deepStrictEqual(D.parseArgs(['scan'])._, ['scan']);
  assert.strictEqual(D.parseArgs(['--json']).json, true);
  assert.strictEqual(D.parseArgs(['--fail-on-issues']).failOnIssues, true);
  assert.strictEqual(D.parseArgs(['--version']).version, true);
  assert.strictEqual(D.parseArgs(['--help']).help, true);
  assert.strictEqual(D.parseArgs(['-V']).version, true);
  assert.strictEqual(D.parseArgs(['-h']).help, true);
});

// ---------------------------------------------------------------------------
group('collectGateFailures 各项比较正确', () => {
  const a = {
    density: 5, weightedDensity: 8, totalTags: 10,
    byTag: { TODO: 1, FIXME: 2, NOTE: 0 }, files: 5, srcLines: 200, basisComplete: true
  };
  let g = D.collectGateFailures(a, { maxDensity: 3 }, []);
  assert.strictEqual(g.length, 1);
  g = D.collectGateFailures(a, { maxDensity: 5 }, []);
  assert.strictEqual(g.length, 0, '等于阈值不算超（严格大于）');
  g = D.collectGateFailures(a, { maxWeighted: 8 }, []);
  assert.strictEqual(g.length, 0);
  g = D.collectGateFailures(a, { maxWeighted: 7 }, []);
  assert.strictEqual(g.length, 1);
  g = D.collectGateFailures(a, { maxTotal: 9 }, []);
  assert.strictEqual(g.length, 1);
  g = D.collectGateFailures(a, { failOnTags: 'FIXME,TODO' }, []);
  assert.strictEqual(g.length, 2);
  g = D.collectGateFailures(a, { failOnTags: 'NOTE' }, []);
  assert.strictEqual(g.length, 0, 'byTag.NOTE 为 0 → 不算命中');
  g = D.collectGateFailures(a, { failOnIssues: true }, ['w1', 'w2']);
  assert.strictEqual(g.length, 1);
  g = D.collectGateFailures(a, {}, []);
  assert.strictEqual(g.length, 0);
});

// ---------------------------------------------------------------------------
group('buildWarnings 三条警告', () => {
  const w0 = D.buildWarnings({ files: 0, basisComplete: false, density: 0, bySeverity: { high: 0, medium: 0, low: 0 } });
  assert.ok(w0.some(w => w.startsWith('no-source')));
  assert.ok(!w0.some(w => w.startsWith('high-density')), '0 文件时不该报高密度');

  const w1 = D.buildWarnings({ files: 10, basisComplete: true, density: 20, bySeverity: { high: 3, medium: 0, low: 0 } });
  assert.ok(w1.some(w => w.startsWith('high-density')));
  assert.ok(w1.some(w => w.startsWith('has-high-severity')));

  const w2 = D.buildWarnings({ files: 10, basisComplete: true, density: 20, bySeverity: { high: 0, medium: 0, low: 0 } });
  assert.ok(!w2.some(w => w.startsWith('has-high-severity')));
  assert.strictEqual(w2.length, 1);
});

// ---------------------------------------------------------------------------
group('computeScore 边界', () => {
  assert.deepStrictEqual(D.computeScore(0), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(1), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(2), { score: 75, verdict: '基本健康' });
  assert.deepStrictEqual(D.computeScore(5), { score: 0, verdict: '债务沉重' });
});

// ---------------------------------------------------------------------------
group('applyGate 兼容旧调用签名', () => {
  const a = { files: 5, srcLines: 100, basisComplete: true, density: 5, weightedDensity: 5, totalTags: 10, byTag: { FIXME: 2, TODO: 0 } };
  const r = D.applyGate(a, { maxDensity: 3 }, []);
  assert.strictEqual(r.code, 2);
  assert.ok(r.gate.some(x => x.includes('max-density')));
  assert.strictEqual(r.state.state, D.GATE_STATE.FAIL);
  // 未配门禁 → 3（旧调用点不会因新增语义崩掉，但也不再谎报 0）
  assert.strictEqual(D.applyGate(a, {}, []).code, 3);
  // 空输入 → 3
  assert.strictEqual(D.applyGate({ files: 0, srcLines: 0, basisComplete: false, density: 0, weightedDensity: 0, totalTags: 0, byTag: {} }, { maxDensity: 0 }, []).code, 3);
});

// ---------------------------------------------------------------------------
group('自检门禁: CLI 版本号 == package.json 版本号', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(D.packageVersion(), pkg.version, 'packageVersion 必须读 package.json');
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '版本号必须是三段式，实际: ' + pkg.version);
});

// ---------------------------------------------------------------------------
group('自检门禁: TAGS 常量 == README 白名单', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const t of D.TAGS) {
    assert.ok(readme.includes(t.tag), 'README 必须列出标记 ' + t.tag + '（否则用户不知道 --fail-on-tags 能填什么）');
  }
  // README 里出现的「标记清单」不得超出源码常量
  const docList = readme.match(/\|\s*`?([A-Z]{3,12})`?\s*\|/g) || [];
  for (const row of docList) {
    const m = row.match(/\|\s*`?([A-Z]{3,12})`?\s*\|/);
    if (m) assert.ok(D.KNOWN_TAGS.has(m[1]), 'README 出现未知标记 ' + m[1] + '（源码 TAGS 里没有）');
  }
});

// ---------------------------------------------------------------------------
group('退出码契约: 0/2/3，且绝不含 1', () => {
  assert.strictEqual(D.EXIT_FOR_STATE.pass, 0);
  assert.strictEqual(D.EXIT_FOR_STATE.fail, 2);
  assert.strictEqual(D.EXIT_FOR_STATE.inconclusive, 3);
  for (const st of [D.GATE_STATE.PASS, D.GATE_STATE.FAIL, D.GATE_STATE.INCONCLUSIVE]) {
    assert.notStrictEqual(D.exitCodeFor(st), 1, '退出码 1 保留给运行异常，门禁不得返回 1');
  }
  assert.strictEqual(D.exitCodeFor(D.GATE_STATE.PASS), 0);
  assert.strictEqual(D.exitCodeFor(D.GATE_STATE.FAIL), 2);
  assert.strictEqual(D.exitCodeFor(D.GATE_STATE.INCONCLUSIVE), 3);
  assert.strictEqual(D.exitCodeFor('garbage-state'), 3, '未知状态兜底为 inconclusive，不得静默 0');
});

// ---------------------------------------------------------------------------
console.log('\ndebtlens 单元测试：' + pass + ' 组通过，' + failures.length + ' 组失败');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.e && f.e.stack ? f.e.stack.split('\n').slice(0, 3).join('\n    ') : f.e));
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}

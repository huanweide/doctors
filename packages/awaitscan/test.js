#!/usr/bin/env node
'use strict';

/*
 * awaitscan 自包含单测（零依赖，仅用 node:assert + node:child_process）
 * 运行：node test.js   —— 全绿 exit 0，任一失败 exit 1
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const D = require('./index.js');
const CLI = path.join(__dirname, 'index.js');

let pass = 0;
function ok(name) { pass++; console.log('  [OK] ' + name); }

function detect(code) {
  return D.detectInText(D.stripNoise(code), 'sample.js');
}
function countByRule(issues, id) { return issues.filter(i => i.rule.id === id).length; }

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  Object.keys(structure).forEach(rel => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, structure[rel]);
  });
  return tmp;
}

// 1. R1 循环内串行 await（命中） --------------------------------------------
(function checkR1Hit() {
  const code = [
    'const arr = [1,2,3];',
    'for (const x of arr) {',
    '  await doWork(x);',
    '}'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'serial-await-in-loop'), 1, '应检出 1 个串行 await');
  assert.strictEqual(countByRule(issues, 'nested-loop'), 0);
  ok('R1 循环内串行 await 命中');
})();

// 2. R1 for await of（合法，跳过不报） -------------------------------------
(function checkForAwaitSkip() {
  const code = [
    'async function f() {',
    '  for await (const x of gen()) {',
    '    await doWork(x);',
    '  }',
    '}'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'serial-await-in-loop'), 0, 'for await 应跳过');
  ok('R1 for await of 合法跳过');
})();

// 3. R1 误报防护：await 在内层函数（表层无） -------------------------------
(function checkR1FnGuard() {
  const code = [
    'for (const x of arr) {',
    '  const g = async () => {',
    '    await doWork(x);',
    '  };',
    '}'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'serial-await-in-loop'), 0, '内层函数内的 await 不应误报');
  ok('R1 内层函数 await 不误报');
})();

// 4. R2 map 块体 await（命中） ---------------------------------------------
(function checkR2Block() {
  const code = 'const r = arr.map(async (x) => {\n  return await doWork(x);\n});';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'await-in-map'), 1, 'map 块体 await 应命中');
  ok('R2 map 块体 await 命中');
})();

// 5. R2 表达式体 await（命中） ---------------------------------------------
(function checkR2Expr() {
  const code = 'const r = arr.map(x => await doWork(x));';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'await-in-map'), 1, 'map 表达式体 await 应命中');
  ok('R2 map 表达式体 await 命中');
})();

// 6. R2 Promise.all 包裹（豁免） -------------------------------------------
(function checkR2PromiseAll() {
  const code = 'const r = await Promise.all(arr.map(async (x) => {\n  return await doWork(x);\n}));';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'await-in-map'), 0, 'Promise.all 包裹应豁免');
  ok('R2 Promise.all 包裹豁免');
})();

// 7. R2 嵌套 map（内层报、外层不报） ---------------------------------------
(function checkR2Nested() {
  const code = 'const r = arr.map(a => a.map(b => await doWork(b)));';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'await-in-map'), 1, '只应报内层 map，外层不应误报');
  ok('R2 嵌套 map 仅内层命中、外层不误报');
})();

// 8. R3 嵌套循环（命中） ---------------------------------------------------
(function checkR3Hit() {
  const code = [
    'for (let i = 0; i < n; i++) {',
    '  for (let j = 0; j < m; j++) {',
    '    sum += a[i][j];',
    '  }',
    '}'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'nested-loop'), 1, '应检出 1 个嵌套循环（内层）');
  ok('R3 嵌套循环命中');
})();

// 9. R3 误报防护：顺序双 for（非嵌套） -------------------------------------
(function checkR3Sequential() {
  const code = [
    'for (let i = 0; i < n; i++) { sum += a[i]; }',
    'for (let j = 0; j < m; j++) { sum += b[j]; }'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'nested-loop'), 0, '顺序独立 for 不应误报嵌套');
  ok('R3 顺序双 for 不误报');
})();

// 10. 字符串 / 注释伪信号（不命中） ----------------------------------------
(function checkNoise() {
  const code = [
    'const s = "for (const x of arr) { await doWork(x); }";',
    '// for (const x of arr) { await doWork(x); }'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(issues.length, 0, '字符串与注释内的伪信号应被剥离');
  ok('字符串/注释内伪信号剥离');
})();

// 11. computeScore 边界 ----------------------------------------------------
(function checkScore() {
  assert.deepStrictEqual(D.computeScore(0), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(1), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(2), { score: 75, verdict: '基本健康' });
  assert.deepStrictEqual(D.computeScore(5), { score: 0, verdict: '性能风险高' });
  ok('computeScore 边界（0/等于FREE/中间/归零）正确');
})();

// 12. applyGate 阈值校验 ---------------------------------------------------
(function checkGate() {
  const a = { bySeverity: { high: 2, medium: 0, low: 0 }, issueCount: 2 };
  const bad = D.applyGate(a, { maxHigh: NaN }, []);
  assert.strictEqual(bad.code, 2);
  assert.strictEqual(bad.gate, null);

  const g1 = D.applyGate(a, { maxHigh: 1 }, []);
  assert.strictEqual(g1.code, 2);
  assert.ok(g1.gate.some(x => x.includes('max-high')));

  const g2 = D.applyGate(a, { failOnHigh: true }, []);
  assert.strictEqual(g2.code, 2);

  const g3 = D.applyGate({ bySeverity: { high: 0, medium: 0, low: 0 }, issueCount: 0 }, { maxHigh: 5 }, []);
  assert.strictEqual(g3.code, 0);
  ok('applyGate 阈值非法 exit2 / maxHigh / failOnHigh / 通过 正确');
})();

// 13. CLI 端到端 -----------------------------------------------------------
(function checkCLI() {
  const clean = makeProject({
    'src/a.js': 'const x = 1;\nmodule.exports = x;\n',
    'test/a.test.js': "const assert = require('assert');\ntest('x', () => assert.ok(true));\n"
  });
  let s0 = 0;
  try { execFileSync(process.execPath, [CLI, '--root', clean], { stdio: 'pipe' }); }
  catch (e) { s0 = e.status; }
  assert.strictEqual(s0, 0, '零问题项目应 exit 0');

  const dirty = makeProject({
    'src/a.js': 'for (const x of arr) {\n  await doWork(x);\n}\n'
  });
  let s2 = -1;
  try { execFileSync(process.execPath, [CLI, '--root', dirty, '--fail-on-high'], { stdio: 'pipe' }); }
  catch (e) { s2 = e.status; }
  assert.strictEqual(s2, 2, '有高危反模式 + --fail-on-high 应 exit 2');

  let sBad = -1;
  try { execFileSync(process.execPath, [CLI, '--root', '/no/such/dir/xyz'], { stdio: 'pipe' }); }
  catch (e) { sBad = e.status; }
  assert.strictEqual(sBad, 2, '无效 root 应 exit 2');

  let sNa = -1;
  try { execFileSync(process.execPath, [CLI, '--root', dirty, '--max-high', 'abc'], { stdio: 'pipe' }); }
  catch (e) { sNa = e.status; }
  assert.strictEqual(sNa, 2, '--max-high 非整数应 exit 2');

  const nested = makeProject({
    'src/b.js': 'for (let i=0;i<n;i++){\n  for (let j=0;j<m;j++){ sum+=a[i][j]; }\n}\n'
  });
  let sN = 0;
  try { execFileSync(process.execPath, [CLI, '--root', nested, '--fail-on-high'], { stdio: 'pipe' }); }
  catch (e) { sN = e.status; }
  assert.strictEqual(sN, 0, '嵌套循环仅中危，--fail-on-high 不应触发 exit 2');

  ok('CLI 端到端（零问题/门禁/无效root/非整数阈值/中危不触发高危门禁）退出码正确');
})();

// 14. --version ------------------------------------------------------------
(function checkVersion() {
  let out = '';
  let s = 0;
  try { out = execFileSync(process.execPath, [CLI, '--version'], { stdio: 'pipe' }).toString(); }
  catch (e) { s = e.status; out = (e.stdout || '').toString(); }
  assert.strictEqual(s, 0, '--version 应 exit 0');
  assert.ok(/awaitscan\s+\d+\.\d+\.\d+/.test(out.trim()), '应输出版本号，实际: ' + out.trim());
  ok('CLI --version 输出版本号并 exit 0');
})();

console.log('\nawaitscan 单测：' + pass + ' 项全绿');

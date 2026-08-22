'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const td = require('./typedoctor.js');

// 样例统一放进字符串，避免被当成真实类型注解误报（dogfood 纪律）
function makeSample(code) {
  return td.scanFile('sample.ts', code);
}

test('T1 explicit-any 检测（注解/泛型/返回类型）', () => {
  const r = makeSample('const x: any = 1;\nfunction f(): any { return 1; }\nconst p: Promise<any> = g();\nconst a: Array<any> = [];');
  assert.ok(r.issues.some((i) => i.rule === 'explicit-any'));
  assert.strictEqual(r.issues.filter((i) => i.rule === 'explicit-any').length, 4);
});

test('T2 any-cast 检测（as any / as readonly any）', () => {
  const r = makeSample('const a = b as any;\nconst c = d as readonly any;');
  const casts = r.issues.filter((i) => i.rule === 'any-cast');
  assert.strictEqual(casts.length, 2);
  assert.ok(casts.every((i) => i.severity === 'high'));
});

test('T4 double-cast 检测（as unknown as）', () => {
  const r = makeSample('const a = b as unknown as Foo;');
  const d = r.issues.filter((i) => i.rule === 'double-cast');
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].severity, 'medium');
});

test('T3 ts-ignore 注释检测（ignore/nocheck/expect-error）', () => {
  const r = makeSample('// @ts-ignore\nconst a = b;\n/* @ts-nocheck */\nconst c = d; // @ts-expect-error\n');
  const ig = r.issues.filter((i) => i.rule === 'ts-ignore-comment');
  assert.strictEqual(ig.length, 3);
  assert.ok(ig.every((i) => i.severity === 'high'));
});

test('字符串内的 any 不误报（dogfood 纪律）', () => {
  const r = makeSample('const s = "const x: any = 1; const y = z as any;";\nconst t = `// @ts-ignore`;');
  assert.strictEqual(r.issues.length, 0);
});

test('注释中的 : any 不报 explicit-any（仅 @ts- 指令报）', () => {
  const r = makeSample('// 注意这里 : any 只是注释\nconst a = 1;');
  assert.strictEqual(r.issues.filter((i) => i.rule === 'explicit-any').length, 0);
  assert.strictEqual(r.issues.length, 0);
});

test('Vue 提取：template :prop 不误报，script : any 报', () => {
  const vue = [
    '<template>',
    '  <div :any="foo" :class="bar"></div>',
    '</template>',
    '<script lang="ts">',
    'const x: any = 1;',
    'const y = z as any;',
    '</script>',
  ].join('\n');
  const r = td.scanFile('C.vue', vue);
  assert.strictEqual(r.issues.filter((i) => i.rule === 'explicit-any').length, 1);
  assert.strictEqual(r.issues.filter((i) => i.rule === 'any-cast').length, 1);
});

test('computeScore 密度法：低密度满分，高密度扣分', () => {
  assert.strictEqual(td.computeScore(0, 0, 1000), 100);
  assert.strictEqual(td.computeScore(0, 6, 1000), 100); // 刚好容忍（12 加权分）
  assert.strictEqual(td.computeScore(5, 0, 1000), 91); // 5 high: w=15, excess=3, 100-9=91
});

test('正则字面量内的 any 不误报（tokenizer 正则感知）', () => {
  const r = makeSample('const re = /(?::\\s*|<\\s*)any\\b/g;\nconst r2 = /as\\s+any\\b/;');
  assert.strictEqual(r.issues.length, 0);
});

test('JSX 文件：<any> 元素不误报，但 : any 注解仍报', () => {
  const r = td.scanFile('C.tsx', 'const a = <any>foo</any>;\nconst b: any = 1;\n');
  assert.strictEqual(r.issues.filter((i) => i.rule === 'explicit-any').length, 1); // 仅 b: any
});

test('.d.ts 声明文件跳过（any 合法，避免误报）', () => {
  const r = td.scanFile('x.d.ts', 'declare const y: any;\ndeclare function f(): any;\n');
  assert.strictEqual(r, null);
});

test('parseArgs：非数字阈值报错（门禁防呆 exit 2）', () => {
  assert.throws(() => td.parseArgs(['--max-high', 'abc']));
  assert.throws(() => td.parseArgs(['--min-score', 'x']));
  const ok = td.parseArgs(['--max-high', '3', '--min-score', '80']);
  assert.strictEqual(ok.maxHigh, 3);
  assert.strictEqual(ok.minScore, 80);
});

test('run：干净目录通过 exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-clean-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const x: number = 1;\nexport function f(): string { return "ok"; }\n');
  const res = td.run(['--root', dir]);
  assert.strictEqual(res.exitCode, 0);
  assert.ok(res.summary.score === 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run：含 any 强转 + --fail-on-high 触发 exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-dirty-'));
  fs.writeFileSync(path.join(dir, 'b.ts'), 'const a = b as any;\n');
  const res = td.run(['--root', dir, '--fail-on-high']);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.summary.high, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run：--json 输出结构正确', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-json-'));
  fs.writeFileSync(path.join(dir, 'c.ts'), 'const a: any = 1;\n');
  const res = td.run(['--root', dir, '--json']);
  const parsed = JSON.parse(res.report);
  assert.strictEqual(parsed.summary.any, 1);
  assert.strictEqual(parsed.score <= 100, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run：root 不存在 exit 2', () => {
  const res = td.run(['--root', '/path/that/does/not/exist-xyz']);
  assert.strictEqual(res.exitCode, 2);
});

test('dogfood 归零：自身仓库扫描零问题', () => {
  const me = td.scanFile(path.join(__dirname, 'typedoctor.js'), fs.readFileSync(path.join(__dirname, 'typedoctor.js'), 'utf8'));
  assert.strictEqual(me.issues.length, 0, 'typedoctor.js 自身应 0 问题，实际: ' + JSON.stringify(me.issues));
  const t = td.scanFile(path.join(__dirname, 'test.js'), fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8'));
  assert.strictEqual(t.issues.length, 0, 'test.js 自身应 0 问题，实际: ' + JSON.stringify(t.issues));
});

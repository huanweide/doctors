'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const { slugify, scanFile, fileScore, parseArgs } = require('./index.js');

const INDEX = path.resolve(__dirname, 'index.js');

function tmpFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docdoctor-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function rules(issues) {
  return issues.map(i => i.rule);
}
function sevs(issues) {
  return issues.map(i => i.severity);
}

test('slugify: 基本 + 中文 + 标点', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Trim Me  '), 'trim-me');
  assert.equal(slugify('C++ 入门指南!'), 'c-入门指南');
  assert.equal(slugify('Multiple   Spaces'), 'multiple-spaces');
});

test('D1 死链接 high：指向不存在的本地文件', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n[x](./nope.md)\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.ok(rules(r.issues).includes('D1'));
  assert.ok(sevs(r.issues).includes('high'));
});

test('D1 锚点不匹配 medium：同文件无该标题', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n[sec](#missing)\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  const d1 = r.issues.filter(i => i.rule === 'D1' && /锚点/.test(i.message));
  assert.equal(d1.length, 1);
  assert.equal(d1[0].severity, 'medium');
});

test('D1 跨文件锚点匹配成功（不误报）', () => {
  const dir = tmpFixture({
    'a.md': '# A\n\n[go](./b.md#target)\n',
    'b.md': '# B\n\n## Target\n\n内容\n'
  });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  const d1 = r.issues.filter(i => i.rule === 'D1');
  assert.equal(d1.length, 0, '跨文件有效锚点不应报 D1');
});

test('D3 标题跳级 low', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n### C\n\n文本\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.ok(rules(r.issues).includes('D3'));
});

test('D4 锚点冲突 low：相同 slug 多次', () => {
  const dir = tmpFixture({ 'a.md': '# Dup\n\n文本\n\n# Dup\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.ok(rules(r.issues).includes('D4'));
});

test('D5 图片缺 alt medium', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n![](/img/logo.png)\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.ok(rules(r.issues).includes('D5'));
  const d5 = r.issues.find(i => i.rule === 'D5');
  assert.equal(d5.severity, 'medium');
});

test('D6 裸 URL low + 行内代码豁免', () => {
  const dir = tmpFixture({
    'a.md': '# A\n\n见 https://example.com 了解更多\n\n代码内 `https://example.com` 不应报\n'
  });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  const d6 = r.issues.filter(i => i.rule === 'D6');
  assert.equal(d6.length, 1, '行内代码中的 URL 应被豁免');
});

test('D6 围栏代码块整行豁免', () => {
  const dir = tmpFixture({
    'a.md': '# A\n\n```\nhttps://example.com 在围栏内\nhttps://foo.bar 也不报\n```\n'
  });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.equal(rules(r.issues).includes('D6'), false);
});

test('D7 参考链接定义缺失 medium', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n[text][ref]\n' });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.ok(rules(r.issues).includes('D7'));
});

test('D7 参考链接有定义则不报', () => {
  const dir = tmpFixture({
    'a.md': '# A\n\n[text][ref]\n\n[ref]: https://example.com\n'
  });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.equal(rules(r.issues).includes('D7'), false);
});

test('行内代码中的参考链接/链接语法豁免（不误报 D7/D1）', () => {
  const dir = tmpFixture({
    'a.md': '# A\n\n文档示例写法 ``[text][ref]`` 与 ``[x](./y.md)`` 不应被扫\n'
  });
  const r = scanFile(path.join(dir, 'a.md'), 1500);
  assert.equal(rules(r.issues).includes('D7'), false, '行内代码参考链接示例不应报 D7');
  assert.equal(rules(r.issues).includes('D1'), false, '行内代码链接示例不应报 D1');
});

test('D2 超大文档 medium（超过 maxLines）', () => {
  const lines = [];
  for (let i = 0; i < 1600; i++) lines.push('这是第 ' + i + ' 行填充内容，普通段落非标题。');
  const dir = tmpFixture({ 'big.md': lines.join('\n') + '\n' });
  const r = scanFile(path.join(dir, 'big.md'), 1500);
  assert.ok(rules(r.issues).includes('D2'));
  assert.equal(r.issues.find(i => i.rule === 'D2').severity, 'medium');
});

test('D2 文件过大字节跳过（防 OOM）', () => {
  const dir = tmpFixture({ 'huge.md': 'x'.repeat(300 * 1024) });
  const r = scanFile(path.join(dir, 'huge.md'), 1500);
  assert.equal(r.skipped, true);
  assert.ok(rules(r.issues).includes('D2'));
  assert.equal(r.issues.find(i => i.rule === 'D2').severity, 'low');
});

test('fileScore: 无问题=100，少量低危仍满分，超阈值扣分', () => {
  assert.equal(fileScore([]), 100);
  assert.equal(fileScore([{ severity: 'low' }, { severity: 'low' }]), 100);
  assert.equal(fileScore([{ severity: 'low' }, { severity: 'low' }, { severity: 'low' }]) < 100, true);
  assert.equal(fileScore([{ severity: 'high' }]) < 100, true);
});

test('parseArgs: 数值/路径/布尔三类分离', () => {
  const o1 = parseArgs(['-r', 'docs', '--max-issues', '5', '--json', 'file.md']);
  assert.equal(o1.root, 'docs');
  assert.equal(o1.maxIssues, 5);
  assert.equal(o1.json, true);
  assert.deepEqual(o1.paths, ['file.md']);
});

test('parseArgs: --max-issues 非整数视为用法错误（exit 2）', () => {
  const res = spawnSync('node', [INDEX, '--max-issues', 'abc'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('CLI 端到端：含死链接的仓库退出码 1', () => {
  const dir = tmpFixture({ 'readme.md': '# Title\n\n[ broken ](./missing.md )\n' });
  const res = spawnSync('node', [INDEX, dir], { encoding: 'utf8' });
  assert.equal(res.status, 1, '存在高危死链接应退出码 1');
  assert.match(res.stdout, /D1/);
});

test('CLI 端到端：干净仓库退出码 0', () => {
  const dir = tmpFixture({ 'good.md': '# Good\n\n[ok](./good.md#good)\n' });
  const res = spawnSync('node', [INDEX, dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, '无高危问题应退出码 0');
});

test('CLI --json 输出合法 JSON 且含 summary', () => {
  const dir = tmpFixture({ 'a.md': '# A\n\n[broken](./nope.md)\n' });
  const res = spawnSync('node', [INDEX, '--json', dir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.summary);
  assert.equal(parsed.summary.high >= 1, true);
});

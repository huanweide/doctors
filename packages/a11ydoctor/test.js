'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  tokenizeHtml, runRules, buildTree, computeScore, sortIssues, scanFileContent, scanFile, parseArgs
} = require('./index.js');

function rulesOf(html) {
  const { tags } = tokenizeHtml(html);
  buildTree(tags);
  return runRules(tags).issues;
}

function has(issues, rule) {
  return issues.some((i) => i.rule === rule);
}

test('img-alt: 缺 alt 报 high', () => {
  const issues = rulesOf('<img src="x.png">');
  assert.ok(has(issues, 'img-alt'));
  assert.equal(issues.find((i) => i.rule === 'img-alt').severity, 'high');
});

test('img-alt: alt="" 不报（装饰图）', () => {
  const issues = rulesOf('<img src="x.png" alt="">');
  assert.equal(has(issues, 'img-alt'), false);
});

test('label-association: 无关联报 medium', () => {
  const issues = rulesOf('<input type="text">');
  assert.ok(has(issues, 'label-association'));
});

test('label-association: for/id 关联不报', () => {
  const issues = rulesOf('<input id="n" type="text"><label for="n">名</label>');
  assert.equal(has(issues, 'label-association'), false);
});

test('label-association: 包裹 label 不报', () => {
  const issues = rulesOf('<label>名 <input type="text"></label>');
  assert.equal(has(issues, 'label-association'), false);
});

test('label-association: hidden 输入框不报', () => {
  const issues = rulesOf('<input type="hidden" name="csrf">');
  assert.equal(has(issues, 'label-association'), false);
});

test('input[type=image]: 缺 alt 报 img-alt(high)', () => {
  const issues = rulesOf('<input type="image" src="go.png">');
  assert.ok(has(issues, 'img-alt'));
  assert.equal(has(issues, 'label-association'), false);
});

test('input[type=image]: 有 alt 不报', () => {
  const issues = rulesOf('<input type="image" src="go.png" alt="提交">');
  assert.equal(has(issues, 'img-alt'), false);
  assert.equal(has(issues, 'label-association'), false);
});

test('accessible-name: 按钮无名字报 medium', () => {
  const issues = rulesOf('<button type="submit"></button>');
  assert.ok(has(issues, 'accessible-name'));
});

test('accessible-name: 按钮有 aria-label 不报', () => {
  const issues = rulesOf('<button aria-label="提交"></button>');
  assert.equal(has(issues, 'accessible-name'), false);
});

test('accessible-name: 带直接文本的 a 不误报', () => {
  const issues = rulesOf('<a href="/home">首页</a>');
  assert.equal(has(issues, 'accessible-name'), false);
});

test('html-lang: 缺 lang 报 high', () => {
  const issues = rulesOf('<html><head><title>x</title></head><body></body></html>');
  assert.ok(has(issues, 'html-lang'));
});

test('html-lang: 有 lang 不报', () => {
  const issues = rulesOf('<html lang="zh"><head><title>x</title></head></html>');
  assert.equal(has(issues, 'html-lang'), false);
});

test('heading-order: 跳级报 medium', () => {
  const issues = rulesOf('<h1>标题</h1><h3>跳级</h3>');
  assert.ok(has(issues, 'heading-order'));
});

test('heading-order: 连续不报', () => {
  const issues = rulesOf('<h1>标题</h1><h2>副标题</h2>');
  assert.equal(has(issues, 'heading-order'), false);
});

test('table-structure: 无 th 报 medium', () => {
  const issues = rulesOf('<table><tr><td>1</td></tr></table>');
  assert.ok(has(issues, 'table-structure'));
});

test('table-structure: 有 th 不报', () => {
  const issues = rulesOf('<table><tr><th>列</th></tr></table>');
  assert.equal(has(issues, 'table-structure'), false);
});

test('deprecated-element: font 报 low', () => {
  const issues = rulesOf('<font color="red">x</font>');
  assert.ok(has(issues, 'deprecated-element'));
});

test('link-purpose: 空锚点报 medium', () => {
  const issues = rulesOf('<a href="#">跳</a>');
  assert.ok(has(issues, 'link-purpose'));
});

test('link-purpose: 正常链接不报', () => {
  const issues = rulesOf('<a href="/x">正常</a>');
  assert.equal(has(issues, 'link-purpose'), false);
});

test('media-alternative: video 无 track 报 low', () => {
  const issues = rulesOf('<video src="a.mp4"></video>');
  assert.ok(has(issues, 'media-alternative'));
});

test('interactive-role: div onclick 无 role 报 medium', () => {
  const issues = rulesOf('<div onclick="go()">去</div>');
  assert.ok(has(issues, 'interactive-role'));
});

test('interactive-role: 有 role 不报', () => {
  const issues = rulesOf('<div role="button" tabindex="0" onclick="go()">去</div>');
  assert.equal(has(issues, 'interactive-role'), false);
});

test('降误报: script 内的 <img> 不报 img-alt', () => {
  const issues = rulesOf('<script>var s = "<img src=\'x.png\'>";</script>');
  assert.equal(has(issues, 'img-alt'), false);
});

test('降误报: 引号内 > 不截断属性', () => {
  const issues = rulesOf('<img alt="a > b" src="x.png">');
  assert.equal(has(issues, 'img-alt'), false);
});

test('computeScore: 无问题满分', () => {
  const r = computeScore([], 100);
  assert.equal(r.score, 100);
});

test('computeScore: 高严重度扣分', () => {
  const r = computeScore([{ severity: 'high' }], 0);
  assert.equal(r.score, 25);
});

test('parseArgs: --max 非整数抛错', () => {
  assert.throws(() => parseArgs(['x', '--max', 'abc']), /整数/);
});

test('parseArgs: --fail-on 非法值抛错', () => {
  assert.throws(() => parseArgs(['x', '--fail-on', 'bad']), /high \| any \| none/);
});

test('scanFile: .html 缺 doctype 报 low', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-'));
  const f = path.join(dir, 'p.html');
  fs.writeFileSync(f, '<html><body><img src="x.png"></body></html>');
  const r = scanFile(f);
  assert.ok(has(r.issues, 'doctype'));
  assert.ok(has(r.issues, 'img-alt'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanFileContent: 健康分随问题数下降', () => {
  const r = scanFileContent('<img src="a"><img src="b">', 10);
  assert.ok(r.score < 100);
  assert.equal(r.issues.length, 2);
});

test('sortIssues: 严重度降序(high 在前)', () => {
  const sorted = sortIssues([
    { severity: 'low', line: 5 },
    { severity: 'high', line: 1 },
    { severity: 'medium', line: 3 }
  ]);
  assert.deepEqual(sorted.map((s) => s.severity), ['high', 'medium', 'low']);
});

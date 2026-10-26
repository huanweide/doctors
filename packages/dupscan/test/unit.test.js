'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本文件位于 test/ 下，必须用 .. 回到仓库根加载被测模块
const dup = require('../index.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dupscan-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// 在临时目录写多文件并直接返回 detectDuplicates 结果，消除各测试里的建目录/写文件样板重复。
function scanBlocks(entries, minLines) {
  const root = tmpDir();
  const files = entries.map(([rel, content]) => write(root, rel, content));
  return dup.detectDuplicates(files, minLines == null ? 5 : minLines);
}

test('stripNoise strips comments, normalizes strings, keeps regex', () => {
  const c = dup.stripNoise('x = 1; // foo bar\ny = 2;');
  assert.ok(!c.includes('foo bar'));
  assert.ok(c.includes('x = 1;'));
  const s = dup.stripNoise('x = "hello";\ny = "world";');
  assert.ok(s.includes('_'));
  assert.ok(!s.includes('hello') && !s.includes('world'));
  assert.strictEqual(dup.normalizeLine(s.split('\n')[0]), 'x = _;');
  const r = dup.stripNoise('const ok = /"a"/.test(s);');
  assert.ok(r.includes('/"a"/'));
  assert.ok(!r.includes('_"a"_'));
});

test('normalizeLine collapses whitespace', () => {
  assert.strictEqual(dup.normalizeLine('   a   b   c  '), 'a b c');
  assert.strictEqual(dup.normalizeLine(''), '');
});

test('detectDuplicates finds cross-file duplicate block', () => {
  const block = 'const A = 1;\nconst B = 2;\nconst C = 3;\nconst D = 4;\nconst E = 5;\n';
  const { groups } = scanBlocks([
    ['a.js', block + 'function other(){ return 0; }\n'],
    ['b.js', 'function top(){}\n' + block],
  ]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].crossFile, true);
  assert.strictEqual(groups[0].copies, 2);
  assert.strictEqual(groups[0].lines, 5);
});

test('detectDuplicates respects minLines', () => {
  const block = 'const A = 1;\nconst B = 2;\nconst C = 3;\n';
  const { groups } = scanBlocks([['a.js', block], ['b.js', block]]);
  assert.strictEqual(groups.length, 0);
});

test('detectDuplicates raises severity for long block', () => {
  const lines = [];
  for (let i = 0; i < 16; i++) lines.push('const V' + i + ' = ' + i + ';');
  const block = lines.join('\n') + '\n';
  const { groups } = scanBlocks([['a.js', block + 'function end(){ return 1; }\n'], ['b.js', 'function start(){}\n' + block]]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].severity, 'high');
});

test('detectDuplicates ignores string differences (normalized)', () => {
  const { groups } = scanBlocks([
    ['a.js', 'function dup(a){\n  const x = "aa";\n  const y = a + 1;\n  return y;\n}\n'],
    ['b.js', 'function dup(a){\n  const x = "bbbb";\n  const y = a + 1;\n  return y;\n}\n'],
  ], 3);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].copies, 2);
});

test('detectDuplicates flags same-file repeated block', () => {
  const chunk = 'const A = 1;\nconst B = 2;\nconst C = 3;\nconst D = 4;\nconst E = 5;\n';
  const one = chunk + 'mid();\n' + chunk;
  const { groups } = scanBlocks([['a.js', one]]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].crossFile, false);
  assert.strictEqual(groups[0].copies, 2);
});

test('computeHealth is 100 with no duplicates', () => {
  const { groups } = scanBlocks([['a.js', 'function a(){ return 1; }\n'], ['b.js', 'function b(){ return 2; }\n']]);
  assert.strictEqual(dup.computeHealth(groups, 4), 100);
});

test('computeHealth drops with duplicates', () => {
  const block = 'const A = 1;\nconst B = 2;\nconst C = 3;\nconst D = 4;\nconst E = 5;\n';
  const { groups } = scanBlocks([['a.js', block], ['b.js', block]]);
  const h = dup.computeHealth(groups, 10);
  assert.ok(h < 100);
  assert.ok(h >= 0);
});

test('parseArgs handles flags and positional', () => {
  const o = dup.parseArgs(['--min-lines', '7', '--json', 'src']);
  assert.strictEqual(o.minLines, 7);
  assert.strictEqual(o.json, true);
  assert.strictEqual(o.root, 'src');
});

test('parseArgs rejects non-integer numeric flag', () => {
  assert.throws(() => dup.parseArgs(['--min-lines', 'abc']), /valid integer/);
});

test('parseArgs unknown flag throws', () => {
  assert.throws(() => dup.parseArgs(['--bogus']), /unknown flag/);
});

test('collectFiles ignores node_modules', () => {
  const root = tmpDir();
  write(root, 'a.js', 'x = 1;');
  write(root, 'node_modules/lib/b.js', 'y = 2;');
  const files = dup.collectFiles(root);
  assert.strictEqual(files.length, 1);
  assert.ok(files[0].endsWith('a.js'));
});

test('collectFiles single file', () => {
  const root = tmpDir();
  const f = write(root, 'only.js', 'x = 1;');
  assert.deepStrictEqual(dup.collectFiles(f), [f]);
});

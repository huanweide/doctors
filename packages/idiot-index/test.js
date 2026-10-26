'use strict';

// 自测：在临时目录构造项目，验证 analyze 产出合理。
//沿用原有的手写 check 风格（不引入 node:test，保持「零依赖 + 单文件可拷走」定位）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const {
  analyze, gradeOf, REDUNDANT, maxNesting, bareName,
} = require('./index.js');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '  -> ' + e.message); process.exitCode = 1; }
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

// ---------------------------------------------------------------- 原有 7 项

// 1) REDUNDANT 表里确有 high-signal 条目（结构从字符串改为对象，此处断言解包后内容）
check('REDUNDANT 含 moment/lodash/axios', () => {
  assert.ok(REDUNDANT.moment, '缺 moment');
  assert.ok(REDUNDANT.lodash, '缺 lodash');
  assert.ok(REDUNDANT.axios, '缺 axios');
  assert.ok(REDUNDANT.moment.repl.length > 0, 'moment.repl 不应为空');
});

// 2) gradeOf 边界正确
check('gradeOf 边界', () => {
  assert.strictEqual(gradeOf(10), 'A');
  assert.strictEqual(gradeOf(30), 'B');
  assert.strictEqual(gradeOf(50), 'C');
  assert.strictEqual(gradeOf(70), 'D');
  assert.strictEqual(gradeOf(90), 'F');
});

// 3) 对一个确实冗余 + 过度嵌套的临时项目，能检出冗余依赖并给分数
const tmp = tmpdir('idiot-');
write(tmp, 'package.json', {
  dependencies: { moment: '^2.0.0', lodash: '^4.0.0', axios: '^1.0.0' },
  devDependencies: {},
});
let deep = 'function a() {\n';
for (let i = 0; i < 10; i++) deep += '  '.repeat(i + 1) + 'function l' + i + '() {\n';
for (let i = 0; i < 10; i++) deep += '  '.repeat(10 - i) + '}\n';
deep += '}\n';
write(tmp, 'deep.ts', deep);

const r = analyze(tmp);
check('检出 3 个冗余依赖', () => {
  const names = r.redundantFound.map(d => d.name).sort();
  assert.deepStrictEqual(names, ['axios', 'lodash', 'moment']);
});
check('score 在 0-100 且 >0', () => {
  assert.ok(r.score >= 0 && r.score <= 100, '越界: ' + r.score);
  assert.ok(r.score > 0, '应为正: ' + r.score);
});
check('topFiles 含 deep.ts', () => {
  assert.ok(r.topFiles.some(f => f.rel.endsWith('deep.ts')), '未命中 deep.ts');
});
check('grade 合法', () => {
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(r.grade));
});

// 4) 干净目录（无 package.json、无源码）—— 现在必须 basisComplete=false 而不是「满分」
const empty = tmpdir('idiot-empty-');
const re = analyze(empty);
check('空目录 score=0 不崩', () => {
  assert.strictEqual(re.score, 0);
  assert.strictEqual(re.scannedFiles, 0);
});
check('空目录 basisComplete=false（0 分不代表健康）', () => {
  assert.strictEqual(re.basisComplete, false);
});

// ---------------------------------------------------------------- 新增回归

// 5) 核心回归：路径不存在必须抛错，不能当成空项目给满分
check('目标目录不存在必须抛 ENOTARGET', () => {
  const missing = path.join(os.tmpdir(), 'idiot-missing-' + Date.now());
  assert.throws(() => analyze(missing), (e) => e && e.code === 'ENOTARGET');
});

// 6) 目标是文件而非目录必须抛 ENOTARGET
check('目标不是目录必须抛 ENOTARGET', () => {
  const d = tmpdir('idiot-file-');
  const f = write(d, 'a.txt', 'x');
  assert.throws(() => analyze(f), (e) => e && e.code === 'ENOTARGET');
});

// 7) 核心价值回归：代码里真在用的依赖，不得被建议「删掉」
{
  const d = tmpdir('idiot-used-');
  write(d, 'package.json', { dependencies: { lodash: '^4', axios: '^1' } });
  write(d, 'src/app.js',
    'const _ = require(\'lodash\');\n' +
    'const axios = require(\'axios\');\n' +
    'module.exports = { f: () => _.map([1], x => x) };\n');
  const rr = analyze(d);
  check('在用的冗余依赖被标记 usedInSource=true', () => {
    const lod = rr.redundantFound.find(x => x.name === 'lodash');
    assert.ok(lod, '未检出 lodash');
    assert.strictEqual(lod.usedInSource, true, 'lodash 应被标为在用');
    const ax = rr.redundantFound.find(x => x.name === 'axios');
    assert.strictEqual(ax.usedInSource, true, 'axios 应被标为在用');
  });
  check('在用依赖不得出现「删掉」字样', () => {
    assert.ok(!rr.suggestions.some(s => s.includes('删掉 lodash')),
      '在用的 lodash 不该被建议删掉: ' + JSON.stringify(rr.suggestions));
    assert.ok(rr.suggestions.some(s => s.includes('[在用] lodash')),
      '应给出「评估迁移」建议');
  });
  check('默认模式仍然计分（保持向后兼容）', () => {
    assert.ok(rr.score > 0, '默认应仍按声明计分');
  });
}

// 8) 未引用的依赖应标usedInSource=false 并可删
{
  const d = tmpdir('idiot-unused-');
  write(d, 'package.json', { dependencies: { moment: '^2' } });
  write(d, 'index.js', 'module.exports = 1;\n');
  const rr = analyze(d);
  check('未引用依赖标 usedInSource=false 并建议删掉', () => {
    const m = rr.redundantFound.find(x => x.name === 'moment');
    assert.strictEqual(m.usedInSource, false);
    assert.ok(rr.suggestions.some(s => s.includes('删掉 moment')));
  });
}

// 9) ESM import 形式也要能检出引用
{
  const d = tmpdir('idiot-esm-');
  write(d, 'package.json', { type: 'module', dependencies: { axios: '^1' } });
  write(d, 'app.mjs', "import axios from 'axios';\nexport default axios;\n");
  const rr = analyze(d);
  check('ESM import 也能标记为在用', () => {
    const a = rr.redundantFound.find(x => x.name === 'axios');
    assert.ok(a, '未检出 axios');
    assert.strictEqual(a.usedInSource, true);
  });
}

// 10) bareimport 'axios' （无 from）也要识别
{
  const d = tmpdir('idiot-bare-');
  write(d, 'package.json', { dependencies: { axios: '^1' } });
  write(d, 'a.js', "import 'axios';\n");
  const rr = analyze(d);
  check("import 'axios' 裸导入被识别", () => {
    const a = rr.redundantFound.find(x => x.name === 'axios');
    assert.ok(a && a.usedInSource, '未识别裸导入');
  });
}

// 11) 子路径导入 lodash/fp 也要算 lodash 在用
{
  const d = tmpdir('idiot-sub-');
  write(d, 'package.json', { dependencies: { lodash: '^4' } });
  write(d, 'a.js', "const fp = require('lodash/fp');\nmodule.exports = fp;\n");
  const rr = analyze(d);
  check('子路径 lodash/fp 算 lodash 在用', () => {
    const l = rr.redundantFound.find(x => x.name === 'lodash');
    assert.ok(l && l.usedInSource, '子路径未被识别');
  });
}

// 12) bareName 不应把相对路径/内置模块当裸包
check('bareName 过滤相对路径与 node: 内置', () => {
  assert.strictEqual(bareName('./x'), null);
  assert.strictEqual(bareName('../x'), null);
  assert.strictEqual(bareName('node:fs'), null);
  assert.strictEqual(bareName('lodash'), 'lodash');
  assert.strictEqual(bareName('lodash/fp'), 'lodash');
  assert.strictEqual(bareName('@scope/pkg/sub'), '@scope/pkg');
});

// 13) monorepo：子包的冗余依赖也必须被检出
{
  const d = tmpdir('idiot-mono-');
  write(d, 'package.json', { name: 'root', workspaces: ['packages/*'] });
  write(d, 'packages/a/package.json', { name: 'a', dependencies: { moment: '^2' } });
  write(d, 'packages/a/src/x.js', 'module.exports = 1;\n');
  const rr = analyze(d);
  check('monorepo 子包 moment 被检出且标注来源', () => {
    const m = rr.redundantFound.find(x => x.name === 'moment');
    assert.ok(m, '子包 moment 被漏掉');
    assert.strictEqual(m.declaredIn, 'packages/a/package.json');
    assert.ok(rr.manifestsFound >= 2, '应发现 2 个 manifest，实际 ' + rr.manifestsFound);
  });
}

// 14) rel 必须是相对扫描根，不得退化成 ..\..\..
{
  const d = tmpdir('idiot-rel-');
  write(d, 'src/x.js', 'module.exports = 1;\n');
  const rr = analyze(d);
  check('rel 不含 .. 且不含绝对路径', () => {
    assert.ok(rr.topFiles.length > 0, '应扫到 src/x.js');
    for (const f of rr.topFiles) {
      assert.ok(!f.rel.includes('..'), 'rel 含 ..: ' + f.rel);
      assert.ok(!/^[A-Za-z]:/.test(f.rel), 'rel 是绝对路径: ' + f.rel);
      assert.ok(!f.rel.includes('\\'), 'rel 应统一用 / : ' + f.rel);
    }
  });
}

// 15) strictUsage 模式只对未引用项计分
{
  const d = tmpdir('idiot-strict-');
  write(d, 'package.json', { dependencies: { lodash: '^4', moment: '^2' } });
  write(d, 'a.js', "const _ = require('lodash');\nmodule.exports = _;\n");
  const loose = analyze(d);
  const strict = analyze(d, { requireUsage: true });
  check('strictUsage 下在用依赖不计分', () => {
    assert.strictEqual(loose.strictUsage, false);
    assert.strictEqual(strict.strictUsage, true);
    assert.ok(!strict.countedForPenalty.includes('lodash'),
      'lodash 在用，不该计分: ' + JSON.stringify(strict.countedForPenalty));
    assert.ok(strict.countedForPenalty.includes('moment'),
      'moment 未引用，应计分');
    assert.ok(strict.score < loose.score,
      '严格模式分数应更低: ' + strict.score + ' vs ' + loose.score);
  });
}

// 16) maxNesting 忽略注释与字符串里的花括号
check('maxNesting 跳过字符串/注释', () => {
  assert.strictEqual(maxNesting('const a = "{".repeat(10);'), 0);
  assert.strictEqual(maxNesting('// { { {\nconst x=1;'), 0);
  assert.strictEqual(maxNesting('/* { { { */\nconst x=1;'), 0);
  assert.strictEqual(maxNesting('function f(){ if(1){ if(2){ if(3){ } } } }'), 4);
});

// 17) REDUNDANT 的 requires 字段必须自洽（替代方案有版本门槛就不能说「无条件删」）
check('REDUNDANT.requires 均为 null 或正整数', () => {
  for (const [name, v] of Object.entries(REDUNDANT)) {
    assert.ok(v && typeof v.repl === 'string' && v.repl.length > 0, name + ' repl 缺失');
    assert.ok(v.requires === null || (Number.isInteger(v.requires) && v.requires > 0),
      name + ' requires 非法: ' + v.requires);
  }
});

// 18) 替代方案需要高版本 Node 时，建议里必须带版本提示
{
  const d = tmpdir('idiot-nodever-');
  write(d, 'package.json', { dependencies: { glob: '^10' } });
  write(d, 'a.js', "const g = require('glob');\nmodule.exports = g;\n");
  const rr = analyze(d);
  check('glob(Node22+) 在用时建议带版本门槛', () => {
    const s = rr.suggestions.find(x => x.includes('glob'));
    assert.ok(s, '缺 glob 建议');
    assert.ok(/Node 22/.test(s), '应提示 Node 版本门槛: ' + s);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(`\n自测完成：${passed} 项通过。`);
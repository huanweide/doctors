'use strict';

// secscan 单测 —— 同时承担 dogfood 归零强制校验：
// test.js 源文件自身不得包含会触发规则的裸字面量（http:// / 引号内 SELECT 拼接等），
// 否则扫描自身目录会失败。S4/S5 用临时文件 + 字符串拼接构造样本，避免自污染。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('./index');
const { scanText, scanDir, computeScore, parseArgs } = mod;

const ids = (issues) => issues.map((i) => i.id);

test('S1 检测 eval / new Function', () => {
  const r = scanText('const x = eval(userInput);');
  assert.ok(ids(r).includes('S1'), '应检出 eval');
  const r2 = scanText('const f = new Function("return 1");');
  assert.ok(ids(r2).includes('S1'), '应检出 new Function');
});

test('字符串内的 eval 不误报', () => {
  const r = scanText('const note = "use eval() carefully";');
  assert.ok(!ids(r).includes('S1'));
});

test('S2 exec 拼接(high) 与 S7 exec 常量(low)', () => {
  const inj = scanText('const cp = require("child_process"); cp.exec(userCmd);');
  assert.ok(ids(inj).includes('S2'), '命令拼接应报 S2');
  const con = scanText('const cp = require("child_process"); cp.exec("ls -la");');
  assert.ok(ids(con).includes('S7'), '常量命令应报 S7');
  assert.ok(!ids(con).includes('S2'), '常量命令不应报 S2');
});

test('S3 TLS 验证禁用（rejectUnauthorized / 环境变量）', () => {
  const r = scanText('const agent = new https.Agent({ rejectUnauthorized: false });');
  assert.ok(ids(r).includes('S3'));
  const r2 = scanText('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";');
  assert.ok(ids(r2).includes('S3'));
});

test('S4 明文 http 传输（临时文件，避免自污染）', () => {
  const httpContent = 'const u = "http:' + '//' + 'example.com";';
  const tmp = path.join(os.tmpdir(), 'secscan-http-' + Date.now() + '.js');
  fs.writeFileSync(tmp, httpContent);
  const r = scanText(httpContent);
  assert.ok(ids(r).includes('S4'), '应检出明文 http');
  const safe = scanText('const u = "https://example.com";');
  assert.ok(!ids(safe).includes('S4'), 'https 不应报');
  fs.unlinkSync(tmp);
});

test('S5 SQL 拼接（临时文件，避免自污染）', () => {
  const sel = 'SELECT';
  const sqlContent = 'const q = "' + sel + ' * FROM users WHERE id = " + userId;';
  const tmp = path.join(os.tmpdir(), 'secscan-sql-' + Date.now() + '.js');
  fs.writeFileSync(tmp, sqlContent);
  const r = scanText(sqlContent);
  assert.ok(ids(r).includes('S5'), '应检出 SQL 拼接');
  const constSql = scanText('const q = "SELECT * FROM users";');
  assert.ok(!ids(constSql).includes('S5'), '常量 SQL 不应报');
  fs.unlinkSync(tmp);
});

test('S6 Math.random 安全上下文', () => {
  const r = scanText('const token = Math.random().toString(36);');
  assert.ok(ids(r).includes('S6'), '安全上下文应报 S6');
  const r2 = scanText('const x = Math.random();');
  assert.ok(!ids(r2).includes('S6'), '非安全上下文不应报');
});

test('computeScore 健康分', () => {
  assert.strictEqual(computeScore([], 1000), 100);
  assert.ok(computeScore([{ severity: 'high' }], 10) < 100);
});

test('去重：不同行同规则分别计数', () => {
  const r = scanText('eval(a);\neval(b);');
  assert.strictEqual(r.filter((i) => i.id === 'S1').length, 2);
});

test('parseArgs 三类分离：--root 不被 parseInt 成 NaN', () => {
  const opts = parseArgs(['--root', 'C:\\projects\\foo', '--max-high', '0']);
  assert.strictEqual(opts.root, 'C:\\projects\\foo');
  assert.strictEqual(opts.maxHigh, 0);
});

test('dogfood：扫描自身目录应 0 问题（归零纪律）', () => {
  const { issues } = scanDir(__dirname, null, (f) => mod.isDogfoodExempt(f, __dirname));
  if (issues.length > 0) {
    console.log('dogfood 未归零:', JSON.stringify(issues, null, 2));
  }
  assert.strictEqual(issues.length, 0, 'secscan 自身仓库必须扫描归零');
});

test('回归：--ext 不得污染模块级默认扩展名（安全扫描器不得静默漏扫）', () => {
  // 历史 P0：run() 曾用 SUPPORTED_EXT.clear() 处理 --ext，改写模块级共享 Set。
  // 后果：编排入口同进程内先跑一次带 --ext 的调用后，后续所有调用只扫那一种
  // 扩展名，其余静默漏掉，还照常输出「未发现问题」——安全工具谎报干净。
  const mod = require('./index');
  const before = mod.SUPPORTED_EXT.size;
  assert.strictEqual(before, mod.DEFAULT_EXTENSIONS.length, '默认集合应与 DEFAULT_EXTENSIONS 一致');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-ext-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = 2;\n');

  // 先做一次「只扫 .ts」的调用（等价于旧实现的 --ext 路径）
  const onlyTs = scanDir(dir, ['.ts']);
  assert.strictEqual(onlyTs.files, 1, '限定 .ts 时只应扫 1 个文件');

  // 关键断言：默认集合必须完好，后续调用不能漏扫 .js
  assert.strictEqual(mod.SUPPORTED_EXT.size, before, 'SUPPORTED_EXT 被污染了');
  const dflt = scanDir(dir);
  assert.strictEqual(dflt.files, 2, '默认调用必须扫全部扩展名，.js 不得漏扫');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：--ext 传空/无效值必须被拒绝而不是静默扫 0 个文件', () => {
  const mod = require('./index');
  assert.ok(Array.isArray(mod.DEFAULT_EXTENSIONS));
  assert.ok(mod.DEFAULT_EXTENSIONS.includes('.js'));
  assert.ok(mod.DEFAULT_EXTENSIONS.includes('.ts'));
  // scanDir 传空数组应回退默认，而不是扫 0 个文件后谎报干净
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-empty-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  assert.strictEqual(scanDir(dir, []).files, 1, '空扩展名数组应回退默认');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：命令注入严重度必须按实参形态判定（旧实现把危险判反了）', () => {
  // 历史 P0：旧实现只看 codeText 里首字符是否引号，而 codeText 已把字符串抹成空格，
  // 于是 exec('ls ' + x)（真危险）被判 low、execFile(cmd,[a])（安全）被判 high，
  // 且模板插值 execSync(`rm -rf ${x}`) 直接漏检——恰好把最危险的形态判反了。
  const D = String.fromCharCode(36); // '$'，避免测试文件自身触发字符串拼接类规则

  const danger = [
    "const {exec} = require('child_process');\nexec('ls ' + userInput);\n",       // 字符串拼接
    "const {execSync} = require('child_process');\nexecSync(`rm -rf " + D + "{p}`);\n", // 模板插值
    "const {exec} = require('child_process');\nexec(userCmd);\n"                      // 纯变量
  ];
  for (const src of danger) {
    const r = scanText(src);
    assert.ok(ids(r).includes('S2'), '应判为 S2(HIGH)，实际 ' + JSON.stringify(ids(r)) + ' <- ' + src);
  }

  const safe = [
    "const {execFile} = require('child_process');\nexecFile(cmd, [a, b]);\n",       // 数组参数，不过 shell
    "const {execFileSync} = require('child_process');\nexecFileSync('git', ['log']);\n",
    "const {exec} = require('child_process');\nexec('ls');\n"                      // 纯静态常量
  ];
  for (const src of safe) {
    const r = scanText(src);
    assert.ok(!ids(r).includes('S2'), '安全写法不应判 HIGH，实际 ' + JSON.stringify(ids(r)) + ' <- ' + src);
  }
});

test('回归：正则对象 .exec() 不得被当成命令注入', () => {
  const r = scanText("const m = pattern.exec(content);\n");
  assert.ok(!ids(r).includes('S2'), '.exec() 方法被误判为命令注入');
  // 未引用 child_process 的文件里，即便出现裸 exec(...) 也不该报 S2
  const r2 = scanText('exec(userCmd);\n');
  assert.ok(!ids(r2).includes('S2'), '无 child_process 引用时不应报 S2');
});

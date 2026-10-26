#!/usr/bin/env node
'use strict';
//端到端冒烟：真实子进程调用 CLI，验证退出码契约与输出行为。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'index.js');
let pass = 0, fail = 0;

function run(args, cwd) {
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lg-smoke-')); }

function makePkg(dir, name, license) {
  const p = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }));
}

function makeRoot(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
}

const roots = [];
function cleanup() { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); }

// 1. 干净场景：声明已装齐 + 宽松许可 -> 0
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'a', version: '1.0.0', dependencies: { foo: '^1.0.0' } });
  makePkg(root, 'foo', 'MIT');
  const r = run([root, '--json']);
  check('干净宽松场景退出 0', r.code === 0, 'code=' + r.code);
  check('干净场景 basisComplete=true', /"basisComplete":\s*true/.test(r.out));
  check('干净场景 notInstalled=0', /"notInstalled":\s*0/.test(r.out));
}

// 2. 核心回归：声明 GPL 但未安装 -> 退出 3，绝不能是 0
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'b', version: '1.0.0', dependencies: { 'gpl-lib': '^1.0.0' } });
  const r = run([root, '--json']);
  check('声明未安装退出码为 3', r.code === 3, 'code=' + r.code);
  check('未安装依赖被列为 notInstalled', /"notInstalled":\s*1/.test(r.out));
  check('未安装依赖名字出现在输出里', /gpl-lib/.test(r.out));
  check('basisComplete=false', /"basisComplete":\s*false/.test(r.out));
}

// 3. --allow-missing -> 降级为 2（因unknown 计数），或 0？未安装按 unknown 计入，故 --fail-on unknown 时应为 2
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'c', version: '1.0.0', dependencies: { mystery: '^2.0.0' } });
  const r = run([root, '--allow-missing', '--fail-on', 'unknown']);
  check('--allow-missing + --fail-on unknown 退出 2', r.code === 2, 'code=' + r.code);
}

// 4. --allow-missing 单独使用 -> 0（展示但不再拒绝）
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'd', version: '1.0.0', dependencies: { mystery: '^2.0.0' } });
  const r = run([root, '--allow-missing']);
  check('--allow-missing 单独使用退出 0', r.code === 0, 'code=' + r.code);
}

// 5. 已装 GPL -> --fail-on strong 退出 2
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'e', version: '1.0.0', dependencies: { evil: '^1.0.0' } });
  makePkg(root, 'evil', 'GPL-3.0');
  const r = run([root, '--fail-on', 'strong']);
  check('已安装 GPL 命中 --fail-on strong 退出 2', r.code === 2, 'code=' + r.code);
  check('输出含强传染汇总', /强传染:1/.test(r.out));
}

// 6. 目标不存在 -> 退出 2，且不得输出假 JSON
{
  const r = run([path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()), '--json']);
  check('目标不存在退出 2', r.code === 2, 'code=' + r.code);
  check('目标不存在不得输出 packages JSON', !/"packages"/.test(r.out));
}

// 7. 空目录（无 manifest 无 node_modules）-> 退出 2
{
  const root = tmp(); roots.push(root);
  const r = run([root, '--json']);
  check('空目录退出 2', r.code === 2, 'code=' + r.code);
  check('空目录给出可读原因', /无从扫描|package\.json/.test(r.out));
}

// 8. 坏package.json -> 退出 2
{
  const root = tmp(); roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{{{');
  const r = run([root]);
  check('坏 package.json 退出 2', r.code === 2, 'code=' + r.code);
}

// 9. 参数错误
{
  check('--fail-on 非法值退出 2', run(['.', '--fail-on', 'nope']).code === 2);
  check('--max 非整数退出 2', run(['.', '--max', 'abc']).code === 2);
  check('未知选项退出 2', run(['.', '--bogus']).code === 2);
}

// 10. --help 退出 0 且含退出码说明
{
  const r = run(['--help']);
  check('--help 退出 0', r.code === 0);
  check('--help 说明退出码 3', /退出码/.test(r.out) && /3/.test(r.out));
}

// 11. --max 门禁
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'f', version: '1.0.0', dependencies: { bad: '1' } });
  makePkg(root, 'bad', 'AGPL-3.0');
  check('--max 0 命中强传染退出 2', run([root, '--max', '0']).code === 2);
  check('--max 5 宽松上限退出 0', run([root, '--max', '5']).code === 0);
}

// 12. 嵌套 node_modules 的 GPL 也算 strong
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'g', version: '1.0.0' });
  makePkg(root, 'outer', 'MIT');
  makePkg(path.join(root, 'node_modules', 'outer'), 'inner', 'AGPL-3.0');
  check('嵌套 GPL-AGPL 触发 strong 门禁', run([root, '--fail-on', 'strong']).code === 2);
}

// 13. scoped 依赖未安装也要被检出
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'h', version: '1.0.0', dependencies: { '@scope/pkg': '^1.0.0' } });
  const r = run([root, '--json']);
  check('scoped 未安装依赖被检出', r.code === 3 && /@scope\/pkg/.test(r.out));
}

// 14. --json 必须是合法 JSON
{
  const root = tmp(); roots.push(root);
  makeRoot(root, { name: 'i', version: '1.0.0', dependencies: { foo: '1' } });
  makePkg(root, 'foo', 'MIT');
  const r = run([root, '--json']);
  try {
    const j = JSON.parse(r.out);
    check('--json 可被 JSON.parse', j && typeof j.summary === 'object' && Array.isArray(j.packages));
  } catch (e) {
    check('--json 可被 JSON.parse', false, e.message);
  }
}

cleanup();
console.log(`\n# smoke pass ${pass}`);
console.log(`# smoke fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
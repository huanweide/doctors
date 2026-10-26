#!/usr/bin/env node
'use strict';
// 端到端冒烟：真实 spawn 子进程，验证退出码契约与 CLI 输出行为。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'index.js');
let pass = 0, fail = 0;

function run(args, cwd) {
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  // stdout 单独保留：--json 必须是可被 JSON.parse 的纯 JSON，
  // 不能把 stderr 的告警拼进去（踩过一次：拼了之后 parse 失败，误判成 CLI bug）
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function both(r) { return r.out + r.err; }

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p || 'ii-smoke-')); }
function write(root, rel, c) {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c, null, 2));
}
function json(out) { try { return JSON.parse(out); } catch { return null; } }

const dirs = [];
function cleanup() { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

// 1. 正常项目退出 0
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', { name: 'a', dependencies: {} });
  write(d, 'index.js', 'module.exports = 1;\n');
  const r = run([d, '--json']);
  check('正常项目退出 0', r.code === 0, 'code=' + r.code);
  const j = json(r.out);
  check('JSON 可解析且 basisComplete=true', j && j.basisComplete === true, r.out.slice(0, 120));
}

// 2. 核心回归：路径不存在 -> 退出 2（不是满分通过）
{
  const missing = path.join(os.tmpdir(), 'ii-not-here-' + Date.now());
  const r = run([missing, '--json']);
  check('路径不存在退出 2', r.code === 2, 'code=' + r.code);
  check('路径不存在给出可读原因', /不存在/.test(both(r)), both(r).slice(0, 120));
  check('路径不存在不得输出 score JSON', !/"score"/.test(r.out));
}

// 3. 核心回归：空目录 -> 退出 3（分数无意义）
{
  const d = tmp(); dirs.push(d);
  const r = run([d, '--json']);
  check('空目录退出 3', r.code === 3, 'code=' + r.code);
  const j = json(r.out);
  check('空目录 basisComplete=false', j && j.basisComplete === false);
  check('空目录 stderr 给出告警', /源码/.test(r.err), r.err.slice(0, 120));
}

// 4. --max 参数错误必须退 2，不能静默放行
check('--max 非整数退出 2', run(['.', '--max', 'abc']).code === 2);
check('--max 缺值退出 2', run(['.', '--max']).code === 2);
check('未知选项退出 2', run(['.', '--bogus']).code === 2);
{
  const r = run(['.', '--max', 'abc']);
  check('--max 错误给出可读信息', /--max/.test(both(r)));
}

// 5. --max 门禁
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', {
    name: 'fat',
    dependencies: { lodash: '^4', moment: '^2', axios: '^1', uuid: '^9', chalk: '^5', glob: '^10' },
  });
  write(d, 'a.js', 'module.exports = 1;\n');
  check('--max 0 时胖项目退出 1', run([d, '--max', '0']).code === 1);
  check('--max 100 时胖项目退出 0', run([d, '--max', '100']).code === 0);
  const g = run([d, '--max', '0']);
  check('门禁失败输出含 CI 字样', /\[CI\]/.test(both(g)), both(g).slice(0, 150));
}

// 6. strictUsage 生效并体现在 JSON
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', { name: 'u', dependencies: { lodash: '^4', moment: '^2' } });
  write(d, 'a.js', "const _ = require('lodash');\nmodule.exports = _;\n");
  const loose = json(run([d, '--json']).out);
  const strict = json(run([d, '--json', '--require-usage']).out);
  check('默认 strictUsage=false', loose && loose.strictUsage === false);
  check('开启后 strictUsage=true', strict && strict.strictUsage === true);
  check('严格模式计分项排除在用依赖',
    strict && !strict.countedForPenalty.includes('lodash'));
  check('严格模式分数更低',
    loose && strict && strict.score < loose.score,
    loose && strict ? loose.score + ' vs ' + strict.score : 'n/a');
}

// 7. 普通报告输出里 [在用] / [未引用] 必须区分
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', { name: 'x', dependencies: { lodash: '^4', moment: '^2' } });
  write(d, 'a.js', "const _ = require('lodash');\nmodule.exports = _;\n");
  const r = run([d]);
  check('报告区分 [在用]', /\[在用\] lodash/.test(r.out), r.out);
  check('报告区分 [未引用]', /\[未引用\].*moment/.test(r.out), r.out);
  check('报告不得建议删掉在用的 lodash', !/删掉 lodash/.test(r.out));
}

// 8. monorepo 子包检出
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', { name: 'root', workspaces: ['packages/*'] });
  write(d, 'packages/a/package.json', { name: 'a', dependencies: { moment: '^2' } });
  write(d, 'packages/a/src/x.js', 'module.exports = 1;\n');
  const j = json(run([d, '--json']).out);
  check('monorepo 子包依赖被检出',
    j && j.redundantFound.some(x => x.name === 'moment'), JSON.stringify(j && j.redundantFound));
  check('monorepo 标注来源 package.json',
    j && j.redundantFound.some(x => x.declaredIn === 'packages/a/package.json'));
  check('报告 rel 不含 ..', j && j.topFiles.every(f => !f.rel.includes('..')),
    JSON.stringify(j && j.topFiles.map(f => f.rel)));
}

// 9. --help 退出 0 且说明退出码
{
  const r = run(['--help']);
  check('--help 退出 0', r.code === 0);
  check('--help 说明 basisComplete', /basisComplete/.test(r.out));
  check('--help 说明退出码 3', /退出码/.test(r.out) && /3/.test(r.out));
}

// 10. 目标是文件而非目录 -> 退出 2
{
  const d = tmp(); dirs.push(d);
  const f = write(d, 'x.txt', 'hello');
  check('目标是文件退出 2', run([f]).code === 2);
}

// 11. dist / node_modules 必须被跳过（防止自扫时把构建产物算进去）
{
  const d = tmp(); dirs.push(d);
  write(d, 'package.json', { name: 's', dependencies: { moment: '^2' } });
  write(d, 'index.js', 'module.exports = 1;\n');
  write(d, 'dist/bundle.js', 'function a(){'.repeat(60));
  write(d, 'node_modules/moment/index.js', 'module.exports=1;');
  const j = json(run([d, '--json']).out);
  check('dist 被跳过', j && !j.topFiles.some(f => f.rel.includes('dist')), JSON.stringify(j && j.topFiles.map(f => f.rel)));
  check('node_modules 被跳过', j && !j.topFiles.some(f => f.rel.includes('node_modules')));
}

cleanup();
console.log(`\n# smoke pass ${pass}`);
console.log(`# smoke fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
#!/usr/bin/env node
'use strict'

/*
 * secscan 端到端冒烟：CLI 行为 + 退出码契约 + 「不得静默漏扫」铁律
 *
 * 存在理由：secscan 是安全扫描器，它最坏的失败不是误报，而是「谎报干净」。
 * 本脚本专门盯两类谎报：① --ext 污染共享状态导致后续漏扫；② 路径/参数错误时
 * 仍输出「未发现问题」并以 0 退出（CI 会误判为通过）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'index.js')
const NODE = process.execPath

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fails.push(name + (extra ? ' -> ' + extra : ''))
}

function run(args) {
  try {
    const out = cp.execFileSync(NODE, [CLI].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() }
  }
}

// 准备 fixture：.js 与 .ts 各含一处 eval
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-smoke-'))
fs.writeFileSync(path.join(dir, 'a.js'), 'const a = eval(userInput);\n')
fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = eval(userInput);\n')
fs.writeFileSync(path.join(dir, 'notes.md'), '# 不是源码\n')

// 1) 默认扫描必须覆盖 .js 与 .ts（2 个文件），排除 .md
const r1 = run(['--json', dir])
const p1 = (() => { try { return JSON.parse(r1.out) } catch (e) { return null } })()
ok('默认扫描退出码 0', r1.code === 0, 'code=' + r1.code)
ok('默认扫描解析为 JSON', p1 !== null)
ok('默认扫描覆盖 .js + .ts 共 2 个文件', p1 && p1.files === 2, p1 && ('files=' + p1.files))
ok('检出 S1 eval', p1 && p1.issues.some(i => i.id === 'S1'))
ok('S1 为 high 级', p1 && p1.issues.every(i => i.id !== 'S1' || i.severity === 'high'))

// 2) --ext 限定只扫 .ts：必须恰好 1 个文件，且是 b.ts
const r2 = run(['--json', '--ext', 'ts', dir])
const p2 = (() => { try { return JSON.parse(r2.out) } catch (e) { return null } })()
ok('--ext ts 只扫 1 个文件', p2 && p2.files === 1, p2 && ('files=' + p2.files))

// 3) 铁律：--ext 调用之后，另起进程默认扫描仍必须扫全（子进程隔离后天然成立，
//    这里额外验证同进程内 scanDir 不被污染）
const mod = require(path.join(ROOT, 'index.js'))
const sizeBefore = mod.SUPPORTED_EXT.size
mod.scanDir(dir, ['.ts'])
ok('同进程 scanDir(限定) 不改变默认扩展名集合', mod.SUPPORTED_EXT.size === sizeBefore,
  sizeBefore + ' -> ' + mod.SUPPORTED_EXT.size)
ok('同进程默认 scanDir 仍扫 2 个文件', mod.scanDir(dir).files === 2)

// 4) 路径错误必须非 0 退出，绝不能输出「未发现问题」
const missing = run(['--json', path.join(dir, 'no-such-dir')])
ok('目录不存在 -> 非 0 退出', missing.code !== 0, 'code=' + missing.code)
ok('目录不存在 -> 报错到 stderr', /根目录不存在/.test(missing.err), missing.err.trim())
ok('目录不存在 -> stdout 无 JSON 假结果', !/\"files\"/.test(missing.out))

// 5) 未知参数必须非 0 退出
const bad = run(['--definitely-unknown-flag'])
ok('未知参数 -> 非 0 退出', bad.code !== 0, 'code=' + bad.code)

// 6) --ext 传空值必须被拒绝，而不是静默扫 0 个文件后报「干净」
const emptyExt = run(['--json', '--ext', ',,', dir])
ok('--ext 空值 -> 非 0 退出', emptyExt.code !== 0, 'code=' + emptyExt.code)
ok('--ext 空值 -> 不输出谎报干净的 JSON', !/\"files\": 0/.test(emptyExt.out), emptyExt.out.slice(0, 100))

// 7) 门禁语义：--fail-on-high 在有 high 时必须失败
const gate = run(['--fail-on-high', dir])
ok('--fail-on-high 有 high 时 -> 非 0 退出', gate.code !== 0, 'code=' + gate.code)

const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-clean-'))
fs.writeFileSync(path.join(clean, 'ok.js'), 'const a = 1;\n')
const gate2 = run(['--fail-on-high', clean])
ok('干净目录 --fail-on-high -> 退出码 0', gate2.code === 0, 'code=' + gate2.code)
ok('干净目录报告未发现问题', /未发现安全反模式/.test(gate2.out), gate2.out.trim())

// 8) --help / --version
const h = run(['--help'])
ok('--help -> 0 退出', h.code === 0)
const v = run(['--version'])
ok('--version -> 0 退出且含版本号', v.code === 0 && /secscan v\d+\.\d+\.\d+/.test(v.out), v.out.trim())

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(clean, { recursive: true, force: true })

if (fails.length) {
  process.stderr.write('冒烟失败 ' + fails.length + ' 项:\n')
  for (const f of fails) process.stderr.write('  - ' + f + '\n')
  process.exit(1)
}
process.stdout.write('冒烟通过: ' + pass + ' 项断言全绿（含「不得静默漏扫」铁律与退出码契约）\n')
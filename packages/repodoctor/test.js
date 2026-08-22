'use strict'

// repodoctor 测试：纯函数单测 + 临时 git 仓库集成测试（端到端真实信号）
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const cp = require('child_process')

const ROOT = __dirname
const INDEX = path.join(ROOT, 'index.js')
const repodoctor = require('./index.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    process.stdout.write('  ok   ' + name + '\n')
  } catch (e) {
    fail++
    process.stdout.write('  FAIL ' + name + ' -> ' + e.message + '\n')
  }
}

// ---------- 纯函数单测 ----------
t('score 空问题 = 100', () => {
  assert.strictEqual(repodoctor.score([]).score, 100)
})
t('score HIGH 扣分 12', () => {
  const s = repodoctor.score([{ severity: 'high' }]).score
  assert.strictEqual(s, 88)
})
t('score MED 扣分 6 / LOW 扣分 3', () => {
  assert.strictEqual(repodoctor.score([{ severity: 'medium' }]).score, 94)
  assert.strictEqual(repodoctor.score([{ severity: 'low' }]).score, 97)
})
t('score 封底 0', () => {
  const many = []
  for (let i = 0; i < 20; i++) many.push({ severity: 'high' })
  assert.strictEqual(repodoctor.score(many).score, 0)
})
t('checkDocs 缺 LICENSE/README + 缺锁文件', () => {
  const tracked = ['package.json', 'src/a.js']
  const issues = repodoctor.checkDocs('/x', tracked)
  const rules = issues.map(i => i.rule)
  assert.ok(rules.includes('G4'), '应缺 LICENSE')
  assert.ok(rules.includes('G5'), '应缺 README')
  assert.ok(rules.includes('G6'), 'package.json 无锁应报 G6')
})
t('checkDocs 齐全则归零', () => {
  const tracked = ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'src/a.js']
  assert.strictEqual(repodoctor.checkDocs('/x', tracked).length, 0)
})
t('SECRET_PATTERNS 命中真实密钥 / 不命中普通文本', () => {
  const wrap = (s) => ['x', '=', '"', s, '"'].join('')
  // 碎片化构造样本，避免测试文件自身被当密钥源字面量命中
  const ghTok = ['gho', '_', 'AbCdEfGhIjKlMnOpQrStUv'].join('')
  assert.ok(repodoctor.SECRET_PATTERNS.some(p => p.test(ghTok)))
  const openai = ['sk', '-', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('')
  assert.ok(repodoctor.SECRET_PATTERNS.some(p => p.test(openai)))
  assert.ok(!repodoctor.SECRET_PATTERNS.some(p => p.test('my token variable name here')))
})

// ---------- 集成测试（临时 git 仓库）----------
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  cp.execSync('git init -q', { cwd: dir })
  cp.execSync('git config user.email t@t.com', { cwd: dir })
  cp.execSync('git config user.name tester', { cwd: dir })
}
function commit(dir, msg) {
  cp.execSync('git add -A', { cwd: dir })
  cp.execSync('git commit -q -m "' + msg + '"', { cwd: dir })
}
function runDoctor(dir, extra) {
  const out = cp.execSync('node "' + INDEX + '" --json ' + (extra || '') + ' "' + dir + '"', { encoding: 'utf8' })
  return JSON.parse(out)
}

t('集成：干净仓库健康分 100', () => {
  const dir = path.join(os.tmpdir(), 'repodoctor-clean-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  makeRepo(dir)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n')
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1\n')
  commit(dir, 'feat: init project')
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 2\n')
  commit(dir, 'feat: refine logic')
  const r = runDoctor(dir)
  assert.strictEqual(r.score, 100, '干净仓库应得 100，实际 ' + r.score + ' issues=' + JSON.stringify(r.issues))
  assert.strictEqual(r.issues.length, 0)
})

t('集成：脏仓库检出 G1/G2/G3/G4/G5/G6', () => {
  const dir = path.join(os.tmpdir(), 'repodoctor-dirty-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  makeRepo(dir)
  // .env 含明文密钥（G1 危险文件 + G2 密钥）
  fs.writeFileSync(path.join(dir, '.env'), ['API_TOKEN', '=', '"', 'abcd1234efgh5678ijkl9012', '"'].join('') + '\n')
  // 大文件（用 --max-size 1 触发 G3）
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0))
  // 无 LICENSE / README
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"y"}\n') // 无锁 -> G6
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'console.log(1)\n')
  commit(dir, 'init')
  fs.appendFileSync(path.join(dir, 'src', 'b.js'), 'console.log(2)\n')
  commit(dir, 'update') // 噪声提交
  fs.appendFileSync(path.join(dir, 'src', 'b.js'), 'console.log(3)\n')
  commit(dir, 'fix') // 噪声提交
  fs.appendFileSync(path.join(dir, 'src', 'b.js'), 'console.log(4)\n')
  commit(dir, 'wip') // 噪声提交
  fs.appendFileSync(path.join(dir, 'src', 'b.js'), 'console.log(5)\n')
  commit(dir, 'tmp') // 噪声提交
  const r = runDoctor(dir, '--max-size 1 --history-depth 50')
  const rules = r.issues.map(i => i.rule)
  assert.ok(rules.includes('G1'), '应检出 .env 被跟踪')
  assert.ok(rules.includes('G2'), '应检出密钥泄露')
  assert.ok(rules.includes('G3'), '应检出大文件')
  assert.ok(rules.includes('G4'), '应缺 LICENSE')
  assert.ok(rules.includes('G5'), '应缺 README')
  assert.ok(rules.includes('G6'), '应缺锁文件')
  assert.ok(r.score < 100, '脏仓库应扣分')
})

t('集成：--fail-on-high 对脏仓库退出码 1', () => {
  const dir = path.join(os.tmpdir(), 'repodoctor-fail-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  makeRepo(dir)
  fs.writeFileSync(path.join(dir, '.env'), ['SECRET_KEY', '=', '"', 'abcd1234efgh5678ijkl9012', '"'].join('') + '\n')
  commit(dir, 'init')
  let code = 0
  try {
    cp.execSync('node "' + INDEX + '" --fail-on-high "' + dir + '"', { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    code = e.status
  }
  assert.strictEqual(code, 1, '--fail-on-high 应退出 1')
})

process.stdout.write('\nrepodoctor 测试: ' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail === 0 ? 0 : 1)

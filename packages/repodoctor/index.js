#!/usr/bin/env node
'use strict'

// repodoctor - Git 仓库卫生体检 CLI（零依赖单文件）
// 补 family 第八件套之外的「第九轴：工程/仓库卫生」。
// devdoctor 只扫源码层明文密钥；repodoctor 补 git 层面：
//   G1 危险文件/目录被提交进版本库 + 缺 .gitignore
//   G2 历史 + 当前明文密钥/凭证泄露
//   G3 大文件进版本库（应改用 Git LFS）
//   G4 缺 LICENSE / G5 缺 README
//   G6 有 package.json 但缺依赖锁文件
//   G7 无意义提交占比过高
//   G8 分支过多
// 输出人类可读报告 + --json + --fail-on-high / --min-score CI 门禁。

const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const VERSION = '1.0.0'

// 危险文件/目录：一旦被 git 跟踪即属卫生事故
const DANGEROUS_TRACKED = [
  { name: 'node_modules', why: '依赖目录不应入库' },
  { name: 'dist', why: '构建产物' },
  { name: 'build', why: '构建产物' },
  { name: 'coverage', why: '覆盖率产物' },
  { name: 'vendor', why: '第三方依赖' },
  { name: '.DS_Store', why: 'macOS 元数据' },
  { name: 'Thumbs.db', why: 'Windows 元数据' },
]

// 明文密钥/凭证模式（聚焦真实信号，避免误报）
// 注意：以下为正则构造，源码里不会出现 secret="..." 形式的赋值字面量，工具自扫归零。
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub personal/oauth/app tokens
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI / 通用 sk- 前缀
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /(api_key|apikey|secret|token|password|passwd|private_key|access_key)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{12,}['"]/i,
  /\bBearer\s+[A-Za-z0-9_\-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
]

// 大文件阈值默认 100MB；历史扫描深度默认 100 commits
const DEFAULT_MAX_SIZE_MB = 100
const DEFAULT_HISTORY_DEPTH = 100

// 参数三类分离（数值 / 路径 / 布尔），避免 cli 解析把路径当数字致 NaN 致命 bug
const NUM_FLAGS = { '--max-size': true, '--history-depth': true, '--min-score': true }
const STR_FLAGS = { '--root': true, '-r': true }
const BOOL_FLAGS = {
  '--json': true, '-q': true, '--quiet': true,
  '--fail-on-high': true, '-h': true, '--help': true, '-V': true, '--version': true,
}

function errExit(msg) {
  process.stderr.write('[x] ' + msg + '\n')
  process.exit(2)
}

// 调 git；allowFail=true 时返回 stdout 字符串（即使非零退出），否则失败返回 null
function git(args, root, allowFail) {
  try {
    return cp.execSync('git ' + args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    if (allowFail) return (e && e.stdout) ? e.stdout : ''
    return null
  }
}

function isGitRepo(root) {
  const r = git('rev-parse --is-inside-work-tree', root, true)
  return !!(r && r.trim() === 'true')
}

function listTracked(root) {
  const out = git('ls-files', root, true)
  if (!out) return []
  return out.split('\n').filter(Boolean)
}

// G1：危险文件被跟踪 + 缺 .gitignore
function checkDangerousTracked(root, tracked) {
  const issues = []
  for (const f of tracked) {
    const base = path.basename(f)
    const isEnv = base === '.env' || base.startsWith('.env.') || /^env\./i.test(base)
    if (isEnv) {
      issues.push({ rule: 'G1', severity: 'high', file: f, msg: '敏感环境文件被提交进版本库（可能含密钥/凭证）' })
      continue
    }
    const hit = DANGEROUS_TRACKED.find(d => d.name === base || f === d.name || f.startsWith(d.name + '/'))
    if (hit) {
      issues.push({ rule: 'G1', severity: 'high', file: f, msg: '危险目录/文件被跟踪：' + hit.name + '（' + hit.why + '）' })
    }
  }
  const hasGitignore = tracked.some(f => path.basename(f).toLowerCase() === '.gitignore') ||
    fs.existsSync(path.join(root, '.gitignore'))
  if (!hasGitignore) {
    issues.push({ rule: 'G1', severity: 'medium', file: '.gitignore', msg: '缺少 .gitignore，易误提交产物/密钥' })
  }
  return issues
}

// G2：当前文件内容 + 最近 N 个 commit 的 diff 历史 扫明文密钥
function checkSecrets(root, tracked, depth) {
  const issues = []
  const seen = new Set()
  const binaryRe = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|mp4|webm|mov|zip|gz|tgz|rar|7z|pdf|exe|dll|so|dylib|wasm|bin)$/i

  for (const f of tracked) {
    if (binaryRe.test(f)) continue
    if (f.length > 200) continue
    const full = path.join(root, f)
    let content = ''
    try {
      const st = fs.statSync(full)
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue // 5MB 跳过防 OOM
      content = fs.readFileSync(full, 'utf8')
    } catch (e) {
      continue
    }
    for (const pat of SECRET_PATTERNS) {
      const m = content.match(pat)
      if (m) {
        const key = f + ':' + pat.source
        if (seen.has(key)) continue
        seen.add(key)
        issues.push({ rule: 'G2', severity: 'high', file: f, msg: '疑似明文密钥/凭证（当前文件内容）：' + clip(m[0]) })
        break
      }
    }
  }

  // 历史泄露（含已删除但仍残留于 history 的密钥）
  let log = ''
  try {
    log = cp.execSync('git log -p -' + depth + ' --all --no-color', {
      cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    log = (e && e.stdout) ? e.stdout : ''
    if (!log) {
      process.stderr.write('[!] 警告：git 历史过大或读取失败，已跳过历史密钥深度扫描（仅扫描当前文件内容）\n')
    }
  }
  if (log) {
    for (const pat of SECRET_PATTERNS) {
      const m = log.match(pat)
      if (m) {
        issues.push({ rule: 'G2', severity: 'high', file: '<git history>', msg: '疑似密钥泄露于 git 历史（已删除也可能残留）：' + clip(m[0]) })
        break
      }
    }
  }
  return issues
}

// G3：大文件进版本库
function checkLargeFiles(root, maxSizeMB) {
  const issues = []
  const out = git('rev-list --objects --all', root, true)
  if (!out) return issues
  const blobPaths = new Map() // hash -> path（仅 blob 有 path）
  for (const line of out.split('\n')) {
    const idx = line.indexOf(' ')
    if (idx < 0) continue
    const hash = line.slice(0, idx)
    const p = line.slice(idx + 1).trim()
    if (!/^[0-9a-f]{40}$/.test(hash)) continue
    if (!p) continue // 无 path 的 commit/tree 行跳过
    if (!blobPaths.has(hash)) blobPaths.set(hash, p)
  }
  if (!blobPaths.size) return issues
  let check = ''
  try {
    check = cp.execSync('git cat-file --batch-check', {
      cwd: root, input: [...blobPaths.keys()].join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch (e) {
    return issues
  }
  const threshold = maxSizeMB * 1024 * 1024
  const best = new Map()
  for (const line of check.split('\n')) {
    const parts = line.split(' ')
    if (parts[1] !== 'blob') continue
    const size = parseInt(parts[2], 10)
    if (!Number.isFinite(size) || size < threshold) continue
    const p = blobPaths.get(parts[0])
    if (!p) continue
    const prev = best.get(p)
    if (!prev || size > prev) best.set(p, size)
  }
  for (const [p, size] of best) {
    issues.push({ rule: 'G3', severity: 'high', file: p, msg: '大文件进版本库（' + (size / 1024 / 1024).toFixed(1) + ' MB），应使用 Git LFS 或移除' })
  }
  return issues
}

// G4 LICENSE / G5 README / G6 锁文件
function checkDocs(root, tracked) {
  const issues = []
  const hasLicense = tracked.some(f => /^license(\.|$)/i.test(path.basename(f)))
  const hasReadme = tracked.some(f => /^readme(\.|$)/i.test(path.basename(f)))
  if (!hasLicense) {
    issues.push({ rule: 'G4', severity: 'medium', file: '(repo)', msg: '缺少 LICENSE 文件，开源授权不明' })
  }
  if (!hasReadme) {
    issues.push({ rule: 'G5', severity: 'medium', file: '(repo)', msg: '缺少 README 文件，项目无说明' })
  }
  if (tracked.includes('package.json')) {
    const hasLock = tracked.some(f => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/i.test(path.basename(f)))
    if (!hasLock) {
      issues.push({ rule: 'G6', severity: 'medium', file: '(repo)', msg: '存在 package.json 但缺少依赖锁文件，依赖不可复现' })
    }
  }
  return issues
}

// G7：无意义提交占比
const NOISE_RE = /^(update|updates|wip|fix|fixed|tmp|temp|test|testing|改动|修改|修复|更新|提交|xxx|\s*.?\s*)$/i
function checkCommitQuality(root) {
  const log = git('log --pretty=format:%s', root, true)
  if (!log) return []
  const msgs = log.split('\n').filter(Boolean)
  if (msgs.length < 5) return []
  let bad = 0
  for (const m of msgs) if (NOISE_RE.test(m.trim())) bad++
  const ratio = bad / msgs.length
  if (ratio >= 0.3) {
    return [{ rule: 'G7', severity: 'low', file: '(history)', msg: '无意义提交占比过高（' + Math.round(ratio * 100) + '% / ' + msgs.length + ' 次），建议规范提交信息' }]
  }
  return []
}

// G8：分支过多
function checkBranches(root) {
  const out = git('branch -a', root, true)
  if (!out) return []
  const count = out.split('\n').filter(l => l.trim() && !l.includes('HEAD')).length
  if (count > 15) {
    return [{ rule: 'G8', severity: 'low', file: '(repo)', msg: '分支过多（' + count + '），建议清理已合并 stale 分支' }]
  }
  return []
}

function clip(s) {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 28 ? flat.slice(0, 28) + '...' : flat
}

function score(issues) {
  let high = 0, med = 0, low = 0
  for (const i of issues) {
    if (i.severity === 'high') high++
    else if (i.severity === 'medium') med++
    else low++
  }
  const s = 100 - Math.min(100, high * 12 + med * 6 + low * 3)
  return { score: Math.max(0, s), high, med, low }
}

const SEV_LABEL = { high: 'HIGH', medium: 'MED ', low: 'LOW ' }
const RULE_LABEL = {
  G1: '危险文件/忽略', G2: '密钥泄露', G3: '大文件', G4: 'LICENSE',
  G5: 'README', G6: '锁文件', G7: '提交卫生', G8: '分支卫生',
}

function printReport(root, issues, sc) {
  const abs = path.resolve(root)
  process.stdout.write('\n=== repodoctor 仓库卫生体检 ===\n')
  process.stdout.write('仓库: ' + abs + '\n')
  if (!issues.length) {
    process.stdout.write('结果: 未发现卫生问题，仓库干净。\n')
  } else {
    process.stdout.write('发现问题 ' + issues.length + ' 项：\n')
    for (const i of issues) {
      const sev = SEV_LABEL[i.severity]
      const rule = RULE_LABEL[i.rule] || i.rule
      const fileShow = i.file === '(repo)' ? '(仓库整体)' : (i.file === '(history)' ? '(提交历史)' : i.file)
      process.stdout.write('  [' + sev + '] ' + rule + '  ' + fileShow + '\n')
      process.stdout.write('         ' + i.msg + '\n')
    }
  }
  process.stdout.write('\n健康分: ' + sc.score + ' / 100  (HIGH ' + sc.high + ' / MED ' + sc.med + ' / LOW ' + sc.low + ')\n')
}

function printHelp() {
  process.stdout.write(
    'repodoctor - Git 仓库卫生体检 CLI（零依赖单文件）\n\n' +
    '用法: repodoctor [选项] [仓库路径]\n\n' +
    '选项:\n' +
    '  -r, --root <dir>        目标仓库路径（默认当前目录）\n' +
    '  --max-size <MB>         大文件阈值，默认 ' + DEFAULT_MAX_SIZE_MB + '\n' +
    '  --history-depth <n>     扫描最近 n 个 commit 的 diff，默认 ' + DEFAULT_HISTORY_DEPTH + '\n' +
    '  --min-score <n>         健康分低于 n 则退出码 1（CI 门禁）\n' +
    '  --fail-on-high          存在任意 HIGH 问题则退出码 1（CI 门禁）\n' +
    '  --json                  输出 JSON\n' +
    '  -q, --quiet             仅输出摘要\n' +
    '  -V, --version           版本号\n' +
    '  -h, --help              帮助\n'
  )
}

function main() {
  const args = process.argv.slice(2)
  let root = process.cwd()
  let maxSizeMB = DEFAULT_MAX_SIZE_MB
  let depth = DEFAULT_HISTORY_DEPTH
  let minScore = NaN
  let json = false
  let quiet = false
  let failOnHigh = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-V' || a === '--version') { process.stdout.write(VERSION + '\n'); process.exit(0) }
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0) }
    if (a === '--json') { json = true; continue }
    if (a === '-q' || a === '--quiet') { quiet = true; continue }
    if (a === '--fail-on-high') { failOnHigh = true; continue }
    if (a === '--root' || a === '-r') {
      const v = args[++i]
      if (v === undefined) errExit('--root 需要一个目录参数')
      root = v
      continue
    }
    if (a === '--max-size') {
      const v = parseInt(args[++i], 10)
      if (!Number.isFinite(v)) errExit('--max-size 必须是一个整数（MB）')
      maxSizeMB = v
      continue
    }
    if (a === '--history-depth') {
      const v = parseInt(args[++i], 10)
      if (!Number.isFinite(v)) errExit('--history-depth 必须是一个整数')
      depth = v
      continue
    }
    if (a === '--min-score') {
      const v = parseInt(args[++i], 10)
      if (!Number.isFinite(v)) errExit('--min-score 必须是一个整数')
      minScore = v
      continue
    }
    if (a.startsWith('--') || a.startsWith('-')) errExit('未知选项: ' + a)
    root = a // 位置参数当作仓库路径
  }

  if (!isGitRepo(root)) {
    errExit(root + ' 不是 git 仓库（或相关 git 命令不可用）')
  }

  const tracked = listTracked(root)
  const issues = [].concat(
    checkDangerousTracked(root, tracked),
    checkSecrets(root, tracked, depth),
    checkLargeFiles(root, maxSizeMB),
    checkDocs(root, tracked),
    checkCommitQuality(root),
    checkBranches(root)
  )

  const sc = score(issues)

  if (json) {
    process.stdout.write(JSON.stringify({ root: path.resolve(root), score: sc.score, high: sc.high, med: sc.med, low: sc.low, issues }, null, 2) + '\n')
  } else if (quiet) {
    process.stdout.write('repodoctor: 健康分 ' + sc.score + ' (HIGH ' + sc.high + ' / MED ' + sc.med + ' / LOW ' + sc.low + ')\n')
  } else {
    printReport(root, issues, sc)
  }

  if (failOnHigh && sc.high > 0) process.exit(1)
  if (Number.isFinite(minScore) && sc.score < minScore) process.exit(1)
  process.exit(0)
}

if (require.main === module) {
  main()
}

module.exports = {
  score,
  checkDangerousTracked,
  checkDocs,
  checkCommitQuality,
  checkBranches,
  checkSecrets,
  checkLargeFiles,
  isGitRepo,
  listTracked,
  SECRET_PATTERNS,
}

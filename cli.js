#!/usr/bin/env node
'use strict';

// doctors —— 代码健康体检全家桶统一入口
// 调度 packages/ 下 21 个零依赖单文件 CLI（八核 + 十三散轴归位）：
//   a11y    a11ydoctor   Web 可访问性静态扫描
//   commit  commitdoctor git 提交消息规范体检
//   dev     devdoctor    四维项目体检（bloat/license/cycles/secrets）
//   doc     docdoctor    Markdown 文档健康体检
//   pkg     pkgdoctor    package.json 配置卫生
//   rel     reldoctor    发布卫生（version/tag/CHANGELOG 一致性）
//   repo    repodoctor   Git 仓库卫生（危险文件/密钥/大文件/LICENSE/README）
//   type    typedoctor   类型纪律（any 密度）健康体检
//   sec     secscan      安全反模式（eval/exec/弱随机/SQL 拼接/明文 http）
//   cyc     cycscan      结构复杂度（圈复杂度 + 函数长度）
//   dup     dupscan      重复代码块（行级 n-gram 滑窗）
//   lit     litdoctor    硬编码魔法值 / 重复字面量
//   debug   debugdoctor  调试与日志残留（debugger/console/print）
//   debt    debtlens     技术债密度（注释锚定 TODO/FIXME/HACK…）
//   await   awaitscan    异步性能反模式（循环串行 await 等）
//   chain   chaineye     依赖链影响面（改了 X，谁会受影响）
//   gha     ghadoctor    GitHub Actions 配置卫生
//   lic     licguard     依赖许可证合规（强 copyleft 门禁）
//   idiot   idiot-index  白痴指数（冗余依赖 + 过度工程）
//   test    testlite     测试卫生体检（框架/密度/零测试警告）
//   eng     enghealth    家族元仪表盘（一次命令聚合多轴总分）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKGS_DIR = path.join(__dirname, 'packages');
const VERSION = (() => {
  try {
    return require('./package.json').version;
  } catch {
    return '1.0.0';
  }
})();

const SUBCOMMANDS = {
  a11y: 'a11ydoctor',
  commit: 'commitdoctor',
  dev: 'devdoctor',
  doc: 'docdoctor',
  pkg: 'pkgdoctor',
  rel: 'reldoctor',
  repo: 'repodoctor',
  type: 'typedoctor',
  sec: 'secscan',
  cyc: 'cycscan',
  dup: 'dupscan',
  lit: 'litdoctor',
  debug: 'debugdoctor',
  debt: 'debtlens',
  await: 'awaitscan',
  chain: 'chaineye',
  gha: 'ghadoctor',
  lic: 'licguard',
  idiot: 'idiot-index',
  test: 'testlite',
  eng: 'enghealth',
};

const DESCRIPTIONS = {
  a11y: 'Web 可访问性静态扫描（HTML/JSX/Vue/Svelte）',
  commit: 'git 提交消息规范体检',
  dev: '四维项目体检（bloat/license/cycles/secrets）',
  doc: 'Markdown 文档健康体检',
  pkg: 'package.json 配置卫生',
  rel: '发布卫生（version/tag/CHANGELOG 一致性）',
  repo: 'Git 仓库卫生（危险文件/密钥/大文件/LICENSE/README）',
  type: '类型纪律（any 密度）健康体检',
  sec: '安全反模式扫描（eval/exec/弱随机/SQL 拼接/明文 http）',
  cyc: '结构复杂度（圈复杂度 + 函数长度）',
  dup: '重复代码块检测',
  lit: '硬编码魔法值 / 重复字面量卫生',
  debug: '调试与日志残留（debugger/console/print）',
  debt: '技术债密度（TODO/FIXME/HACK 注释锚定）',
  await: '异步性能反模式（循环串行 await / map 内 await）',
  chain: '依赖链影响面（改了 X，谁会受影响）',
  gha: 'GitHub Actions 配置卫生',
  lic: '依赖许可证合规（GPL/AGPL 强 copyleft 门禁）',
  idiot: '白痴指数（可被原生替代的冗余依赖 + 过度工程）',
  test: '测试卫生体检（框架识别/密度/零测试警告）',
  eng: '家族元仪表盘（一次命令聚合多轴、给总分）',
};

// help 里的分层导航：21 个轴一次列平会失去可读性，按治理层分组。
const GROUPS = [
  { title: '源码层', keys: ['type', 'sec', 'cyc', 'dup', 'lit', 'debug', 'debt', 'await', 'a11y'] },
  { title: '依赖 / 架构层', keys: ['dev', 'pkg', 'lic', 'idiot', 'chain'] },
  { title: 'git / CI 层', keys: ['repo', 'commit', 'rel', 'gha'] },
  { title: '文档 / 测试层', keys: ['doc', 'test'] },
  { title: '元层（横切聚合）', keys: ['eng'] },
];

function printHelp() {
  console.log('');
  console.log('doctors v' + VERSION + ' —— 代码健康体检全家桶（21 轴零依赖 CLI）');
  console.log('');
  console.log('用法:  doctors <subcommand> [target] [options]');
  console.log('');
  console.log('说明:  所有子命令默认扫描「当前目录」，可传一个位置参数指定目录；');
  console.log('       rel / type 同时支持 --root <dir>；dev / test 需先选子模式。');
  console.log('');
  console.log('子命令:');
  for (const g of GROUPS) {
    console.log('  [' + g.title + ']');
    for (const key of g.keys) {
      if (!SUBCOMMANDS[key]) continue;
      console.log('    ' + key.padEnd(7) + '  ' + DESCRIPTIONS[key]);
    }
  }
  console.log('');
  console.log('示例:');
  console.log('  doctors repo   .                    # Git 仓库卫生');
  console.log('  doctors sec    ./src                # 安全反模式');
  console.log('  doctors cyc    ./src --max 20       # 圈复杂度门禁');
  console.log('  doctors gha    .                    # GitHub Actions 卫生');
  console.log('  doctors type   ./lib --json         # 类型纪律体检');
  console.log('  doctors dev    doctor .             # 四维体检（先选子模式）');
  console.log('  doctors --version                   # 查看版本');
  console.log('');
}

function main() {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

  if (sub === '--version' || sub === '-V') {
    console.log('doctors v' + VERSION);
    process.exit(0);
  }

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    process.exit(0);
  }

  const pkg = SUBCOMMANDS[sub];
  if (!pkg) {
    console.error('错误: 未知子命令 "' + sub + '"');
    printHelp();
    process.exit(2);
  }

  const pkgDir = path.join(PKGS_DIR, pkg);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error('错误: 找不到 ' + pkg + ' 的 package.json');
    process.exit(2);
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const binRel = typeof pkgJson.bin === 'object'
    ? Object.values(pkgJson.bin)[0]
    : (pkgJson.bin || 'index.js');
  const binAbs = path.join(pkgDir, binRel);

  if (!fs.existsSync(binAbs)) {
    console.error('错误: 找不到入口文件 ' + binAbs);
    process.exit(2);
  }

  const result = spawnSync(process.execPath, [binAbs, ...rest], { stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}

main();

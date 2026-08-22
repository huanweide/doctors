#!/usr/bin/env node
'use strict';

// doctors —— 代码健康体检全家桶统一入口
// 调度 packages/ 下八个零依赖单文件 CLI：
//   a11y    a11ydoctor   Web 可访问性静态扫描
//   commit  commitdoctor git 提交消息规范体检
//   dev     devdoctor    四维项目体检（bloat/license/cycles/secrets）
//   doc     docdoctor    Markdown 文档健康体检
//   pkg     pkgdoctor    package.json 配置卫生
//   rel     reldoctor    发布卫生（version/tag/CHANGELOG 一致性）
//   repo    repodoctor   Git 仓库卫生（危险文件/密钥/大文件/LICENSE/README）
//   type    typedoctor   类型纪律（any 密度）健康体检

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKGS_DIR = path.join(__dirname, 'packages');

const SUBCOMMANDS = {
  a11y: 'a11ydoctor',
  commit: 'commitdoctor',
  dev: 'devdoctor',
  doc: 'docdoctor',
  pkg: 'pkgdoctor',
  rel: 'reldoctor',
  repo: 'repodoctor',
  type: 'typedoctor',
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
};

function printHelp() {
  console.log('');
  console.log('doctors —— 代码健康体检全家桶（八件套零依赖 CLI）');
  console.log('');
  console.log('用法:  doctors <subcommand> [args...]');
  console.log('');
  console.log('子命令:');
  for (const key of Object.keys(SUBCOMMANDS)) {
    console.log('  ' + key.padEnd(7) + '  ' + DESCRIPTIONS[key]);
  }
  console.log('');
  console.log('示例:');
  console.log('  doctors a11y  ./src');
  console.log('  doctors repo  .');
  console.log('  doctors type  ./lib --json');
  console.log('');
}

function main() {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

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

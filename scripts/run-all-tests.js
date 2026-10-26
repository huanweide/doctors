#!/usr/bin/env node
'use strict';

// 聚合运行 packages/ 下所有 doctor 的自检
// 每个包的测试入口按以下顺序探测（cwd 始终设为包目录，保证相对路径不变）：
//   1. test.js              （多数轴：node:test 或自带 runner）
//   2. test/unit.test.js    （cycscan / debtlens / dupscan / litdoctor / debugdoctor）
// 之后若存在 CLI 冒烟脚本，也一并跑：
//   test/smoke-cli.js 或 scripts/smoke-cli.js
// 冒烟是 spawn 级退出码契约测试——单测全绿也可能门禁已失效，必须真起进程。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgsDir = path.join(__dirname, '..', 'packages');

const only = process.argv[2];
const pkgs = fs.readdirSync(pkgsDir).filter((n) => {
  if (only && n !== only) return false;
  return fs.statSync(path.join(pkgsDir, n)).isDirectory();
});

function entryFor(pkgDir) {
  const rootTest = path.join(pkgDir, 'test.js');
  if (fs.existsSync(rootTest)) return rootTest;
  const unitTest = path.join(pkgDir, 'test', 'unit.test.js');
  if (fs.existsSync(unitTest)) return unitTest;
  return null;
}

function smokesFor(pkgDir) {
  return [
    path.join(pkgDir, 'test', 'smoke-cli.js'),
    path.join(pkgDir, 'scripts', 'smoke-cli.js'),
  ].filter((p) => fs.existsSync(p));
}

let failed = 0;
let ran = 0;
const failedNames = [];

for (const p of pkgs) {
  const pkgDir = path.join(pkgsDir, p);
  const entry = entryFor(pkgDir);
  const smokes = smokesFor(pkgDir);

  if (!entry && smokes.length === 0) {
    console.log('SKIP ' + p + ' (no test entry)');
    continue;
  }

  console.log('=== ' + p + ' ===');
  ran++;
  let pkgOk = true;

  if (entry) {
    const r = spawnSync(process.execPath, ['--test', entry], { stdio: 'inherit', cwd: pkgDir });
    if (r.status !== 0) pkgOk = false;
  }

  for (const s of smokes) {
    const r = spawnSync(process.execPath, [s], { stdio: 'inherit', cwd: pkgDir });
    if (r.status !== 0) pkgOk = false;
  }

  if (!pkgOk) {
    failed++;
    failedNames.push(p);
    console.error('FAIL ' + p);
  }
}

console.log('');
if (failed === 0) {
  console.log('ALL DOCTORS PASSED (' + ran + '/' + pkgs.length + ' packages)');
  process.exit(0);
} else {
  console.error(failed + ' package(s) FAILED: ' + failedNames.join(', '));
  process.exit(1);
}

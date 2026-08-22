#!/usr/bin/env node
'use strict';

// 聚合运行 packages/ 下所有 doctor 的自检（test.js）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgsDir = path.join(__dirname, '..', 'packages');
const pkgs = fs.readdirSync(pkgsDir).filter((n) => {
  const full = path.join(pkgsDir, n);
  return fs.statSync(full).isDirectory();
});

let failed = 0;
for (const p of pkgs) {
  const testFile = path.join(pkgsDir, p, 'test.js');
  if (!fs.existsSync(testFile)) {
    console.log('SKIP ' + p + ' (no test.js)');
    continue;
  }
  console.log('=== ' + p + ' ===');
  const r = spawnSync(process.execPath, [testFile], { stdio: 'inherit', cwd: path.join(pkgsDir, p) });
  if (r.status !== 0) {
    failed++;
    console.error('FAIL ' + p);
  }
}

console.log('');
if (failed === 0) {
  console.log('ALL DOCTORS PASSED (' + pkgs.length + ' packages)');
  process.exit(0);
} else {
  console.error(failed + ' package(s) FAILED');
  process.exit(1);
}

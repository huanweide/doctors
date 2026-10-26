<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/secscan)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/secscan)](https://github.com/huanweide/secscan/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# secscan

零依赖、单文件、开箱即用的 **JS/TS 安全反模式静态扫描 CLI**。

代码健康 family 第七轴（安全反模式）。与 `devdoctor`（只扫明文密钥）互补：`devdoctor` 查"密码泄露"，`secscan` 查"不安全的 API 用法"。

## 为什么需要它

- `eval()` / `new Function()` 等于给攻击者开了代码执行后门；
- `child_process.exec('command ' + userInput)` 是经典命令注入；
- `rejectUnauthorized: false` 把 HTTPS 的防中间人保护一键关掉；
- 明文 `http://` 传输、SQL 字符串拼接、安全场景用 `Math.random()`……都是高频踩坑。

Semgrep 要装 Python + 写规则 yaml，eslint-plugin-security 要配 ESLint，snyk code 要账号。**secscan 什么都不用装、不用配**——一个 `node index.js` 或全局装好直接 `secscan` 就能扫。

## 安装

```bash
npm install -g secscan
# 或本地运行
node index.js <目录>
```

> 零运行时依赖，仅用 Node 内置 `fs` / `path`。支持 Node 18+。

## 用法

```bash
# 扫描当前目录
secscan

# 扫描指定目录
secscan ./src

# 只看 JSON（接 CI / 接其他工具）
secscan ./src --json

# CI 门禁：有 high 级反模式就失败（exit 2）
secscan ./src --fail-on-high

# 更细的门禁：各类别数量上限
secscan ./src --max-high 0 --max-medium 5 --max-issues 10
```

### 选项

| 选项 | 说明 |
|------|------|
| `[root]` / `--root <dir>` | 扫描根目录（默认当前目录） |
| `--ext <csv>` | 仅扫描指定扩展名，如 `js,ts,tsx` |
| `--json` | 输出 JSON |
| `--fail-on-high` | 存在 high 级反模式即失败（exit 2） |
| `--max-high <n>` | high 上限，超出失败 |
| `--max-medium <n>` | medium 上限 |
| `--max-low <n>` | low 上限 |
| `--max-issues <n>` | 总问题数上限 |
| `-V, --version` | 版本 |
| `-h, --help` | 帮助 |

## 支持的扫描目标

`.js` `.mjs` `.cjs` `.ts` `.jsx` `.tsx` `.vue` `.svelte`

自动跳过 `node_modules` `.git` `dist` `build` `coverage` 等目录；单文件超过 5MB 跳过（防 OOM）。

## 规则集

| ID | 严重度 | 检测内容 |
|----|--------|----------|
| S1 | high | `eval()` / `new Function()` 动态代码执行（RCE 风险） |
| S2 | high | `child_process` 命令内容不可控：字符串拼接 / 模板插值 / 变量实参（命令注入） |
| S3 | high | TLS 证书验证被禁用（`rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED=0`） |
| S4 | medium | 明文 `http://` 传输（建议改 HTTPS） |
| S5 | medium | SQL 语句字符串拼接（SQL 注入） |
| S6 | medium | `Math.random()` 用于安全上下文（token/secret/id/nonce 等） |
| S7 | low | `child_process` 安全形态：纯静态常量命令，或 `execFile(cmd,[...])` 数组参数（不过 shell，无注入面） |

## 健康分

加权扣分：`high=3 / medium=2 / low=1`。每 1000 行代码有 1 分的"免费额度"，超出部分每分扣 12 分，最低 0 分。

```
secscan v1.0.0 · 安全反模式扫描
扫描 2 文件 / 1049 行
  S2  high    test.js:181   child_process 命令拼接（命令注入）
  S2  high    test.js:198   child_process 命令拼接（命令注入）
健康分: 41/100
  high=2 medium=0 low=0
```

## 零误报纪律（dogfood 归零）

- 自身 `index.js` 扫描结果必须为 **0 问题**（已写入单测断言，回归守护）。
- 逐字符 tokenizer 先把注释 / 字符串剥成空格（保留换行），只在"裸代码"上检测危险模式；字符串区单独检测明文 `http://`。
- 正则字面量（如 `/^\s*['"`]/`）被正确识别，不会被内部的裸引号干扰。
- 所有规则正则用 `new RegExp(字符串)` 构造，模式本身落在引号里被剥离，**工具不会把自己写的示例当成漏洞报出来**。
- `exec` 系列只在真正 `import/require child_process` 的文件里标记，避免把正则对象的 `.exec()` 方法误报成命令注入。

## 示例

```js
// 危险写法（会被 S1 / S2 / S3 / S4 抓到）
eval(userInput);
const { exec } = require('child_process');
exec('ls ' + userInput);          // S2 命令注入
https.get('http://api.x.com');    // S4 明文传输
```

```js
// 安全写法
const { execFile } = require('child_process');
execFile('ls', [userInput]);      // 数组参数，无拼接
const crypto = require('crypto');
crypto.randomUUID();              // 安全随机，非 Math.random
```

## 在 CI 里用

```yaml
# .github/workflows/security.yml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: '20'
- name: secscan
  run: node index.js ./src --fail-on-high --max-medium 0
```

> **不要用 `npx secscan`。** npm 上的 `secscan` 是 Mozilla scanjs 的包（别人的项目），
> 与本工具无关。直接用 `node index.js`，本项目零依赖、无需安装。

## License

MIT

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## S2 / S7 按「实参形态」判严重度，而不是「首字符是不是引号」

这是本工具最容易判反的地方，也是误报与漏报的共同来源。判定规则：

| 写法 | 判定 | 理由 |
| --- | --- | --- |
| `exec('ls ' + x)` | **S2 high** | 字符串拼接，命令内容受输入影响 |
| `execSync(`rm -rf ${p}`)` | **S2 high** | 模板插值，最危险的命令注入形态 |
| `exec(userCmd)` | **S2 high** | 命令内容完全不可控 |
| `execFile(cmd, [a, b])` | S7 low | 不经过 shell，数组参数无注入面 |
| `exec('ls')` | S7 low | 纯静态常量 |

同时**正则对象的 `.exec()` 不会被误判**（`re.exec(content)` 与 `cp.exec(x)` 靠点号前的标识符区分）。

> 旧实现只看「首字符是不是引号」，而它的输入是已抹掉字符串的代码文本，
> 于是把上面表格里的 high/low **全部判反**，且模板插值直接漏检。已修。

## 测试

```bash
node --test test.js        # 13 项单测（含扩展名污染回归 + dogfood 归零）
node scripts/smoke-cli.js  # 端到端断言
```

CI（`.github/workflows/verify.yml`）在 ubuntu + windows 双平台跑单测与冒烟。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/secscan) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

详见 [LICENSE](LICENSE)。
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

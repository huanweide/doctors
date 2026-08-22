# pkgdoctor

零依赖单文件 `package.json` 配置卫生体检 CLI。

扫你项目自身 `package.json` 的**元数据坏味道**和**依赖声明规范**，给出 `0-100` 健康分与可进 CI 的退出码门禁。纯本地只读、不联网、不调 git、不执行你的代码，单文件零依赖、开箱即跑、确定性可复现。

## 为什么需要它

`package.json` 是 Node 项目的门面，但很多仓库在元数据上偷懒：`license` 缺失（无法合法复用）、`engines.node` 不声明（装到不兼容的 Node 才炸）、依赖写成 `"*"` 或 `"latest"`（版本漂移、构建不可复现）、没有 `test` 脚本（CI 没东西可跑）。

现有工具各有盲区：

- `npm audit` 查**漏洞**，且需联网走 registry；
- `depcheck` 查**死依赖**，需安装；
- `devdoctor` 查**依赖胖瘦（bloat）+ 依赖 license + cycles + 明文密钥**（运行态/源码态）；
- `licguard` 查 **node_modules 里每个包的 license**（别人的）；
- `repodoctor` 查**仓库工程卫生**（含"有 package.json 无锁文件"）；

`pkgdoctor` 补上它们都没覆盖的一块：**项目自身 `package.json` 的配置规范层**——你是谁（name/author/repository）、发版合规（license/version）、可复现（依赖范围规范/锁文件版本）、可验证（test 脚本）、可发现（description/keywords/type）。正交不重叠。

## 安装 / 运行

无需安装，单文件直接跑（需 Node ≥ 14）：

```bash
node index.js .
```

或全局链接后当命令用：

```bash
npm link        # 之后可用 pkgdoctor 命令
pkgdoctor . --fail-on-high --min-score 80
```

## 用法

```bash
pkgdoctor [目录或 package.json 路径] [选项]
```

- 不给目标 → 默认扫当前目录下的 `package.json`
- 给目录 → 扫该目录的 `package.json`
- 给文件路径 → 直接扫该文件

选项：

| 选项 | 作用 |
| --- | --- |
| `--json` | 输出 JSON（含 `score` / `counts` / `issues`），方便 CI 解析 |
| `--quiet` | 仅显示 CI 门禁结果 |
| `--fail-on-high` | 存在任意 HIGH 问题即失败（exit 2） |
| `--max-high N` | HIGH 问题超过 N 失败 |
| `--max-medium N` | MEDIUM 问题超过 N 失败 |
| `--max-issues N` | 问题总数超过 N 失败 |
| `--min-score N` | 健康分低于 N 失败 |
| `-V, --version` | 显示版本 |
| `-h, --help` | 显示帮助 |

## 规则表

| 严重度 | 规则 | 含义 |
| --- | --- | --- |
| HIGH | `missing-name` | 缺少 `name` 字段 |
| HIGH | `invalid-version` | `version` 不是合法 semver（应为 `x.y.z`） |
| HIGH | `missing-license` | 公开发布包（非 `private`）缺少 `license` 字段 |
| MEDIUM | `wildcard-dependency` | 依赖写成 `"*"` / `"x"` / `"latest"` 等模糊范围（版本漂移风险） |
| MEDIUM | `missing-engines` | 缺少 `engines.node`（未声明 Node 版本范围） |
| MEDIUM | `missing-repository` | 缺少 `repository`（不利发现与贡献） |
| MEDIUM | `missing-test-script` | `scripts` 缺少 `test`（CI 无法自动验证） |
| MEDIUM | `missing-description` | 缺少 `description`（不利 npm 发现） |
| LOW | `missing-author` | 缺少 `author` |
| LOW | `missing-type` | 缺少 `type`（ESM/CJS 歧义，默认 commonjs） |
| LOW | `missing-keywords` | 缺少 `keywords`（不利 npm 发现） |
| LOW | `lockfile-outdated` | `package-lock.json` 的 `lockfileVersion` 过旧（< 2） |

> 模糊范围豁免：`workspace:*`（monorepo 别名）、`file:` / `link:` / `git+https:` / `npm:` 等非 npm registry 依赖不会被误报。

## 健康分

满分 `100`，按问题当量扣分并封底 `0`：

- HIGH 每项 `-12`
- MEDIUM 每项 `-6`
- LOW 每项 `-3`

等级：`A`(≥90) `B`(≥75) `C`(≥60) `D`(≥40) `E`(<40)。

## CI 门禁示例

GitHub Actions 里把配置卫生当硬门禁：

```yaml
name: pkg-health
on: [push, pull_request]
jobs:
  lint-pkg:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx -y huanweide/pkgdoctor . --fail-on-high --min-score 80
```

本地预提交：

```bash
pkgdoctor . --fail-on-high --max-medium 0
```

## 零误报纪律

- 纯静态解析，不执行你的代码、不联网、不调 shell，无注入面、无副作用。
- 模糊版本范围做合法豁免（`workspace:` / `file:` / `link:` / `git:` / `npm:`），避免 monorepo 与本地依赖被误报。
- 私有包（`private: true`）不要求 `license`，符合 npm 语义。
- 工具自身 `package.json` 满足所有规则，扫自身健康分 `100`（dogfood 归零）。

## 与 family 的关系

`pkgdoctor` 是「工程健康 family」的配置层一员，与以下成员正交互补：

- [devdoctor](https://github.com/huanweide/devdoctor)（依赖胖瘦 + 依赖 license + cycles + 明文密钥）
- [licguard](https://github.com/huanweide/licguard)（node_modules 各包 license 合规）
- [repodoctor](https://github.com/huanweide/repodoctor)（仓库工程卫生）
- 源码层八件套（testlite / debtlens / a11ydoctor / awaitscan / cycscan / secscan / dupscan / typedoctor）
- git 层四件套（docdoctor / commitdoctor / reldoctor / repodoctor）

## License

MIT

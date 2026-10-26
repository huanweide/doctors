<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/doctors)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/doctors)](https://github.com/huanweide/doctors/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

> **English**: A monorepo of 8 zero-dependency, offline, single-file Node CLIs that health-check your code across the whole dev lifecycle — severity + 0–100 health score + CI gate, behind one `doctors` entrypoint.

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). This repo is the **monorepo hub**: the canonical `doctors` CLI + the 8 core doctors. See also [enghealth](https://github.com/huanweide/enghealth) (unified runner) and [family-showcase](https://github.com/huanweide/family-showcase) (18-axis panorama).

# doctors · 代码健康体检全家桶

八个零依赖、单文件、可离线运行的 Node CLI，覆盖软件开发全链路的「健康体检 + 严重度 + 0-100 健康分 + CI 门禁」。原本是八个独立小仓库，现统一收进这个 monorepo，共享一个入口 `doctors` 与各包的独立 `npx` 调用。

> 设计铁律：纯 Node 标准库、零依赖、零配置、可离线、确定性可复现。每个 doctor 都不联网、不执行你的代码、不读你的密钥，只做只读静态分析。

## 全家桶一览

| 子命令 | 包名 | 体检对象 |
| --- | --- | --- |
| `a11y`  | a11ydoctor  | Web 可访问性（HTML/JSX/Vue/Svelte 语义 a11y 反模式） |
| `commit`| commitdoctor | git 提交消息规范坏味道 |
| `dev`   | devdoctor    | 四维项目体检：依赖胖瘦 / license / 依赖环 / 明文密钥 |
| `doc`   | docdoctor    | Markdown 文档：死链/锚点/跳级/缺 alt/裸 URL |
| `pkg`   | pkgdoctor    | package.json 元数据与依赖声明卫生 |
| `rel`   | reldoctor    | 发布卫生：version / git tag / CHANGELOG 三者一致性 |
| `repo`  | repodoctor   | Git 仓库卫生：危险文件/密钥泄露/大文件/LICENSE/README |
| `type`  | typedoctor   | 类型纪律：explicit-any / any-cast / ts-ignore / double-cast |

## 互补关系图

```
代码质量治理分层
├─ 仓库层（git）
│   ├─ repodoctor   仓库工程卫生（危险文件/大文件/LICENSE/README/锁文件/无意义提交）
│   ├─ commitdoctor 提交消息格式规范
│   └─ reldoctor    发布三件套一致性（version/tag/CHANGELOG）
├─ 依赖层
│   ├─ devdoctor    依赖胖瘦 + license + cycles + 明文密钥（运行/源码态）
│   └─ pkgdoctor    package.json 声明规范
├─ 类型层
│   └─ typedoctor   类型纪律（any 密度）
├─ 文档层
│   └─ docdoctor    Markdown 文档健康
└─ 前端层
    └─ a11ydoctor   Web 可访问性（HTML/JSX/Vue/Svelte）
```

## 安装

**零依赖、零安装。** clone 下来直接用，只需要本机有 Node.js ≥ 18：

```bash
git clone https://github.com/huanweide/doctors.git
cd doctors
node cli.js --help
```

也可以一行拉取并执行（需本机能直连 GitHub）：

```bash
npx -y github:huanweide/doctors repo .
```

### 单独使用某个 doctor

各包目录就是独立的单文件 CLI，直接用 Node 跑即可（无需 `npm install`）：

```bash
node packages/a11ydoctor/index.js ./src
node packages/repodoctor/index.js .
node packages/typedoctor/typedoctor.js ./lib --json
```

> **关于 `npx a11ydoctor` 这类命令**：本项目各包目前**尚未发布到 npm**，
> 因此 `npx a11ydoctor` / `npx repodoctor` 之类的写法当前不可用，请以上面的
> `node packages/<name>/index.js` 或 `node cli.js <subcommand>` 为准。
> 仓库根目录提供 `npx link` 级别的本地别名方式（见下一节），发布后会同步更新本页。

### 全局命令（可选）

想在本机直接用 `doctors` 这个命令：

```bash
# 方式一：npm link（推荐，会把 doctors 注册为全局命令）
npm link
doctors --help

# 方式二：写一个软链 / 别名（Windows 可用 doskey 或自建 shim 脚本）
```

## 用法

统一入口 `doctors <subcommand> [args...]`，参数原样转发给对应 doctor：

```bash
doctors a11y   ./src/index.jsx
doctors commit .
doctors dev    doctor .   # dev 需先选子模式：bloat | license | cycles | secrets | doctor
doctors doc    ./docs
doctors pkg    .
doctors rel    .          # 也支持 --root <dir>
doctors repo   .
doctors type   ./lib --json   # 也支持 --root <dir>
```

> 所有子命令默认扫描「当前目录」，可传一个位置参数指定目录（如 `doctors repo ../my-project`）。

### 门禁参数对照表（各包不完全一致，务必核对）

历史上各包独立演进，**门禁参数名并不统一**，照抄别人的会静默失效。
下表由 `node cli.js <sub> --help` 逐个核对得出：

| 子命令 | 高危即失败 | 问题数上限 | 健康分下限 | 备注 |
| --- | --- | --- | --- | --- |
| `a11y` | `--fail-on high` | `--max <n>` | — | 取值 `high`(默认)/`any`/`none`，写法与其他包不同 |
| `commit` | `--fail-on-high` | `--max-issues <n>` / `--max-high <n>` | `--min-score <s>` | 需在 git 仓库内 |
| `dev` | `--fail-on <mode>` | `--max <n>` | — | 需先选子模式，如 `dev doctor .` |
| `doc` | `--fail-on-high` | `--max-issues <n>` / `--max-high <n>` | — | |
| `pkg` | `--fail-on-high` | `--max-issues <n>` / `--max-high <n>` | `--min-score <s>` | |
| `rel` | `--fail-on-high` | `--max-issues <n>` / `--max-high <n>` | `--min-score <s>` | |
| `repo` | `--fail-on-high` | — | `--min-score <s>` | 需在 git 仓库内 |
| `type` | `--fail-on-high` | `--max-issues <n>` / `--max-high <n>` | `--min-score <s>` | |

各子命令的完整参数详见对应 `packages/<name>/README.md` 或直接跑 `--help`——**以 `--help` 输出为准**。

## 开发

```bash
# 跑全部 doctor 自检
node scripts/run-all-tests.js
# 或
npm test
```

## 快速开始

三十秒接入，两个命令：

```bash
# 1) 体检自己的项目，看有哪些问题
node cli.js repo .          # 仓库层：危险文件 / 密钥泄露 / 大文件 / LICENSE 缺失
node cli.js type ./src      # 类型层：any 密度

# 2) 接进 CI，低于阈值就拦下提交
node cli.js repo . --min-score 70
```

一个体检例子（输出结构固定，方便脚本二次消费）：

```
--- 汇总 ---
  high: 1   medium: 2   low: 0
  健康分：58 / 100
```

`high > 0` 或 `健康分 < --min-score` 时退出码非 0，可直接当 CI 门禁。

## 目录结构

```
doctors/
├── cli.js                    # 统一入口调度器
├── scripts/run-all-tests.js  # 聚合自检
├── packages/
│   ├── a11ydoctor/
│   ├── commitdoctor/
│   ├── devdoctor/
│   ├── docdoctor/
│   ├── pkgdoctor/
│   ├── reldoctor/
│   ├── repodoctor/
│   └── typedoctor/
├── sponsor/wechat-qr.png     # 赞助收款码（静态图片）
└── .github/workflows/ci.yml  # 多 Node 版本 CI 门禁
```

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度；若存在不达标项会以非 0 退出码结束，从而拦下问题提交（具体参数见上方「快速开始」）。

GitHub Actions 最小示例：

```yaml
- run: node cli.js repo . --min-score 70
- run: node cli.js doc ./docs
```

> 依赖 git 的 doctor（`commit` / `repo`）必须在 Git 仓库内运行；
> 非 git 目录会明确报错并以非 0 退出码结束，不会静默放行。

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/doctors) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

MIT · © huanweide — 详见 [LICENSE](LICENSE)。
---

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

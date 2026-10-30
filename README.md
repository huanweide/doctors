<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/doctors)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/doctors)](https://github.com/huanweide/doctors/stargazers)
[![Axes](https://img.shields.io/badge/axes-21-22c55e)](https://github.com/huanweide/doctors#%E8%BD%B4%E7%B4%A2%E5%BC%95)
[![Zero dependency](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/huanweide/doctors/blob/main/package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
<!-- /badges -->

<p align="center">
  <img src="assets/banner.svg" alt="doctors" width="640">
</p>

> **English**: One repo, 21 zero-dependency offline single-file Node CLIs that health-check your code — severity + 0–100 score + **three-state CI gate** (pass / fail / **inconclusive**), behind a single `doctors` entrypoint.

**🩺 doctors · 代码健康体检全家桶** —— 别人给你「绿灯」，我们给你**可信的结论**：21 个体检轴共用一个入口，零依赖、可离线、只读不改写；**没配门禁阈值就明说 inconclusive，绝不拿绿灯骗你**。

`一个仓库 → 一次 clone → 21 轴任选 → 健康分 + 严重度 → CI 门禁（pass / fail / inconclusive）`

[30 秒看懂](#30-秒看懂) · [它能做什么](#它能做什么) · [特性](#特性) · [快速开始](#快速开始) · [轴索引](#轴索引) · [CLI 速查](#cli-命令速查) · [架构](#架构) · [加一个轴](#加一个你自己的轴) · [路线图](#路线图) · [贡献](#贡献) · [安全边界](#安全边界)

---

## 30 秒看懂

不用装、不用配、不联网。clone 下来第一条命令就能体检你自己的项目：

```console
$ git clone https://github.com/huanweide/doctors.git && cd doctors
$ node cli.js repo .

=== repodoctor 仓库卫生体检 ===
仓库: /home/you/my-project
发现问题 3 项：
  [LOW ] 密钥泄露  packages/commitdoctor/test.js
         已知假阳性命中（已豁免为 low）：-----BEGIN PRIVATE KEY----- — 理由：单测构造的密钥检测样本（非真凭据）
  [MED ] 锁文件  (仓库整体)
         存在 package.json 但缺少依赖锁文件，依赖不可复现

健康分: 88 / 100  (HIGH 0 / MED 1 / LOW 2)
```

差别就一句话：**大多数扫描器把「没扫到 / 没配阈值」也报成通过；doctors 把它报成 `inconclusive`（未决，不等于通过）。**

```console
$ node cli.js cyc scan --root ./packages/litdoctor

    [high] index.js:353  圈复杂度过高
         圈复杂度 20 > 阈值 10（分支过多，建议拆函数 / 早返回 / 查表）
  健康分       : 0 / 100  [结构风险高]
  门禁: 未决（结论不可信，不等于通过）  [state=inconclusive configured=false]
    理由: 未配置任何门禁阈值；本次输出一律不构成「门禁通过」结论。请显式传入 --max-high / --max-complexity / …
```

## 它能做什么

一次命令看全局——`eng` 轴是**工程健康家族**（一组零依赖代码体检工具的集合）的元仪表盘，把散落的轴聚成一张体检表、一个总分：

```console
$ node cli.js eng . --tools-dir ./packages

========================================
 工程健康家族 · 统一体检报告 (enghealth)
========================================
概览健康分 : 97/100（enghealth 自身零依赖扫描）
并入兄弟工具 : 7/14
----------------------------------------
维度            类别      健康分       状态
仓库卫生        git   88      良
提交规范        git   100     优
发布一致性       git   88      良
配置规范        配置    88      良
安全反模式       源码    0       需关注
异步性能        源码    8       需关注
----------------------------------------
总分 : 59/100
CI 门禁：PASS
```

想排查具体某一类问题，就单跑那一根轴：

```console
$ node cli.js sec ./src        # 安全反模式：eval / exec 拼接 / 明文 http / SQL 拼接 / 弱随机
$ node cli.js debt doctor .    # 技术债密度：TODO / FIXME / HACK 注释锚定计数
$ node cli.js gha .            # GitHub Actions：unpinned action / script injection / 权限过宽
$ node cli.js chain impact src/core/parser.js   # 改了 parser，谁会受影响
```

## 特性

- **🩺 21 轴一个入口（One Entrypoint）** —— `a11y / commit / dev / doc / pkg / rel / repo / type` 八核，加上 `sec / cyc / dup / lit / debug / debt / await / chain / gha / lic / idiot / test / eng` 十三根归位散轴；全部经 `cli.js` 统一调度，参数原样转发。
- **🚦 门禁三态（Three-State Gate）** —— `pass(0) / fail(2) / inconclusive(3)`。未配阈值、或扫描输入为空 → `inconclusive`，**绝不谎报通过**；这是本项目最重要的一条不变量，`scripts/smoke-cli.js` 逐条钉死退出码契约。
- **📊 有害指标免疫（Anti-Vanity Metric）** —— 扫到 0 个文件时不给 100 分，健康分记 `null`（无法评估）。不让「空扫描 = 满分」骗你停止思考。
- **🔬 证据锚点（Evidence-Anchored）** —— 每条结论都落到 `文件:行号`；`--json` 输出带 `basisComplete`，明确告诉你「这次扫描的基线可不可信」。
- **🧬 零依赖单文件（Zero-Dependency Single File）** —— 每个轴就是一个 `index.js`，只用 Node 标准库（`fs` / `path`）；不改你一行代码、不联网、不执行你的代码。
- **🐕 自举狗粮（Dogfood Bootstrap）** —— CI 里拿 21 轴体检 doctors 自己：新增代码若引入自家规则不认的坏味道，当场被拦（见 `.github/workflows/ci.yml` 的 `dogfood` job）。
- **🧭 元仪表盘（Meta Dashboard）** —— `eng` 轴把已发现的兄弟 CLI 聚成一张表；缺失或失败一律降级为「跳过」，绝不误判成失败。

## 快速开始

**零依赖、零安装。** 只需要 Node.js ≥ 18：

```bash
git clone https://github.com/huanweide/doctors.git
cd doctors
node cli.js --help
```

一行拉取执行（需本机能直连 GitHub）：

```bash
npx -y github:huanweide/doctors repo .
```

### 体检你自己的项目

```bash
node cli.js repo .                    # 仓库层：危险文件 / 密钥 / 大文件 / LICENSE
node cli.js sec  ./src                # 安全层：eval / exec / 明文 http / SQL 拼接
node cli.js type ./src --json         # 类型层：any 密度
```

接进 CI（低于阈值就拦下提交）：

```bash
node cli.js repo . --min-score 70
node cli.js sec  ./src --fail-on-high
node cli.js cyc  scan --root ./src --max-complexity 15
```

### 单独使用某个轴

每个包目录就是独立的单文件 CLI，脱离 monorepo 也能直接跑（无需 `npm install`）：

```bash
node packages/repodoctor/index.js .
node packages/secscan/index.js ./src --json
node packages/typedoctor/typedoctor.js ./lib --json
```

> **关于 `npx repodoctor` 这类命令**：各包目前**尚未发布到 npm**，`npx repodoctor` 当前不可用，
> 请以 `node packages/<name>/index.js` 或 `node cli.js <subcommand>` 为准。

### 全局命令（可选）

```bash
npm link        # 把 doctors 注册为全局命令
doctors --help
doctors repo .
```

### 跑全部自检

```bash
node scripts/run-all-tests.js   # 21 个包的单测 + CLI 冒烟（spawn 级退出码契约）
npm test                        # 同上
```

真实输出（本地已全绿）：

```console
=== a11ydoctor ===
=== awaitscan ===
…
=== typedoctor ===
ALL DOCTORS PASSED (21/21 packages)
```

## 轴索引

21 根轴，按治理层排列。**「命令」列是可直接复制的正确姿势**——各轴调用形态并不统一（有的吃位置参数，有的必须先选子模式再用 `--root`），照抄错的会静默失效。

### 源码层

| 轴 | 包名 | 查什么 | 命令 | 严重度 | CI 门禁 |
| --- | --- | --- | --- | --- | --- |
| `type` | typedoctor | 类型纪律（explicit-any / any-cast / ts-ignore / double-cast） | `node cli.js type ./src` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `sec` | secscan | 安全反模式（eval、exec 拼接、TLS 禁用、明文 http、SQL 拼接、弱随机） | `node cli.js sec ./src` | high / medium / low | `--fail-on-high` `--max-high` `--max-medium` `--max-low` `--max-issues` |
| `cyc` | cycscan | 结构复杂度（圈复杂度 >10、函数长度 >60 行） | `node cli.js cyc scan --root ./src` | high / medium | `--max-complexity` `--max-lines` `--max-high` `--fail-on-high` `--max-issues` |
| `dup` | dupscan | 重复代码块（逐行 n-gram 滑窗，默认 ≥5 行） | `node cli.js dup ./src` | high / medium | `--max-issues` `--max-lines` `--fail-on-high` |
| `lit` | litdoctor | 硬编码魔法值 / 重复字面量 | `node cli.js lit ./src` | medium / low（当前无 high 规则） | `--max-issues` `--max-medium` `--max-low` `--min-score` |
| `debug` | debugdoctor | 调试与日志残留（debugger / console.\* / print / fmt.Print\*） | `node cli.js debug ./src` | high / medium | `--fail-on-high` `--max-high` `--max-medium` `--max-issues` `--min-score` |
| `debt` | debtlens | 技术债密度（TODO / FIXME / HACK… 注释锚定，严重度加权） | `node cli.js debt doctor --root .` | 加权密度（非三档） | `--max-density` `--max-weighted` `--max-total` `--fail-on-tags` `--fail-on-issues` |
| `await` | awaitscan | 异步性能反模式（循环内串行 await、map 内 await、嵌套循环） | `node cli.js await scan --root ./src` | high / medium | `--max-high` `--max-medium` `--max-issues` `--fail-on-high` `--fail-on-issues` |
| `a11y` | a11ydoctor | Web 可访问性（HTML / JSX / Vue / Svelte 语义反模式） | `node cli.js a11y ./src` | high / medium / low | `--fail-on high`（取值 `high`/`any`/`none`，写法与其他轴不同） `--max <n>` |

### 依赖 / 架构层

| 轴 | 包名 | 查什么 | 命令 | 严重度 | CI 门禁 |
| --- | --- | --- | --- | --- | --- |
| `dev` | devdoctor | 四维项目体检（依赖胖瘦 / license / 依赖环 / 明文密钥） | `node cli.js dev doctor .` | 随子模式 | `--fail-on <mode>` `--max <n>` |
| `pkg` | pkgdoctor | package.json 元数据与依赖声明卫生 | `node cli.js pkg .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `lic` | licguard | 依赖许可证合规（强 copyleft GPL/AGPL、弱 copyleft LGPL/MPL、未知许可） | `node cli.js lic .` | strong / weak / unknown / permissive | `--fail-on <mode>` `--max <n>` `--allow-missing` |
| `idiot` | idiot-index | 白痴指数：可被原生 API 替代的冗余依赖 + 过度工程 | `node cli.js idiot .` | 等级 A–F（指数 0–100） | `--max <n>` `--require-usage` |
| `chain` | chaineye | 依赖链影响面（改了 X 谁受影响；循环依赖 / 孤立文件 / 枢纽文件） | `node cli.js chain .` | cycles / orphans | `--max-cycles` `--max-orphans` `--fail-on-cycle` |

### git / CI 层

| 轴 | 包名 | 查什么 | 命令 | 严重度 | CI 门禁 |
| --- | --- | --- | --- | --- | --- |
| `repo` | repodoctor | 仓库卫生（危险文件 / 密钥泄露 / 大文件 / LICENSE / README / 锁文件） | `node cli.js repo .` | high / medium / low | `--fail-on-high` `--min-score <s>` |
| `commit` | commitdoctor | git 提交消息规范坏味道 | `node cli.js commit .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `rel` | reldoctor | 发布卫生（version / git tag / CHANGELOG 三者一致性） | `node cli.js rel .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `gha` | ghadoctor | GitHub Actions 配置卫生（unpinned action / 脚本注入 / 权限过宽 / PR target checkout） | `node cli.js gha .` | high / medium | `--fail-on-high` `--max-high` `--max-medium` `--max-issues` `--min-score` |

### 文档 / 测试层 · 元层

| 轴 | 包名 | 查什么 | 命令 | 严重度 | CI 门禁 |
| --- | --- | --- | --- | --- | --- |
| `doc` | docdoctor | Markdown 文档健康（死链 / 锚点 / 跳级 / 缺 alt / 裸 URL） | `node cli.js doc ./docs` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` |
| `test` | testlite | 测试卫生（框架识别 / 测试发现 / 密度估算 / 零测试警告 / 覆盖率配置） | `node cli.js test doctor --root .` | 体检项 + 健康分 | `--min-tests` `--min-density` `--fail-on-issues` |
| `eng` | enghealth | 元仪表盘：聚合 family 兄弟 CLI，一次命令出一张体检表 + 总分 | `node cli.js eng . --tools-dir ./packages` | 总分 + 各轴分 | `--fail-on-low <n>` `--min-overall <n>` |

> 依赖 git 的轴（`repo` / `commit` / `rel`）必须在 Git 仓库内运行；非 git 目录会明确报错并以非 0 退出码结束，**不会静默放行**。
> 各轴的完整参数以其 `--help` 为准（如 `node cli.js sec --help`）。

### 已归位的散轴仓

`secscan / cycscan / dupscan / litdoctor / ghadoctor / debugdoctor / debtlens / awaitscan / chaineye / enghealth / idiot-index / licguard / testlite`
十三个原独立仓库已整体并入本 monorepo 的 `packages/`，原件逐字节搬入、保留零依赖单文件本色；各原仓库现已归档（archived，只读），代码保留作历史参考，新改动一律进这里。

## CLI 命令速查

| 命令 | 作用 |
| --- | --- |
| `node cli.js --help` | 打印全部 21 个子命令（按治理层分组） |
| `node cli.js --version` | 打印版本 |
| `node cli.js <axis> [target] [options]` | 跑单轴，参数原样转发给对应包 |
| `node cli.js <axis> --json` | 机器可读输出（CI 消费） |
| `node scripts/run-all-tests.js [pkg]` | 跑全部（或指定包）自检：单测 + CLI 冒烟 |
| `node scripts/smoke-cli.js` | 只跑统一入口冒烟（21 子命令启动 + 退出码契约） |
| `npm test` | 等价于 `node scripts/run-all-tests.js` |

## 架构

**叙事**：一个调度器（`cli.js`）+ 21 个彼此不认识的单文件 CLI。轴之间零耦合——任何一根轴被删掉，`cli.js` 只是少一个子命令，其余 20 根照跑。统一性只体现在三处约定：**入口形态**（`packages/<name>/index.js`）、**输出形态**（严重度 + 健康分 + `--json`）、**门禁形态**（三态退出码）。

### 核心概念（Primitive 表）

| 概念 | 含义 |
| --- | --- |
| 轴（axis） | 一根体检维度 = 一个零依赖单文件 CLI = `packages/<name>/index.js` |
| 严重度（severity） | `high / medium / low`（部分轴按自身语义分级，如 licguard 的 strong/weak/unknown） |
| 健康分（score） | 0–100 综合评分；**扫描输入为空时为 `null`，不输出 100** |
| 门禁三态（gate） | `pass` 达标 / `fail` 不达标 / `inconclusive` 无法下结论（未配阈值或输入为空） |
| 退出码契约 | `0` pass · `2` fail 或参数错误 · `3` inconclusive（个别轴用 `1` 表示内部异常） |
| 基线可信度（basisComplete） | `--json` 字段：本次扫描是否扫到了足够输入，决定健康分是否可信 |
| 狗粮（dogfood） | 用 21 轴体检 doctors 自己，CI 里强制拦截自身坏味道 |

### 调度链路

```
node cli.js <axis> [args...]
        │
        ├─ 查 SUBCOMMANDS 表 ──► packages/<pkg>/package.json（拿 bin 入口）
        │                              │
        │                              └─► spawn node packages/<pkg>/index.js [args...]
        │                                        │
        │                                        ├─ 只读扫描（fs / path，绝不写文件）
        │                                        ├─ 严重度分级 ──► 健康分
        │                                        └─ 门禁判定 ──► exit 0 / 2 / 3
        └─ 未知子命令 ──► exit 2（绝不当成通过）

自检链路：scripts/run-all-tests.js ──► 每包 test.js（或 test/unit.test.js）+ smoke-cli.js
                                       （cwd 设为包目录，保证相对路径不变）
```

### 核心模块表

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 统一入口调度器 | `cli.js` | 21 子命令 → 包 bin 的映射、参数转发、分层 help |
| 聚合自检 | `scripts/run-all-tests.js` | 逐包探测 `test.js` / `test/unit.test.js` + 冒烟脚本，可指定单包 |
| 入口冒烟 | `scripts/smoke-cli.js` | spawn 级验证：21 子命令能启动、退出码契约不退化 |
| 轴实现 | `packages/<name>/index.js` | 每根轴的全部逻辑（单文件、零依赖、可独立运行） |
| 轴自检 | `packages/<name>/test.js`、`test/unit.test.js`、`test` 或 `scripts/smoke-cli.js` | 单测 + CLI 退出码契约 |
| CI | `.github/workflows/ci.yml` | Node 18/20/22 矩阵跑全自检 + dogfood 自举 |

## 加一个你自己的轴

三件事，五分钟——新轴自动被 `cli.js` 与 `run-all-tests.js` 认领：

1. 建目录与入口（**必须是 CommonJS 的 `index.js`**，文件名由 `package.json` 的 `bin` 指向）：

```
packages/mydoctor/
├── index.js      # 全部逻辑：只读扫描 → 严重度 → 健康分 → 门禁三态
├── test.js       # 自检（node:test 或自带 runner 均可）
└── package.json  # { "name": "mydoctor", "bin": { "mydoctor": "index.js" } }
```

2. 在 `cli.js` 的 `SUBCOMMANDS` / `DESCRIPTIONS` / `GROUPS` 里各加一行：

```js
const SUBCOMMANDS = { /* … */ my: 'mydoctor' };
const DESCRIPTIONS = { /* … */ my: '我的自定义体检轴' };
```

3. 在 `scripts/smoke-cli.js` 的 `EXPECTED_SUBS` 里加上 `my`，CI 会替你守住它不退化。

纪律：零依赖、只读、参数非法一律 `exit 2`、没配门禁阈值一律 `exit 3`（inconclusive），**绝不静默放行**。

## 路线图

- [x] 八核 doctor 收入 monorepo
- [x] 十三根散轴整体归位（`sec / cyc / dup / lit / debug / debt / await / chain / gha / lic / idiot / test / eng`）
- [x] 统一入口分层 help + 21 轴入口冒烟
- [x] 门禁三态与「空输入不给 100 分」的不变量
- [ ] 各轴发布到 npm（当前 `npx <axis>` 不可用，只能 `node packages/<name>/index.js`）
- [ ] 门禁参数名统一（历史上各轴独立演进，命名并不一致，见轴索引表「CI 门禁」列）
- [ ] 跨轴聚合报告落盘（HTML / Markdown 一体检存档）
- [ ] `eng` 轴兄弟工具发现清单随新轴自动同步（当前仍是硬编码的 14 项）

## 贡献

欢迎 PR。三条硬门槛：

1. 新轴必须零依赖、单文件、可离线，且附带自检（`test.js` 或 `test/unit.test.js`）。
2. `node scripts/run-all-tests.js` 必须全绿；`node scripts/smoke-cli.js` 不得退化。
3. 门禁判定不许「谎报通过」：无法确定结论时输出 `inconclusive`，而不是 `pass`。

## 安全边界

- **只读**：所有轴只用 `fs` / `path` 读文件，**绝不修改、删除或写入你的源码**。
- **不联网**：零网络请求；`eng` 轴调用兄弟 CLI 走本地进程，不外发任何数据。
- **不执行被测代码**：只做静态分析，不 `require`、不 `eval` 你的源码。
- **不读密钥**：轴只识别「疑似明文密钥」的模式并告警，不采集、不外传、不落盘密钥内容。
- **误报优先**：宁可多报（可加豁免注释），也不漏报——安全类轴漏报等于谎报干净。

## 许可证

MIT · © huanweide — 详见 [LICENSE](LICENSE)。

---

## ⭐ Star

21 根轴、零依赖、可离线。如果它帮你拦下过一次问题提交，欢迎 [点个 Star](https://github.com/huanweide/doctors) —— 这是本项目唯一要的增长指标。


← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

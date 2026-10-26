**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# ghadoctor

[![CI](https://github.com/huanweide/ghadoctor/actions/workflows/ci.yml/badge.svg)](https://github.com/huanweide/ghadoctor/actions/workflows/ci.yml)
[![版本](https://img.shields.io/github/package-json/v/huanweide/ghadoctor)](https://github.com/huanweide/ghadoctor)
[![许可证: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/ghadoctor)](https://github.com/huanweide/ghadoctor/stargazers)

**ghadoctor 是一个开源的 GitHub Actions 配置卫生体检工具：帮任何使用 GitHub Actions 的团队，零依赖、一行命令揪出 CI 安全/配置坏味道（Action 未锁定 SHA、脚本注入、过宽权限、pull_request_target 风险等），开箱即跑、带健康分与 CI 门禁。**

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase) · [枢纽 doctors](https://github.com/huanweide/doctors)

*family 第 18 轴：CI 配置卫生（git 层治理第五件，与 repodoctor / docdoctor /
commitdoctor / reldoctor 拼成 git 层治理五件套）。*

> **English**: ghadoctor is an open-source, zero-dependency, single-file CLI that audits your GitHub Actions workflows for security & config smells (unpinned actions, script injection, over-broad permissions, `pull_request_target` checkout, missing `permissions`/`timeout`/`concurrency`). One command, no install, with a 0–100 health score and a CI gate (exit code 0 / 2 / 3). See [Install](#install--run) and [Options](#options).

> 差异化：actionlint / zizmor 是重型工具（需装 / 编译 / 配置），ghadoctor 是
> 零依赖单文件、确定性强、开箱即跑，并附健康分 + CI 门禁，填补「轻量零依赖」
> 缝隙（与 family 一贯范式一致：重型工具占满 → 我们做零依赖轻量版）。

## 安装 / 运行（Install / Run）

零依赖，仅需 Node.js（>=18，测试依赖 `node --test`）。无需 `npm install`：

```bash
node index.js [--root <dir>]
```

## 能力

扫描 `<root>/.github/workflows/*.yml|*.yaml`，检测 8 类 CI 安全 / 配置坏味道：

| 规则 | 严重度 | 说明 |
| --- | --- | --- |
| `unpinned-action` | HIGH | Action 引用未锁定到 40 字符 commit SHA（`@v4`/`@main`/`@master`/`@latest`/`@head`/`@stable`），可被上游 repoint 成恶意代码 |
| `script-injection` | HIGH | run 步直接插值不可信输入（`${{ github.event.* }}` 等）进入 shell，存在脚本注入风险 |
| `broad-permissions` | HIGH | `permissions: write-all` 给 token 整库读写 |
| `pr-target-checkout` | HIGH | `pull_request_target` 触发下 checkout PR head，以特权 token 运行不可信代码 |
| `missing-permissions` | MED | 未显式声明 `permissions`，默认继承 repo / 组织权限（常过宽） |
| `hardcoded-secret` | MED | 工作流中疑似硬编码密钥 / 密码（应改用 `${{ secrets.* }}`） |
| `no-timeout` | LOW | 未设置 `timeout-minutes`，作业可能无限挂起 |
| `no-concurrency` | LOW | 未声明 `concurrency`，并发触发可能冲突 |

健康分：每文件基础 100，按严重度扣分（HIGH −15 / MED −8 / LOW −4），封底 0。
总体健康分 = 各文件健康分平均。

## 选项

```
ghadoctor [--root <dir>]           扫描当前/指定目录的 .github/workflows
ghadoctor --json                   输出纯 JSON（不含其他文本，门禁用退出码）
ghadoctor --fail-on-high           存在 HIGH 问题时退出码 2
ghadoctor --max-high N             HIGH 超过 N 退出码 2
ghadoctor --max-medium N           MEDIUM 超过 N 退出码 2
ghadoctor --max-issues N           问题总数超过 N 退出码 2
ghadoctor --min-score N            总体健康分低于 N 退出码 2
ghadoctor --quiet                  仅打印总览
ghadoctor --help                   帮助
```

## 示例输出

```
ghadoctor · GitHub Actions 配置卫生体检

.github/workflows/ci.yml
  [HIGH] L12 unpinned-action: actions/checkout@v4 未锁定 SHA
  [MED] 未显式声明 permissions，默认继承 repo/组织权限
  健康分: 77

总览: 扫描 1 文件, 2 问题 (1 HIGH / 1 MED / 0 LOW)
总体健康分: 77
CI 门禁: PASS
```

> 门禁三态（第 9.9 / 10.2 / 11.1 轮固化）：`PASS`(0) / `FAIL`(2，配置了阈值且不达标) / `INCONCLUSIVE`(3，未配置任何阈值或扫描输入为空)。**空扫描不会给满分**——未扫描到任何工作流文件时健康分显示「无法评估」、`summary.basisComplete=false`、退出码 3，而非假「100 分 PASS」。这与同族门禁工具契约一致。

## CI 集成

```yaml
# .github/workflows/ci-doctor.yml
name: ci-doctor
on: [push, pull_request]
permissions: {}
jobs:
  ghadoctor:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
      - uses: actions/setup-node@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
        with:
          node-version: 22
      - run: node index.js --fail-on-high --min-score 90
```

## 约束

- 纯 fs 只读，不执行、不联网、不调用 YAML 解析库（line-scanner + 轻量缩进跟踪，确定性强）。
- 输出禁用 emoji，跨平台终端 / CI 日志渲染一致。
- `--json` 模式只输出纯 JSON，门禁结果用进程退出码表达：`0`=通过 / `2`=不达标 / `3`=结论不可信（未配置阈值或输入为空）。

## 测试

需要 Node.js >=18（测试依赖 `node --test`）：

```bash
node --test test.js && node test/smoke-cli.js
```

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度；若存在不达标项会以非 0 退出码结束，从而拦下问题提交（具体参数见上方「快速开始」）。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/ghadoctor) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

详见 [LICENSE](LICENSE)。
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

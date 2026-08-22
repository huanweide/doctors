# reldoctor

零依赖发布卫生体检 CLI。检查 `package.json version` / 最新 `git tag` / `CHANGELOG.md` 三者是否一致，给出 0–100 健康分，可直接挂进 CI 当发布门禁。

> 一句话：代码改了，但忘了打 tag、version 没跟上、CHANGELOG 没更新 —— 这些极常见的「发布事故」，reldoctor 一条命令扫出来。

零依赖单文件（仅 Node 内置模块 + 系统 git），开箱即用，不联网、不执行你的代码。

## 为什么需要它

- `standard-version` / `release-please` / `semantic-release` 是「自动帮你发版」，不是「体检你发版健不健康」。
- `changesets` 偏流程协作。
- reldoctor 只做一件事：静态体检「version ↔ tag ↔ CHANGELOG 三角」是否脱节，并给健康分 + CI 门禁。把它接进 pre-release 钩子或 CI，能在「发版前」拦住不一致。

## 安装 / 使用

```bash
# 直接跑（无需安装，需 Node 18+）
node reldoctor.js

# 或全局软链
npm link   # 之后 reldoctor

# 指定目录
reldoctor --root ./packages/core
```

## 检测维度

| 规则 id | 严重度 | 含义 |
| --- | --- | --- |
| `version-tag-mismatch` | 高危 | `package.json` version 与最新 git tag 不一致 |
| `untagged-commits` | 高危 | 最新 tag 之后还有未打 tag 的提交（代码改了没发版） |
| `version-not-semver` | 中危 | version 不符合 semver（应为 `x.y.z`） |
| `changelog-missing-version` | 中危 | CHANGELOG 不含当前 version 的章节 |
| `never-released` | 低危 | 有 version 但仓库从未打过任何 semver tag |
| `tag-prefix-inconsistent` | 低危 | tag 命名带/不带 `v` 前缀混用（如 `v1.0.0` 与 `1.0.0`） |
| `no-changelog` | 低危 | 缺 CHANGELOG.md |
| `no-unreleased-section` | 低危 | CHANGELOG 无 `Unreleased` 段 |

## 健康分

满分 100，按问题严重度扣分：高危 −20 / 中危 −12 / 低危 −6，封底 0。

## CI 门禁

```bash
# 任意高危即失败（exit 1）
reldoctor --fail-on-high

# 精细控制
reldoctor --max-high 0 --max-medium 2 --max-issues 5 --min-score 80

# 流水线解析（JSON 输出）
reldoctor --json
```

退出码：`0` 通过，`1` 门禁失败，`2` 参数/路径错误。

## 与 family 的关系

reldoctor 是「代码健康 family」的 git 层治理四件套之一，与以下工具拼成完整体检矩阵：

- **repodoctor** — git 仓库工程卫生（危险文件 / 大文件 / LICENSE / 无意义提交占比）
- **docdoctor** — Markdown 文档健康（死链接 / 标题结构 / 图片 alt / 裸 URL）
- **commitdoctor** — git 提交消息规范（空主题 / 超长 / 密钥泄露 / WIP）
- **reldoctor** — 发布一致性（version ↔ tag ↔ CHANGELOG）

源码层八件套（devdoctor / testlite / debtlens / a11ydoctor / awaitscan / cycscan / secscan / dupscan）覆盖 SonarQube TOP 静态坏味道维度。

## 设计纪律

- 零依赖：仅 Node 内置 `fs` / `path` / `child_process`，不引入任何 npm 包。
- 安全：只读 `fs` 与系统 `git`，git 调用经 `execFileSync` + `cwd` 传入，绝不拼接 shell。
- 健壮：非 git 仓库 / 无 package.json / 坏 JSON / git 命令失败，一律降级为「无数据」而非崩溃。
- 门禁防呆：所有阈值参数经 `Number.isFinite` 校验，非整数直接 `exit 2`，不会静默放行。

## License

MIT

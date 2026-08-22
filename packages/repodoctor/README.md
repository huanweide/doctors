# repodoctor

零依赖、单文件的 **Git 仓库卫生体检 CLI**。一键扫描你的 git 仓库，给出 0–100 健康分与可 actionable 的整改清单，可直接接 CI 门禁。

`devdoctor` 只扫源码层明文密钥，`repodoctor` 补上 **git 层面** 的工程卫生——这是「代码健康 family」之外的第九轴。

## 为什么需要

- 把 `.env` / `node_modules` 误提交进版本库（密钥泄露、仓库膨胀）
- 明文密钥曾经写进 commit，删了也残留在 git 历史
- 大文件直接进库，仓库越来越胖（该用 Git LFS）
- 开源项目缺 LICENSE / README，依赖无锁文件不可复现
- 提交信息全是 `update` / `fix` / `wip`，历史无法追溯

这些 gitleaks（需装+规则重）、git-secrets（需 hook）都没法零依赖开箱即扫，且覆盖维度更窄。repodoctor 一个命令全查。

## 安装 / 运行

无需 npm install，只要有 Node（>=16）和 git：

```bash
node repodoctor.js              # 扫描当前目录所在仓库
node repodoctor.js /path/repo  # 扫描指定仓库
node repodoctor.js --help      # 查看全部选项
```

## 检测维度

| 规则 | 维度 | 严重度 | 说明 |
|------|------|--------|------|
| G1 | 危险文件/忽略 | HIGH / MED | `.env`、node_modules、dist 等被提交；缺 `.gitignore` |
| G2 | 密钥泄露 | HIGH | 当前文件内容 + 最近 N 个 commit 的 diff 中出现明文密钥/凭证 |
| G3 | 大文件 | HIGH | 超过阈值（默认 100MB）的文件进了版本库 |
| G4 | LICENSE | MED | 缺少 LICENSE 文件 |
| G5 | README | MED | 缺少 README 文件 |
| G6 | 锁文件 | MED | 有 package.json 但缺依赖锁文件 |
| G7 | 提交卫生 | LOW | 无意义提交（update/fix/wip…）占比过高 |
| G8 | 分支卫生 | LOW | 本地+远程分支数过多 |

## 健康分

`健康分 = max(0, 100 − HIGH×12 − MED×6 − LOW×3)`。HIGH（密钥泄露/大文件）直接重扣，符合直觉。

## CI 门禁

```bash
# 存在任意 HIGH 问题则退出码 1
node repodoctor.js --fail-on-high

# 健康分低于 90 则退出码 1
node repodoctor.js --min-score 90
```

GitHub Actions 示例：

```yaml
- name: 仓库卫生体检
  run: node repodoctor.js --fail-on-high --min-score 90
```

## 选项

- `-r, --root <dir>` 目标仓库（默认当前目录）
- `--max-size <MB>` 大文件阈值，默认 100
- `--history-depth <n>` 扫描最近 n 个 commit 的 diff，默认 100
- `--min-score <n>` 健康分低于 n 则退出码 1
- `--fail-on-high` 存在任意 HIGH 则退出码 1
- `--json` 输出 JSON
- `-q, --quiet` 仅输出摘要
- `-V, --version` 版本号

## 零依赖说明

仅使用 Node 内置模块 + 调用系统 `git` 二进制（仓库体检的本质前置）。不联网、不执行被测仓库的任何代码，纯只读分析。

## License

MIT

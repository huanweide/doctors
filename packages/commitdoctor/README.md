# commitdoctor

零依赖单文件 git 提交消息体检 CLI。扫描仓库最近 N 条提交消息的格式规范坏味道，给出 0-100 健康分，并可作为 CI 门禁。

与 [`repodoctor`](https://github.com/huanweide/repodoctor)（仓库工程卫生：危险文件 / 大文件 / LICENSE / 无意义提交占比）互补：repodoctor 看"仓库工程卫生"，commitdoctor 看"提交消息格式规范"，拼成 git 层治理双拼。

## 特性

- **零依赖**：纯 Node.js 标准库，单文件 `index.js`，无需 `npm install`。
- **开箱即扫**：`node index.js` 直接扫当前仓库。
- **健康分**：严重度加权（high×3 / medium×2 / low×1）汇总成 0-100 分。
- **CI 门禁**：`--fail-on-high` / `--max-high` / `--max-medium` / `--max-issues` / `--min-score`。
- **机器可读**：`--json` 输出结构化结果。
- **只读安全**：仅调用系统 `git` 读取日志，不联网、不写文件、无执行面。

## 安装 / 使用

```bash
# 直接运行（需 Node >= 18）
node index.js

# 或用 npx（发布后）
npx commitdoctor
```

## 规则清单

| 规则 | 严重度 | 说明 |
| --- | --- | --- |
| `empty-subject` | high | 提交主题行为空 |
| `subject-too-long` | high | 主题行超过 100 字符（硬上限） |
| `has-secret` | high | 消息疑似泄露密钥 / 凭据（含私钥块） |
| `subject-long` | medium | 主题行超过推荐长度（默认 72） |
| `has-todo-marker` | medium | 消息含未完成标记 `TODO` / `FIXME` / `HACK` / `WIP` |
| `subject-trailing-period` | low | 主题行以句号等标点结尾 |
| `subject-leading-space` | low | 主题行前导空格 |
| `subject-trailing-space` | low | 主题行尾部空格 |
| `merge-no-desc` | low | 合并提交无说明（可用 `--ignore-merges` 跳过） |
| `no-body-separator` | low | 正文与主题间缺少空行分隔 |
| `draft-markers` | low | 消息含草稿标记 `TMP` / `DEBUG` / `temp` / `asdf` |
| `subject-emoji` | low | 主题含 emoji 噪音（默认开，可 `--no-check-emoji` 关） |
| `non-standard-type` | low | 疑似类型前缀但格式 / 大小写不符规范 |

## 健康分

每条问题按严重度扣分（high 3 / medium 2 / low 1），`健康分 = max(0, 100 - 扣分总额)`。

## CI 门禁示例

```yaml
# .github/workflows/commitlint.yml
- name: commitdoctor
  run: npx commitdoctor --fail-on-high --max-medium 5 --min-score 90
```

退出码：`0` 通过；`1` 门禁失败；`2` 参数错误。

## 选项

```
-p, --path <dir>          目标 git 仓库（默认当前目录）
-n, --max-commits <n>     扫描最近 n 条提交（默认 50）
    --since <spec>        仅扫描此日期之后（传给 git --since，如 "2.weeks"）
    --max-subject-len <n> 主题行推荐长度上限（默认 72）
    --ignore-merges       跳过合并提交
    --no-check-emoji      关闭 emoji 检测
    --json                输出机器可读 JSON
    --fail-on-high        存在任何 high 问题即失败
    --max-high <n>        high 数超过 n 即失败
    --max-medium <n>      medium 数超过 n 即失败
    --max-issues <n>      问题总数超过 n 即失败
    --min-score <s>       健康分低于 s 即失败（0-100）
-V, --version             打印版本
-h, --help                打印帮助
```

## 局限

- `has-secret` 在消息层做轻量正则匹配，可能误命中正常含 `token` / `access_key` 等词的合法描述；它定位"明文凭据泄露"高危信号，与 `repodoctor` 的源码层密钥扫描互补，不替代专业密钥扫描器。
- 不强制 Conventional Commits；仅对"明显像类型前缀但格式不符"做低严重度提示。

## License

MIT

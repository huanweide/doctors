# docdoctor

Markdown 文档健康体检——零依赖、单文件、开箱即扫的命令行工具。把仓库里 `.md` 文档的常见坏味道（死链接、跳级标题、缺失图片替代文本、裸 URL 等）一次性查出来，给出 0–100 健康分，并可直接接进 CI 做门禁。

不需要安装任何依赖，不需要联网，不需要配置文件。`node index.js` 即可运行。

## 为什么做这个

死链接、跳级标题、缺 alt 的图片——这些文档坏味道人人都踩，但现有工具要么只盯死链接（linkbust）、要么需要装一整套 ESLint/remark 配置（markdownlint）、要么要跑浏览器 DOM（axe）。docdoctor 的切入点很窄但很实在：**零依赖单文件，把文档健康的多个维度整合起来一次性体检**，顺手给出健康分和 CI 门禁。

它和 family 里的 devdoctor（项目体检）、a11ydoctor（Web a11y）、repodoctor（Git 仓库卫生）是同源思路：没有一个零依赖单文件工具同时做多维文档健康整合。

## 安装

不需要安装。直接用 Node 运行：

```bash
node index.js [路径...] [选项]
```

或全局链接后使用：

```bash
npm link   # 可选，之后可用 docdoctor 命令
```

要求 Node >= 18（用到正则后行断言等语法）。

## 用法

```bash
# 扫描当前目录所有 .md（递归）
node index.js

# 扫描指定目录或文件
node index.js ./docs README.md

# 机器可读输出
node index.js --json

# CI 门禁：只要存在高危问题就失败
node index.js --fail-on-high

# 自定义超大文档阈值与问题上限
node index.js --max-lines 2000 --max-issues 10 --max-high 0
```

## 检测维度

| 规则 | 严重度 | 说明 |
| --- | --- | --- |
| D1 死链接 / 锚点 | high / medium | 相对路径指向不存在的本地文件（high）；`#anchor` 在目标文件无匹配标题（medium） |
| D2 超大文档 | medium / low | 文档行数超过阈值建议拆分；单文件超过 256KB 直接跳过内容扫描 |
| D3 标题跳级 | low | 从 H1 直接跳到 H3 这类层级断裂 |
| D4 锚点冲突 | low | 同文档出现多个相同 slug 的标题，GitHub 锚点会指向错误位置 |
| D5 图片缺 alt | medium | 可访问性：图片没有替代文本 |
| D6 裸 URL | low | 行内未用 Markdown 链接包裹的 http(s) 地址（代码块内豁免） |
| D7 参考链接定义缺失 | medium | 使用了 ``[text][ref]`` 但找不到对应的 ``[ref]: url`` 定义 |

所有检测都在围栏代码块（``` 或 ~~~）和行内代码（`...`）之外进行，所以文档里的示例不会引发误报。

## 健康分

每个文件的加权扣分公式：high×3 + medium×2 + low×1，每文件允许 2 点加权问题不扣分，超出部分每点扣 8 分，封底 0 分。仓库健康分为所有文件得分的平均。

```
健康分 = max(0, 100 - max(0, 加权问题数 - 2) × 8)
```

## CI 门禁

退出码语义：

- `0`：健康（无高危文档问题）
- `1`：存在高危文档问题（如死链接）
- `2`：CI 门禁越界（`--fail-on-high` 触发、或问题数 / 高危数超过 `--max-*` 上限），或用法错误

GitHub Actions 示例：

```yaml
name: docs-health
on: [push, pull_request]
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx -y https://github.com/huanweide/docdoctor.git --fail-on-high ./docs
```

## 与竞品的差异

- **linkbust**：零依赖、只查本地死链接这一个专科。docdoctor 把死链接作为众多维度之一，额外覆盖标题结构、文档规模、图片 alt、裸 URL、参考链接，并输出健康分和 CI 门禁——定位是"文档整体健康度"而非"死链接专科"。
- **markdownlint / remark**：需要安装并配置规则集，偏重"风格规范"。docdoctor 零依赖、开箱即扫、偏重"健康体检 + 门禁"。
- **axe / markdown-link-check**：前者要浏览器 DOM，后者要联网查外部 URL。docdoctor 纯本地、确定性、不会因外部网站宕机而让 CI 飘红。

## 示例输出

```text
✗ docs/guide.md (健康分 82)
  L12 [HIGH] D1 链接指向不存在的本地文件：./old-api.md
  L5  [MED ] D5 图片缺少替代文本(alt)：![](/img/logo.png)

汇总：3 文件 · 1 高危 · 1 中危 · 0 低危 · 健康分 88
```

## 许可证

MIT

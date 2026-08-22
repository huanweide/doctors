# a11ydoctor

零依赖单文件 **Web 可访问性静态扫描 CLI**。扫 HTML / JSX / Vue / Svelte 模板的语义 a11y 反模式，给出严重度、加权健康分与 CI 门禁。纯 Node 标准库实现，**零依赖、零配置、可离线**。

> 属于「代码健康 family」前端切片：devdoctor（依赖体检）+ testlite（测试体检）+ debtlens（技术债密度）+ a11ydoctor（前端可访问性）。

## 为什么不是 oxlint / axe

- **oxlint**：Rust 零配置 linter，但 jsx-a11y 规则需 ESLint + React 配置才能启用，且聚焦 JSX 而非纯 HTML。
- **axe-core**：需要浏览器 DOM 运行时，无法在 CI 里纯静态跑。
- **a11ydoctor**：纯 HTML / 模板层静态扫描，不需要任何框架配置，确定性、开箱即跑、`--json` + `--fail-on` 直接进 CI。

## 安装 / 使用

```bash
# 直接跑（无需 npm install）
node index.js ./src
node index.js index.html --json
a11ydoctor . --fail-on any --max 0
```

全局安装（可选）：

```bash
npm i -g a11ydoctor
a11ydoctor ./src
```

## 四问摘要

1. **解决什么**：前端 / Web 项目里肉眼难查的语义无障碍缺陷（缺 alt、表单无 label、按钮无名字、缺 lang、标题跳级、表格无表头、空链接、键盘不可达等）。
2. **受众**：任何写 HTML / JSX / Vue / Svelte 的团队与个人；WCAG / ADA / 国标无障碍合规是法律与企业刚需。
3. **市面平替**：oxlint（需 React/ESLint 配置）、axe（需浏览器）、html-validate（需装需配）。a11ydoctor 零依赖、纯静态、确定性。
4. **架构**：单文件 Node CLI。轻量 HTML tokenizer（状态机跳过引号内 `>`、void 元素不入栈、`<script>/<style>` 不递归避免误报）+ 上下文规则引擎（祖先栈判断 label 包裹、子树判断 table/th、全局判断 heading 顺序）+ 加权健康分 + CI 门禁。

## 检测规则

| 规则 | 严重度 | 说明 |
|---|---|---|
| `img-alt` | high | `<img>` 缺少 alt 属性（装饰图用 `alt=""` 显式声明） |
| `html-lang` | high | `<html>` 缺少 lang 属性 |
| `label-association` | medium | 表单控件缺少 label 关联（for/id、包裹 label、aria-label） |
| `accessible-name` | medium | `<a>`/`<button>` 缺少可访问名称（文本 / aria-label / title） |
| `heading-order` | medium | 标题层级跳级（h1 之后直接 h3） |
| `table-structure` | medium | `<table>` 缺少 `<th>` 或 `<caption>` |
| `link-purpose` | medium | `<a>` 用途不明（空锚点 `#` / `javascript:`） |
| `interactive-role` | medium | `<div onclick>` 缺 role/tabindex，键盘不可达 |
| `deprecated-element` | low | 使用已废弃元素（blink/marquee/center/font） |
| `media-alternative` | low | `<video>/<audio>` 建议提供 `<track>` 字幕 |
| `title-present` | low | 文档缺少 `<title>` |
| `doctype` | low | HTML 文件缺少 `<!DOCTYPE>`（仅 .html/.htm） |

## 健康分

每个问题按严重度加权（high×3 / medium×2 / low×1）。每千行允许 1 个加权问题不扣分，超出部分每个扣 25 分，封底 0。

```bash
$ node index.js demo.html
demo.html:3  [high] img-alt — <img> 缺少 alt 属性
demo.html:8  [medium] label-association — <input> 缺少可访问的标签关联

汇总: 文件 1 · 问题 2 (高1/中1/低0) · 健康分 50/100
```

## CI 门禁

```bash
# 有任何高严重度问题则失败（默认）
a11ydoctor . --fail-on high

# 有任何问题即失败
a11ydoctor . --fail-on any

# 问题总数上限（配合 --max）
a11ydoctor . --max 5

# JSON 报告（便于门禁平台消费）
a11ydoctor . --json
```

退出码：`0` 通过；`1` 门禁失败；`2` 参数 / 路径错误。

## 已知局限

- 可访问名称判定基于 `aria-*` / `title` / `alt` 属性或标签内**直接**文本；复杂嵌套文本建议在交互元素上加 `aria-label`。
- 颜色对比度属运行时计算，本工具不覆盖（需 axe + 浏览器）。
- 估算类指标仅供体检参考，非权威合规认证。

## License

MIT

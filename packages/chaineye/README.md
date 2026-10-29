**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# chaineye（依赖链眼）—— 改代码之前，先看清会连累谁

> 一句话：你改了一个文件，它能立刻告诉你「还有哪些文件会跟着坏」。

你肯定遇到过这种事：改了个底层函数，结果另一个八竿子打不着的文件崩了，你完全不知道自己改漏了谁。chaineye 就是干这个的——它把你的代码仓库扫一遍，画出「谁依赖谁」的关系图，然后你问它「我改了 X，会连累谁」，它秒答。

**生活类比**：就像给房子装了个「水管探测器」。你打算在二楼改一根水管，它先告诉你「这根管子连着一楼的马桶和热水器，动之前想清楚」。chaineye 就是代码的管道探测器——你动一下，它告诉你震波会传到哪。

[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![零依赖](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## 它能干啥（说人话）

- **改 X 之前先看清波及面**：`chaineye impact src/core/parser.js` → 列出所有会受影响的文件。改之前心里有数，不背锅。
- **谁在偷偷用这个文件**：`chaineye why src/core/parser.js` → 谁直接 import 了它。
- **揪出循环依赖（会炸的环）**：`chaineye cycles` → 找出「A 依赖 B、B 又依赖 A」这种死循环。
- **找孤魂野鬼文件**：`chaineye orphans` → 谁也没用、也没被用的废文件，可以删。
- **找枢纽文件（最危险）**：`chaineye hubs` → 被依赖最多的文件，改它影响面最大。
- **当 CI 门禁**：`chaineye . --max-cycles 0 --fail-on-cycle` → 一有循环依赖就拦住你，别合并。

---

## 怎么用（三步，不用装不用配）

```bash
# 1. 扫一遍当前仓库 + 跑 CI 门禁
npx chaineye .

# 2. 我要改 parser.js，谁会倒霉？
npx chaineye impact src/core/parser.js

# 3. CI 里拦循环依赖（有环就不让合并）
npx chaineye . --max-cycles 0 --fail-on-cycle
```

克隆下来 `node index.js .` 就能跑，零依赖、零配置。

---

## 为啥用它，而不是 madge / dependency-cruiser（说人话）

那俩也能画图，但你只是想看个「改 X 影响谁」，结果还得先 `npm i` 一堆东西、配一堆规则、研究说明书。chaineye 就死磕「影响范围」这一件事：零依赖、单文件、开箱即用。巨头嫌这功能太小、现有工具嫌这功能太轻，chaineye 刚好填上这个缝。

---

## 四问摘要（给想深究的你）

1. **真实痛点？** 进陌生仓库靠 grep 手撸依赖关系；改底层文件前不知道波及哪些上游，容易漏改连锁崩。「影响范围」是高频刚需。
2. **凭啥是它（差异化）？** madge / dependency-cruiser 能画图但配置重、输出重、CI 门槛要自己拼。chaineye 零依赖单文件、开箱即用、原生 CI 门禁，填「巨头嫌小、OSS 嫌重」的缝。
3. **能长期维护？** 纯静态解析、无外部依赖、无网络，逻辑面小且稳定；加语言只需在 `parseImports` 加一个分支。
4. **能上 star？** 切中「重构前波及面评估」「CI 防循环依赖」「AI 代理理解陌生仓库」三类真实场景，单文件零依赖降低采用摩擦。

---

## 工作原理

1. **扫描**：递归遍历仓库，忽略 `node_modules` / `.git` / `dist`，收集 JS/TS/Python/Go 源文件。
2. **解析**：正则提取相对导入（`import` / `require` / 动态 `import()` / Python `from .x` / Go `import "./x"`），解析成仓库内真实路径（自动补扩展名、目录索引）。
3. **建图**：依赖 DAG，`A → B` 表「A 依赖 B」，同步维护反向边。
4. **分析**：影响范围 = 反向边传递闭包；循环依赖 = 三色 DFS；孤立 = 入出度均 0；枢纽 = 入度最高。
结果确定性：同仓库同扫描输出完全一致，可进 CI 做回归闸门。

## 支持语言

| 语言 | 支持的导入写法 |
|------|----------------|
| JavaScript / TypeScript | `import ... from` / `import` / `export ... from` / `require()` / 动态 `import()` |
| Python | `import x` / `from x import y` / `from .x import y` / `from ..x.y import z`（相对导入跨扩展名） |
| Go | `import "x"` / `import ( "x" "y" )` 中的相对路径 |

仅分析仓库内相对导入；第三方裸模块（如 `react`）不计入依赖边。

## CI 门禁示例（GitHub Actions）

```yaml
- name: 依赖影响门禁
  run: npx chaineye . --max-cycles 0 --fail-on-cycle
```

退出码：通过 `0`，不通过 `1`，可直接阻断合并。

## 许可

[MIT](./LICENSE) © Overlord Forge

---

## 作者

由 **ReTr · huanweide** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度；若存在不达标项会以非 0 退出码结束，从而拦下问题提交（具体参数见上方「快速开始」）。


## 🧰 同一作者的其他工具

> 作者在做一系列开源效率工具，欢迎顺手点 Star 支持：

- 📚 长篇创作 — AI 小说工坊，本地规则引擎零依赖：[点此访问](https://github.com/huanweide/novel-smith)
- 🎓 网课助手 — 智慧树自动播放/续播/AI 答题：[点此访问](https://github.com/huanweide/zhihuishu-helper)
- 🎬 字幕/视频 — B站字幕一键提取（零 Key 取官方字幕）：[点此访问](https://github.com/huanweide/bili-subtitle-universal)
- 📺 实时字幕 — 直播/会议实时字幕：[点此访问](https://github.com/huanweide/live-subtitle)
- ✂️ 视频摘要 — 长视频一键总结：[点此访问](https://github.com/huanweide/video-brief)
- 🖥️ 总览 — 作者全部开源项目集散：[点此访问](https://github.com/huanweide/family-showcase)
- 🩺 代码健康 — 零依赖多轴静态体检：[点此访问](https://github.com/huanweide/doctors)
## 许可证

详见 [LICENSE](LICENSE)。
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

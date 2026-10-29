<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/awaitscan)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/awaitscan)](https://github.com/huanweide/awaitscan/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# awaitscan

> 零依赖单文件 Node CLI · 异步性能反模式静态扫描器

一眼找出你代码里「悄悄拖慢速度的异步写法」。静态扫描三类高信号、零依赖即可确定性检测的性能反模式，给出 **0–100 健康分** 和可直接进 CI 的**门禁**。

零依赖、零配置、离线、单文件，开箱即跑。

```
awaitscan · 异步性能反模式扫描 · root=./src
  扫描源文件   : 12
  源码总行数   : 1840
  问题总数     : 3 (加权 8)
  严重度分布   : high=2 medium=1 low=0
  规则明细     : serial-await-in-loop=2  await-in-map=0  nested-loop=1
  问题清单:
    [high] src/fetch.js:42  循环内串行 await
          循环体内出现 await（for 循环串行执行，迭代间无依赖时应改用 Promise.all 并行）
    [high] src/batch.js:18  循环内串行 await
          循环体内出现 await（for 循环串行执行，迭代间无依赖时应改用 Promise.all 并行）
    [medium] src/matrix.js:7  嵌套循环（O(n^2) 风险）
          循环体内嵌套另一循环（O(n^2) 风险，确认是否可用哈希/集合去重或拆分）
  健康分       : 71 / 100  [基本健康]
  门禁: 通过
```

## 为什么

`async/await` 让异步代码读起来像同步，但也最容易藏性能坑：在 `for` 循环里逐个 `await`（本可 `Promise.all` 并行）、在 `.map()` 回调里 `await`（map 不会自动并行，结果仍串行）、随手写嵌套循环（O(n²)）。这些要么需要人肉 review 凭感觉，要么装重型 Linter。

`awaitscan` 把这件事压成一个命令：零依赖、零配置、一个文件，跑完直接给你问题清单、健康分和 CI 门禁。

## 检测的三类反模式

| 规则 ID | 严重度 | 说明 |
| --- | --- | --- |
| `serial-await-in-loop` | high | 循环体（`for`/`for-of`/`while`/`do`）内直接出现 `await`，应改用 `Promise.all` 并行 |
| `await-in-map` | high | `.map()` 回调内出现 `await`（`map` 不自动并行，结果仍串行，应 `Promise.all` 包裹） |
| `nested-loop` | medium | 循环体表层嵌套另一循环（O(n²) 风险，确认是否可用哈希/集合去重） |

> 合法用法不误报：`for await (const x of asyncIter)` 消费异步迭代器会被正确跳过；回调体内的 `await`（非循环表层）不会被当成循环内串行；`Promise.all(arr.map(async x => ...))` 已被识别为真实并行并豁免。

## 特性

- **零依赖单文件**：只有一个 `index.js`，`node index.js ./` 即可，无需 `npm install`。
- **确定性静态扫描**：用括号平衡定位循环体 / map 回调体，并去除内层块得到「表层」再检测，避免把内层函数的 `await` 误算成循环内串行。
- **双重降误报**：扫描前用逐字符 tokenizer 剥离注释、字符串与模板串（保留换行），排除字符串与文档里的伪 `await`/`for`。
- **健康分 + 门禁**：0–100 健康分（每千行允许加权问题 1 不扣分，超出按系数 25 扣）；CI 门禁阈值一律 `Number.isFinite` 校验，非整数直接 `exit 2`，绝不静默放行。
- **安全**：纯本地只读、不联网、无执行面；扫描前 `statSync` 校验 root；>5MB 文件跳过防 OOM；自动跳过 `node_modules/.git` 等目录。

## 安装

```bash
# 全局
npm i -g awaitscan
# 或直接用单文件（无需安装）
node /path/to/awaitscan/index.js ./your-repo
```

## 用法

```bash
# 默认扫描当前目录
awaitscan

# 扫描指定目录，输出 JSON（便于流水线解析）
awaitscan --root ./src --json

# CI 门禁：出现任何高危反模式（串行 await / map 内 await）即失败
awaitscan --root . --fail-on-high

# 高危反模式超过 0 个即失败（等价写法）
awaitscan --root . --max-high 0

# 中危（嵌套循环）超过 3 个即失败
awaitscan --root . --max-medium 3

# 总问题数超过 5 即失败
awaitscan --root . --max-issues 5
```

### 门禁参数

| 参数 | 含义 | 失败条件 |
| --- | --- | --- |
| `--max-high <n>` | 高危反模式（串行 await / map 内 await）数量 | 超过 `n` |
| `--max-medium <n>` | 中危反模式（嵌套循环）数量 | 超过 `n` |
| `--max-issues <n>` | 总问题数 | 超过 `n` |
| `--fail-on-high` | 出现任何高危反模式即失败 | 有高危 |
| `--fail-on-issues` | 存在任何警告即失败 | 有警告 |

> 所有阈值非整数一律 `exit 2`（防呆），不会悄悄放行。

## CI 集成示例

```yaml
# .github/workflows/perf.yml
- name: 异步性能门禁
  run: npx -y awaitscan --root . --fail-on-high
```

## 与 oxlint 的区别

[oxlint](https://github.com/oxc-project/oxlint)（Rust、零配置、700+ 规则）含 `perf` 类别，但它是通用 Linter，不聚焦「串行 await 语义」这一特定高信号切口。`awaitscan` 零依赖单文件、纯 JS 层静态扫描，**确定性可复现**，专门把「循环内串行 await / map 内 await」这一类最容易被忽略、却最影响吞吐的异步反模式做成一把尺子，更适合塞进任何 Node 项目的 CI 做异步性能体检。

## 与 family 的关系

`awaitscan` 是「代码健康 family」的第五件（性能 / 可维护性切面）：

- **devdoctor** — 依赖体检（胖瘦 / 许可证 / 循环依赖 / 明文密钥）
- **testlite** — 测试卫生体检（框架 / 密度 / 覆盖率）
- **debtlens** — 技术债密度体检（TODO/FIXME 等标记密度 + 健康分）
- **a11ydoctor** — 前端可访问性体检（Web a11y 反模式 + 健康分）
- **awaitscan** — 异步性能体检（串行 await / map 内 await / 嵌套循环）← 你在这

五件都是零依赖单文件、同一套工程准则，可单独用，也可组合成项目体检流水线。

## 局限

- 基于「括号平衡 + 表层扫描」的启发式，不构建完整 AST；极特殊写法（如动态 `eval` 拼出的循环）可能漏检。统计为**估算**，重度场景请结合人工 review。
- 只检测 JS/TS 生态源文件（`.js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx/.vue/.svelte`），不扫文档/配置。
- 嵌套循环（medium）是提示性信号：很多合理的二维遍历本就是嵌套循环，请结合上下文判断是否真的可优化。

## 许可

MIT © huanweide

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

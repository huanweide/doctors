<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/idiot-index)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/idiot-index)](https://github.com/huanweide/idiot-index/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# idiot-index · 白痴指数 CLI

> 白痴指数 = 成品复杂度 ÷ 理论最小复杂度。指数越高，制造流程里的浪费越大。
> 一键量化你的项目有多「胖」：可被原生 API 替代的依赖 + 过度工程分数。**零依赖、单文件、本地、确定性、可进 CI。**

> **📦 便携性速览**
>
> - **零依赖、单文件**（`index.js`），拷进任意仓库 `node index.js .` 即跑，无需 `npm install`。
> - 本地、确定性、可进 CI（`--max` 做门禁）；要求 Node ≥ 18。


## 为什么不是又一个 lint wrapper

`knip` 查死依赖、`eslint` 查复杂度、`depcheck` 查未用——它们是三个工具。我们把它们**组合成一个挑衅性单一指标 + 原生替代建议**，并且：

- 确定性：不靠 AI、不连网，同一项目永远同一分数。
- 可进 CI：一个数字即可做门禁（`--max`）。
- 天生病毒传播：「你的项目白痴指数是多少？」比「感觉很乱」好分享。

## 安装 / 运行

零依赖，拷文件即跑（Node ≥ 18）：

```bash
node index.js .                   # 扫描当前目录
node index.js src/               # 扫描指定目录
node index.js . --json           # 输出 JSON，供 CI 读取
node index.js . --max 40         # 指数 > 40 时退出码 1（CI 门禁）
node index.js . --require-usage  # 只对「源码中未被引用」的冗余依赖计分
node index.js --help
```

> 注意：npm 上**没有** `idiot-index` 这个包（实测 E404），所以 `npx idiot-index` 会失败。
> 请直接用 `node index.js`，或 `npm install -g .` 后用全局命令。

## 它查什么

1. **冗余依赖**：`package.json` 里命中内置替代表的包（moment→Intl、lodash→原生、axios→fetch、uuid→crypto.randomUUID…）。
2. **过度工程**：递归扫描源码，按「最大嵌套深度 + 类型/接口声明密度」给每个文件打分，列出 Top10 最胖文件。

两者合成 0–100 的**白痴指数**，A(<20) / B(<40) / C(<60) / D(<80) / F(≥80)。

## 它怎么区分「删掉」和「评估迁移」

这是本工具最要紧的一处诚实性设计。

**只读 `package.json` 会给出有害的建议**：如果你的代码里正在 `require('lodash')`，工具却因为 `package.json` 声明了它就说「删掉 lodash」——照做就是自找麻烦。

所以工具会扫源码里的真实引用（`require()` / `import x from` / `import 'x'` / `lodash/fp` 这类子路径），把结论分成两类：

| 状态 | 结论 | 文案 |
|---|---|---|
| `usedInSource: false` | 真的可以删 | `[未引用] 删掉 moment → 用 Intl.DateTimeFormat / Temporal` |
| `usedInSource: true` | 只能评估迁移 | `[在用] axios 被源码引用，先评估迁移成本 → 目标 node:fetch（需 Node 18+）` |

替代方案有版本门槛的（`glob`→`node:fs.glob` 要 Node 22+），文案里会带上 `需 Node NN+`，不会骗你。

**默认计分口径不变**（仍按声明计分，向后兼容）。想要更严格的口径加 `--require-usage`，此时只有「未引用」的冗余依赖计入惩罚。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 扫描完整，且指数达标 |
| 1 | 指数超阈值（`--max`） |
| 2 | 参数错误 / 目标目录不存在 / 目标不是目录 |
| 3 | **未扫到任何源码文件**——0 分不代表健康，分数不构成有效结论 |

## 为什么会有退出码 3

老版本对路径打错、空目录的处理是：扫到 0 个文件 → 分数 0 → 等级 A →「依赖克制，赞」→ **退出码 0**。

也就是说，**你把目录名拼错了，CI 会给你一个绿色通过**。这比漏报恶劣得多。

现在：目标不存在直接退出 2；目标存在但扫不到源码文件，输出 `basisComplete: false` 并退出 3。
JSON 里的 `basisComplete` 就是给CI 用的可信度开关。

## JSON 输出

```json
{
  "score": 18,
  "grade": "A",
  "redundantFound": [
    {
      "name": "lodash",
      "replacement": "原生 Array/Object/Map 方法",
      "requiresNode": null,
      "dev": false,
      "declaredIn": ".",
      "usedInSource": true
    }
  ],
  "countedForPenalty": ["lodash"],
  "strictUsage": false,
  "scannedFiles": 128,
  "manifestsFound": 1,
  "basisComplete": true,
  "topFiles": [ ... ],
  "suggestions": [ ... ]
}
```

## CI 集成

```yaml
- run: node idiot-index/index.js . --max 50
```

分数超标即红，逼团队在膨胀前刹车。

## monorepo

会递归发现所有 `package.json`（含 workspaces 子包），冗余依赖标注 `declaredIn`，来源一目了然。上限 200 个 manifest，避免巨型仓库跑飞。

## 开发

```bash
node test.js                   # 自测（24 项）
node scripts/smoke-cli.js      # 端到端冒烟（31 项 spawn 级断言）
```

## 🧰 同一作者的其他工具

> 作者在做一系列开源效率工具，欢迎顺手点 Star 支持：

- 📚 长篇创作 — AI 小说工坊，本地规则引擎零依赖：[点此访问](https://github.com/huanweide/novel-smith)
- 🎓 网课助手 — 智慧树自动播放/续播/AI 答题：[点此访问](https://github.com/huanweide/zhihuishu-helper)
- 🎬 字幕/视频 — B站字幕一键提取（零 Key 取官方字幕）：[点此访问](https://github.com/huanweide/bili-subtitle-universal)
- 📺 实时字幕 — 直播/会议实时字幕：[点此访问](https://github.com/huanweide/live-subtitle)
- ✂️ 视频摘要 — 长视频一键总结：[点此访问](https://github.com/huanweide/video-brief)
- 🖥️ 总览 — 作者全部开源项目集散：[点此访问](https://github.com/huanweide/family-showcase)
- 🩺 代码健康 — 零依赖多轴静态体检：[点此访问](https://github.com/huanweide/doctors)

## License

MIT，详见 [LICENSE](LICENSE)。

## 作者

由 **ReTri · huanweide** 维护 · [GitHub 主页](https://github.com/huanweide)

---

## 🧰 更多开源工具（by ReTri · huanweide）

- 🎬 字幕 / 视频：[bili-subtitle-universal](https://github.com/huanweide/bili-subtitle-universal) · [live-subtitle](https://github.com/huanweide/live-subtitle) · [zhihuishu-helper](https://github.com/huanweide/zhihuishu-helper) · [video-brief](https://github.com/huanweide/video-brief)
- 🩺 代码健康全家桶（18 轴零依赖 CLI）：[family-showcase](https://github.com/huanweide/family-showcase)
- 🔧 命令行利器：[idiot-index](https://github.com/huanweide/idiot-index) · [recall-cli](https://github.com/huanweide/recall-cli) · [forge-safeguard](https://github.com/huanweide/forge-safeguard-20260812)
- 🖥️ 桌面 / 资讯：[floatsnip](https://github.com/huanweide/floatsnip) · [tech-news-hub](https://github.com/huanweide/tech-news-hub)
- 📦 全部仓库：<https://github.com/huanweide?tab=repositories>

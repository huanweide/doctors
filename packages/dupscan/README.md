<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/dupscan)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/dupscan)](https://github.com/huanweide/dupscan/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# dupscan

零依赖单文件重复代码块检测 CLI —— 代码健康 family 第八轴「重复代码」。

扫 JS / TS 生态（`.js .mjs .cjs .ts .jsx .tsx .vue .svelte`），找出连续重复的代码片段，给出严重度加权健康分与开箱即用的 CI 门禁。不联网、不装依赖、不需要配置，单文件 `index.js` 直接跑。

## 为什么需要它

重复代码是 SonarQube 列出的头号技术债坏味道之一：同一段逻辑被复制粘贴，改一处忘改另一处就会埋下 bug。dupscan 用确定性的静态扫描把"重复块"量化出来，让复制粘贴在 Code Review 和 CI 里无所遁形。

## 安装

```bash
git clone https://github.com/huanweide/dupscan
cd dupscan
node index.js .          # Node >= 14
```

零依赖，不需要 `npm install`。

> **本包未发布到 npm registry**（`npm i -g dupscan` 会 404）。克隆后 `npm link` 即可当全局命令用，或直接 `node index.js`。
>
> 运行环境：**Node >= 14**（`engines` 如实声明，CI 有 Node 14/22 双版本矩阵实测）。
> 注：`node --test` 需 Node >= 18，Node 14 下 CI 走等价的冒烟自检路径。

## 用法

```bash
# 扫当前目录
node index.js .

# 扫指定目录，最小重复块改为 6 行
node index.js src --min-lines 6

# 机器可读输出（CI 里接 jq / 流水线）
node index.js . --json

# CI 门禁：不允许任何 HIGH 重复块，且重复块总数不超过 3
node index.js . --fail-on-high --max-issues 3

# 仅容忍最多 20 行"额外重复行"（重复块行数 × 重复份数 - 1 的累计）
node index.js . --max-lines 20
```

## 门禁三态（重要）

扫描型门禁工具最恶劣的失败模式是「**扫了 0 个对象却报通过**」——CI 上就是一盏永不熄灭的绿灯。
更隐蔽的是：即使显式传了 `--max-issues` / `--fail-on-high`，空输入照样「通过」，用户的门禁配置在那一刻完全是摆设。

所以 dupscan 不输出布尔结论，而输出三态（`--json` 里见 `gate.state` 与 `basisComplete`）：

| `gate.state` | 退出码 | 含义 |
| --- | --- | --- |
| `pass` | 0 | 配了门禁阈值、输入可信、指标达标 |
| `fail` | 2 | 配了门禁阈值，且至少一项不达标 |
| `inconclusive` | 3 | **无法下结论**：未配任何门禁阈值，或扫描输入为空 / 全部文件无可解析内容 |

```jsonc
{
  "scanned": 128,
  "health": 94,
  "duplicateBlocks": 3,
  "gate": { "state": "pass", "configured": true, "reason": "全部指标达标" },
  "basisComplete": true   // false 表示本次结论不可信，别拿它当合规证据
}
```

> 未配门禁阈值时返回 `3` 而不是 `0`，是刻意的：这样「我只是跑着看看」不会在 CI 里被误读成「检查通过」。
> 想让它放行，显式写 `--max-issues 9999` 即可。
>
> **退出码变更**：门禁失败历史上返回 `1`，现统一为家族约定的 `2`（`0` 通过 / `2` 失败 / `3` 无法判定）。

所有数值参数必须是**合法整数**：`--min-lines` 必须 `>= 1`（`0` 会让 n-gram 窗口退化成空串，把整个文件判成互相重复），
`--max-issues` / `--max-lines` 必须 `>= 0`；缺值、空串、小数、尾随垃圾字符（如 `5abc`）一律退 `2`。
其中 `5abc` 尤其关键——`parseInt('5abc') === 5` 会把拼错的门禁值静默截断，让门禁根本没生效。

## 原理

1. **逐字符 tokenizer 剥离噪声**：把注释、字符串字面量位置变空格，但保留换行（行号对齐）。字符串内容归一化为占位符 `_`，所以"逻辑相同但字符串不同"的复制会被准确识别为重复。
2. **正则上下文感知**：遇到 `/regex/` 不会把正则里的引号误判成字符串（这是零依赖 SAST 的经典坑）。
3. **行归一化**：每行去前后空白、压缩内部空白。
4. **行哈希 n-gram 滑动窗口**：对每连续 `--min-lines` 行计算块指纹，相同指纹归组。
5. **区间合并 + 跨文件聚合**：把重叠窗口合并成连续重复块，并按块指纹跨文件统计"出现份数"。
6. **严重度加权健康分**：重复行越多、份数越多、跨文件越严重。

## 严重度

| 等级 | 触发条件 |
| --- | --- |
| `HIGH` | 块 ≥ 15 行 **或** 跨文件重复 **或** 出现 ≥ 4 次 |
| `MED` | 块 ≥ 8 行 **或** 出现 ≥ 2 次 |
| `low` | 其余 |

## 健康分

`health = clamp(100 - 额外重复行 / 总行数 × 200, 0, 100)`。额外重复行 = 每个重复块行数 ×（份数 − 1）的累计。0 重复即 100 分。

## 与 jscpd 的差异

| | dupscan | jscpd |
| --- | --- | --- |
| 依赖 | 零依赖单文件 | 需 `npm install` + 配置 |
| 范围 | JS/TS 聚焦，确定性 | 跨语言泛化 |
| CI 门禁 | 内置 `--max-issues` / `--max-lines` / `--fail-on-high` | 需额外集成 |
| 定位 | 开箱即用的代码健康 family 一员 | 通用重复检测 |

## 代码健康 family（八件套）

`devdoctor`（依赖体检）· `testlite`（测试卫生）· `debtlens`（技术债）· `a11ydoctor`（前端可访问性）· `awaitscan`（异步性能）· `cycscan`（结构复杂度）· `secscan`（安全反模式）· **`dupscan`（重复代码）**

## 注意事项

跨文件重复往往是"共享库 / 共享范式"的真实信号（例如多个文件共用同一段 CLI 骨架），这本身就是值得治理的技术债，不是误报。用 `--max-issues` / `--max-lines` 设定你的 CI 容忍阈值即可。

## License

MIT

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度，并显式打印门禁状态；
若存在不达标项会以退出码 `2` 结束，若无法下结论则以 `3` 结束——**只有真正判定通过才是 `0`**（具体参数见上方「用法」）。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/dupscan) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 测试

```bash
node --test          # 37 组：单测 + spawn 级冒烟（Node >= 18）
```

`test/smoke-cli.js` 真实起进程验证**退出码契约**。这一层不可省略：`node --test` 的单测只测导出的函数，
根本不碰 `process.exitCode`，改退出码时单测会全绿放行。

## 许可证

[MIT](LICENSE)
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

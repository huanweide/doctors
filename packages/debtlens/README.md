<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/debtlens)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/debtlens)](https://github.com/huanweide/debtlens/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# debtlens

> 零依赖单文件 Node CLI · 技术债密度扫描器

一眼看清你的代码里「欠了多少债」。注释锚定扫描 `TODO / FIXME / XXX / HACK / OPTIMIZE / REFACTOR / NOTE / DEPRECATED` 等技术债标记，按严重度加权统计密度，给出 **0–100 健康分** 和可直接进 CI 的**门禁**。

零依赖、零配置、离线、单文件，开箱即跑。

```
debtlens · 技术债密度扫描 · root=/path/to/repo
  扫描源码文件 : 42
  源码总行数   : 3120
  含债文件数   : 11
  技术债标记   : 27 (加权 58)
  严重度分布   : high=9 medium=12 low=6
  密度         : 8.65 标记/千行
  加权密度     : 18.59 加权/千行
  标记明细     : TODO=9 FIXME=0 XXX=3 HACK=2 OPTIMIZE=4 REFACTOR=3 NOTE=5 DEPRECATED=1
  健康分       : 53 / 100  [债务偏高]
  警告:
    [警告] high-density: 技术债密度偏高 (8.65 标记/千行，软阈值 8)
    [警告] has-high-severity: 存在阻塞级标记 (TODO/FIXME) 共 9 个
  门禁: 通过  [state=pass configured=true]
    理由: 全部已配置门禁项达标。
```

## 为什么

任何带代码的项目都堆着 TODO/FIXME，但它们散落各处、无人衡量。团队想知道「技术债多到什么程度」时，要么靠人肉 code review 凭感觉，要么装一个重配置的工具。

`debtlens` 把这件事压成一个命令：零依赖、零配置、一个文件，跑完直接给你密度和健康分，还能卡 CI 门禁。

## 特性

- **零依赖单文件**：只有一个 `index.js`，`node index.js ./` 即可，无需 `npm install`。
- **注释锚定降误报**：标记必须跟在 `// # <!-- /*` 注释符之后，且扫描前先剥离字符串字面量，排除 `const todo = 1`、`"TODO: msg"` 这类伪标记。
- **严重度加权**：`TODO/FIXME`(高, ×3) · `XXX/HACK/OPTIMIZE/REFACTOR`(中, ×2) · `NOTE/DEPRECATED`(低, ×1)，加权密度比纯计数更贴近真实风险。
- **健康分 + 门禁**：0–100 健康分（每千行允许加权债务 1 不扣分，超出按系数 25 扣）；CI 门禁阈值一律严格校验，非数字 / 非整数 / 负数 / 空串 / 缺值 / 未知标记名 一律 `exit 2`，绝不静默放行。
- **门禁三态，不谎报绿灯**：退出码 `0 = pass`（已配置门禁且全部达标）、`2 = fail`（存在不达标项 / 参数非法）、`3 = inconclusive`（**未配置门禁阈值，或扫描输入为空 —— 结论不可信，不等于通过**）。见下方「退出码契约」。
- **健康分是有害指标，扫不到就不给分**：扫描 0 个文件时健康分为 `null`（`verdict: 无法评估`），而不是骗人的 `100`。JSON 里的 `basisComplete: false` 会告诉你结论能不能信。
- **安全**：纯本地只读、不联网、无执行面；扫描前 `statSync` 校验 root；>5MB 文件跳过防 OOM；自动跳过 `node_modules/.git` 等目录。

## 安装

本项目**尚未发布到 npm**。npm 上的 `debtlens` 是另一个无关项目（[ColumbusLabs/DebtLens](https://github.com/ColumbusLabs/DebtLens)，TypeScript/JavaScript 可维护性扫描器），`npm i -g debtlens` 装到的不是本工具，且会抢占 `debtlens` 这个命令名。请直接从源码用：

```bash
git clone https://github.com/huanweide/debtlens.git
node debtlens/index.js --root ./your-repo
```

或把它作为单一文件复制进你自己的仓库（它只依赖 Node 内置模块，无需 `npm install`）。

## 用法

```bash
# 默认扫描当前目录
debtlens

# 扫描指定目录，输出 JSON（便于流水线解析）
debtlens --root ./src --json

# CI 门禁：标记总数超过 50 直接失败
debtlens --root . --max-total 50

# 密度门禁：每千行标记数超过 10 失败
debtlens --root . --max-density 10

# 加权密度门禁
debtlens --root . --max-weighted 20

# 禁止出现任何 FIXME（出现即失败）
debtlens --root . --fail-on-tags FIXME

# 任何警告都当作不合格
debtlens --root . --fail-on-issues
```

### 门禁参数

| 参数 | 含义 | 取值要求 | 失败条件 |
| --- | --- | --- | --- |
| `--max-density <n>` | 标记密度（标记/千行） | 非负十进制数字 | 超过 `n` |
| `--max-weighted <n>` | 加权密度（加权/千行） | 非负十进制数字 | 超过 `n` |
| `--max-total <n>` | 总标记数 | 非负整数 | 超过 `n` |
| `--fail-on-tags <csv>` | 禁止出现的标记（逗号分隔） | 必须是已知标记名 | 出现任一 |
| `--fail-on-issues` | 存在任何警告即失败 | 开关 | 有警告 |

可用的标记名（取自源码 `TAGS` 常量）：`TODO` `FIXME` `XXX` `HACK` `OPTIMIZE` `REFACTOR` `NOTE` `DEPRECATED`

### 退出码契约

| 退出码 | 状态 | 含义 |
| --- | --- | --- |
| `0` | `pass` | 已配置门禁阈值，且全部达标 |
| `2` | `fail` | 已配置门禁阈值，且存在不达标项；**或**参数非法（阈值写错、未知选项、root 无效） |
| `3` | `inconclusive` | **未配置任何门禁阈值，或扫描输入为空 —— 结论不可信，不等于通过** |
| `1` | 内部异常 | 仅用于未预期的运行异常，门禁本身不返回 1 |

> **为什么要有 `3`**：扫描型门禁最恶劣的失败模式是「扫了 0 个对象却报通过」—— CI 上成一片永不熄灭的绿灯。所以只要输入不可信或门禁没配，就明确返回 3 让你知道「这次运行什么都没证明」。
>
> 判定顺序固定为：① 是否配了阈值 → ② 输入是否可信 → ③ 是否有不达标项。空输入下 `--fail-on-issues` 也返回 `3` 而非 `2`，因为那条「警告」本身就是空扫描的产物，不足为凭。
>
> 参数写错 = 门禁不存在。以下全部 `exit 2`，绝不静默放行：阈值缺值 / 空串 / 尾随垃圾（`5abc`）/ 小数给整数位 / 负数 / 十六进制 / `Infinity`；`--fail-on-tags` 拼错标记名；`--root` 缺值或吞掉下一个标志；任何未知选项。

## CI 集成示例

```yaml
# .github/workflows/debt.yml
- name: 技术债门禁
  run: node .github/debtlens/index.js --root . --max-density 10 --fail-on-tags FIXME
```

> 若把本仓库 clone 到 CI 里，请写明确的 `node <路径>/index.js`，不要用 `npx -y debtlens` —— npm 上那个名字是别人的包。
>
> CI 里请**显式传一个门禁阈值**。不传任何阈值时退出码是 `3`（未决），会直接把流水线判红 —— 这是刻意的：门禁必须由使用方明确定义，工具不该替你猜。

## 与 leasot 的区别

[leasot](https://github.com/codefin/leasot) 也能提取 TODO，但它是依赖包、偏「枚举列出」，不带健康分与 CI 门禁。`debtlens` 零依赖单文件、开箱即跑，且把「密度 → 健康分 → 门禁」做成闭环，更适合塞进 CI。

## 与 family 的关系

`debtlens` 是「代码健康 family」的第三块：

- **devdoctor** — 依赖体检（胖瘦 / 许可证 / 循环依赖 / 明文密钥）
- **testlite** — 测试卫生体检（框架 / 密度 / 覆盖率）
- **debtlens** — 技术债密度体检（TODO/FIXME 等标记密度 + 健康分）← 你在这

三者都是零依赖单文件、同一套工程准则，可单独用，也可组合成项目体检流水线。

## 局限

- 标记识别基于「注释锚定 + 字符串剥离」的启发式，对非常规写法（如块注释折行内的标记）可能漏检；统计为**估算**，重度场景请结合人工 review。
- 严重度权重为通用默认值，可按团队习惯在 `index.js` 的 `TAGS` 调整。

## 许可

MIT © huanweide

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## 开发与测试

零依赖，`node` 直接跑，无需 `npm install`：

```bash
node test/unit.test.js     # 15 组单元测试：扫描/三态判定/参数解析/自检门禁
node test/smoke-cli.js     # 29 项 spawn 级冒烟：真起进程钉死退出码契约
npm test                   # 等价于依次跑上面两个
```

两层测试的分工是刻意的：单测只覆盖导出的纯函数，**完全不碰 `process.exitCode`**；退出码契约只能由 `spawn-cli.js` 用 `spawnSync` 真起进程来验。改退出码时单测可能依然全绿，只有冒烟能拦住。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/debtlens) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

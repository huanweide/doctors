# typedoctor

零依赖类型健康体检 CLI。检查 TypeScript / JavaScript 项目里的「类型纪律坏味道」—— 显式 `any` 注解、类型强转、绕过类型检查的指令注释、双重强转，给出 0–100 健康分，可直接挂进 CI 当类型纪律门禁。

> 一句话：代码里 `any` 泛滥、随手 `as any`、`@ts-ignore` 一盖了之 —— 这些悄悄掏空类型系统的习惯，typedoctor 一条命令扫出来。

零依赖单文件（仅 Node 内置模块），开箱即用，不联网、不执行你的代码。

## 为什么需要它

- `tsc` 是编译器，慢且报「能否编译」，不报「类型纪律密度」—— 一个 5000 行的文件塞 200 个 `any`，tsc 不报错但类型系统名存实亡。
- `@typescript-eslint/no-explicit-any` 需要装 ESLint + 写配置，团队没配就完全失察。
- typedoctor 只做一件事：静态体检「类型纪律密度」并给健康分 + CI 门禁。把它接进 pre-commit / CI，能在「类型腐败」扩散前拦住。

## 安装 / 使用

```bash
# 直接跑（无需安装，需 Node 18+）
node typedoctor.js

# 或全局软链
npm link   # 之后 typedoctor

# 指定目录
typedoctor --root ./packages/core
```

## 检测维度

| 规则 id | 严重度 | 含义 |
| --- | --- | --- |
| `explicit-any` | 中危 | `: any` / 泛型 `<any>` 等显式 any 类型注解（类型系统洞） |
| `any-cast` | 高危 | `as any` / `as readonly any` 类型强转（直接抹掉类型检查） |
| `ts-ignore-comment` | 高危 | `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` 绕过类型检查指令 |
| `double-cast` | 中危 | `as unknown as` 双重强转（绕过类型保护） |

> 说明：`.vue` / `.svelte` 仅扫描 `<script>` 块（避免模板 `:prop` 绑定误判）；`.tsx` / `.jsx` 里 `<any>` 是 JSX 元素而非泛型，自动跳过 `<any>` 泛型检测（仅报 `: any`）；`.d.ts` 声明文件里 `any` 本就合法，整体跳过。

## 健康分

满分 100。每千行容忍 6 个问题当量（= 12 加权分，高危×3 / 中危×2），超出部分按加权扣分（每超 1 加权分 −3），封底 0。即小文件几个 `any` 不扣分，大文件 `any` 泛滥则健康分骤降。

## CI 门禁

```bash
# 任意高危（as any / ts-ignore）即失败（exit 1）
typedoctor --fail-on-high

# 精细控制
typedoctor --max-high 0 --max-medium 3 --max-any 10 --max-issues 15 --min-score 85

# 流水线解析（JSON 输出）
typedoctor --json
```

退出码：`0` 通过，`1` 门禁失败，`2` 参数/路径错误。

## 与 family 的关系

typedoctor 是「代码健康 family」的**源码层第九轴·类型健康**，与以下工具拼成完整体检矩阵：

- **devdoctor** — 依赖/许可证/密钥/环检测体检
- **testlite** — 测试卫生体检
- **debtlens** — 技术债密度扫描
- **a11ydoctor** — Web a11y 静态扫描
- **awaitscan** — 异步性能反模式扫描
- **cycscan** — 结构复杂度扫描
- **secscan** — 安全反模式扫描
- **dupscan** — 重复代码检测
- **typedoctor** — 类型纪律健康（本工具）

git 层四件套（repodoctor / docdoctor / commitdoctor / reldoctor）覆盖仓库/文档/提交/发布治理。

## 设计纪律

- 零依赖：仅 Node 内置 `fs` / `path`，不引入任何 npm 包。
- 安全：只读文件系统，不联网、不执行你的代码。
- 健壮：自动跳过 `node_modules` / `.git` / `dist` 等目录、`.d.ts` 声明文件、5MB 以上大文件；非 git 目录/坏 JSON 一律降级不崩溃。
- 降误报：逐字符 tokenizer 剥离注释与字符串（正则字面量感知），`.vue`/`.svelte` 仅萃取 `<script>` 块，`.tsx`/`.jsx` 跳过 `<any>` JSX 误判。
- 门禁防呆：所有阈值参数经 `Number.isFinite` 校验，非整数直接 `exit 2`，不会静默放行。

## License

MIT

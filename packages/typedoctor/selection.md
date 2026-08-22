# typodoctor · 选题终裁（Overlord 单项目深耕 · 2026-08-15）

## 背景
reldoctor 已上架成熟（family 第十二轴：git 层发布一致性）。`next_action: select`，本轮重新选题。
候选池落选萃取现状：
- nono（沙箱）/ Book-to-Skill（PDF管道）/ formlite（Web表单）/ Jay（TUI导航）—— 全部偏离零依赖单文件基线，Jay 还带 TUI 库依赖违背零依赖铁律。
- perfscan → 已复活为 awaitscan（第六轴）；其余无可用单一切口。

依 core-memory 第 140/142 条裁定「零依赖切口枯竭 → 转质量深化 / 家族叙事」，且 git 层治理四件套（repodoctor/docdoctor/commitdoctor/reldoctor）已封顶。横向切口枯竭后，须在**源码层补齐尚未覆盖的坏味道维度**——family 源码层八件套（依赖/测试/债务/a11y/异步性能/结构/安全/重复）独缺「类型纪律」这一 SonarQube 级核心维度。

## 五人格四维硬门槛评估（主代理亲做 · 第9条稳健化）
- **PG（简约/开发者体验）**：任何 TS 项目都被 `any` 悄悄掏空类型系统，`as any` 强转是"假装类型安全"的反模式。零配置开箱扫类型纪律，符合 local-first / zero-config 共识。四问：大受众✓ 实用✓ 差异化✓ 可一个上午确定性交付✓。
- **张雪峰（就业/工程落地）**：面试与代码评审里 `any` 泛滥是高频扣分项；CI 里卡 `any` 密度是真实工程需求，不是玩具。四问全过。
- **Naval（杠杆/差异化）**：tsc 慢且报"能否编译"而非"类型纪律密度"；@typescript-eslint/no-explicit-any 需装+配置。零依赖单文件静态体检 any 密度 + 健康分，挑"巨头嫌小、OSS 嫌重"的缝隙。四问全过。
- **乔布斯（体验/单点极致）**：聚焦"类型漏洞"单一切片，不做全功能类型检查器，与 family 同源整合叙事。四问全过。
- **马斯克（终裁）**：受众极大（TS 已成前端/Node 主流）、实用性高（防类型系统被掏空 + CI 门禁）、差异化明确（零依赖开箱 vs tsc 慢 / ESLint 需配置）。**终裁通过，采纳 typedoctor 作为本轮新项目。**

## 三维硬标准过检（终审）
1. **受众（大）**：所有 TypeScript / TS 项目的 `any` 泛滥是普适、高频、被反复吐槽的类型坏味道，受众面等于 TS 用户总量（极大）。
2. **实用性（高）**：零依赖开箱即扫 4 类类型漏洞（显式 any / any 强转 / ts-ignore 绕过 / 双重强转）+ 严重度加权密度健康分 + CI 门禁，可直接进 pre-commit / CI 卡 `any` 密度。
3. **差异化（更好）**：tsc 是编译器（慢、报类型错误而非密度纪律）；@typescript-eslint/no-explicit-any 需 ESLint 配置+装；ts-prune 查死类型。我们零依赖单文件静态体检「类型纪律密度」+ 健康分 + CI 门禁，确定性可复现、开箱即跑。

## 决策
选定 **typodoctor** —— 零依赖单文件 Node CLI，补 family 第十三轴「类型健康」：
- **T1 explicit-any（medium）**：`: any` / 泛型 `<any>` 等显式 any 类型注解（类型系统洞）。
- **T2 any-cast（high）**：`as any` / `as readonly any` 类型强转（直接抹掉类型检查）。
- **T3 ts-ignore-comment（high）**：`@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` 绕过类型检查指令。
- **T4 double-cast（medium）**：`as unknown as` 双重强转（绕过类型保护）。

与 devdoctor/testlite/debtlens/a11ydoctor/awaitscan/cycscan/secscan/dupscan（源码层八件套）+ repodoctor/docdoctor/commitdoctor/reldoctor（git 层四件套）拼成「源码层九轴 + git 层四件套」完整体检矩阵。

## 方法继承（family 沉淀复用）
- 逐字符 tokenizer 剥离注释/字符串（保留换行）—— 来自 awaitscan 方法沉淀，解决 dogfood 自我污染。
- .vue/.svelte 仅萃取 `<script>` 块扫描，避免 template `:prop` 绑定误判为类型注解 —— 新增强化。
- CLI 门禁阈值一律 `Number.isFinite` 校验（非整数 exit 2）—— 来自 chaineye 方法沉淀。
- 三类标志分离（NUM_FLAGS / STR_FLAGS / BOOL_FLAGS）—— 来自 cycscan 方法沉淀。
- 5MB 大文件跳过防 OOM、root statSync 先验目录 —— family 标配。

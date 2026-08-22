# a11ydoctor 魔王轮转记录（双文档留痕）

## Round 1 · 2026-08-14 19:30（主代理亲做六视角，按第 9 条稳健化降级）

### 真实体验（命令链路 + 边界，CLI 无 GUI 故不截图）
- 坏样本（故意违规 HTML）：识别 12 问题（高2/中6/低4），健康分 0/100，`--fail-on high` 下 exit 1（门禁生效）。
- 好样本（合规 HTML）：0 问题，健康分 100/100，exit 0。
- dogfood 自身仓库 `node index.js .`：0 文件被扫（仓库无 html/jsx），无自我污染、健康分 100。
- 边界：`-V`/`-h` 正常；`--max abc` → 参数错误 exit 2；不存在路径 → exit 2；`--json` 结构化输出正常。

### 六视角红点收敛
| 视角 | 严重度 | 红点 | 处置 |
|---|---|---|---|
| accessibility | 中 | 漏检 `<input type="image">` 缺 alt（图片提交按钮无障碍名） | 修：type=image 走 img-alt(high)，且不再误报 label-association |
| designer | 低 | 输出未按严重度排序，优先修复不直观 | 修：sortIssues 按 high→medium→low 排序（默认 + --json 一致） |
| performance | 低 | 深层 table 子树 O(n²) 理论退化 | 已知局限，记 README，不修 |
| senior-dev | 中 | 规则表驱动化重构以提升扩展性 | 可选扩展，本轮不强行重构（单文件已工作），记方法沉淀 |

### 改进清单归零
2 个真实红点一轮修复 + 32 单测全绿 + 坏/好样本/dogfood/边界复检通过。

### 质量门禁
语法零错 / 32 单测全绿 / 零依赖无密钥无网络 / 5MB 跳过防 OOM / 跨平台(Windows Node22) / 安全(只读不联网) 全绿。

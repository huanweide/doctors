# devdoctor

> 零依赖单文件 Node CLI · 四维项目体检中心

把分散在多个工具里的"项目健康体检"凝成一把尺子：**依赖胖瘦、许可证合规、依赖环、明文密钥**，一个命令全检，纯本地、离线、零依赖、单文件、跨平台，可直接进 CI 门禁。

## 为什么是 devdoctor

- **组合叙事，而非新量**：safeguard / idiot-index / recall-cli / pagext / chaineye / licguard 都是单点零依赖工具。devdoctor 把它们里"体检类"的能力（bloat 来自 idiot-index 思路、license 来自 licguard、cycles 来自 chaineye）和一个新增的 secrets 扫描，整合进一个入口——**不用分别装四个工具，一把尺子量完**。
- **比竞品好或市场压根无**：snyk / depcheck / license-checker 各自独立、多数要 `npm install`。devdoctor 零依赖单文件，离线即可跑，四维合一。
- **大受众**：每个 JS/TS 开发者都有 `node_modules` 和 `.env`，四维体检人人用得上。

## 安装 / 运行

零依赖，无需 `npm install`：

```bash
# 直接跑
node index.js doctor

# 或全局链接后当命令用
npm link
devdoctor doctor
```

要求 Node ≥ 14。

## 子命令

| 命令 | 作用 | 关键门禁 |
|---|---|---|
| `devdoctor bloat [dir]` | 依赖胖瘦：node_modules 体积、最大包、可原生替代候选 | `--max-mb N` `--max-redundant N` |
| `devdoctor license [dir]` | 许可证合规：SPDX 分类（宽松/弱传染/强传染/未知） | `--fail-on unknown\|weak\|strong` `--max N` |
| `devdoctor cycles [dir]` | 依赖环：JS/TS 相对导入构建 DAG，迭代 DFS 防栈溢出 | `--fail-on-cycle` `--max-cycles N` |
| `devdoctor secrets [dir]` | 明文密钥：.env 与源码里 AWS/私钥/Token/JWT 等 | `--fail-on-secret` `--max N` |
| `devdoctor doctor [dir]` | 一键全检 + 综合健康分 | — |
| `devdoctor help` | 帮助 | — |

`dir` 缺省为当前目录。

## 示例

```bash
# 全检当前项目
node index.js doctor

# CI 里：许可证不得含强传染、不得有明文密钥、不得有依赖环
node index.js license --fail-on strong
node index.js secrets --fail-on-secret
node index.js cycles  --fail-on-cycle

# 限制 node_modules 体积
node index.js bloat --max-mb 200
```

## 设计铁律（质量基线）

- **纯本地、零依赖、离线、单文件**：只用 Node 内置 `fs` / `path`，无任何 npm 包。
- **门禁防呆**：所有数值阈值一律 `Number.isFinite` 校验，非整数直接 `exit 2`，绝不静默放行（避免 `count > NaN` 恒 false 让门禁形同虚设）。
- **路径先验**：root 必须 `statSync` 存在且为目录，错误路径不谎报"通过"。
- **稳健解析**：坏 JSON 静默跳过不崩；大文件（>5MB）跳过避免 OOM；LGPL 先于 GPL 匹配，避免弱传染被误判为强传染。
- **环检测**：显式栈迭代 DFS（三色标记），大仓库不栈溢出。

## 与 family 工具的关系

devdoctor 是已有零依赖 family 的"体检整合版"。它不替代 recall-cli（终端补全）/ pagext（网页提取）等非体检工具，而是把体检类能力收口成一个入口。

## License

MIT

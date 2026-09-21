# doctors · 代码健康体检全家桶

八个零依赖、单文件、可离线运行的 Node CLI，覆盖软件开发全链路的「健康体检 + 严重度 + 0-100 健康分 + CI 门禁」。原本是八个独立小仓库，现统一收进这个 monorepo，共享一个入口 `doctors` 与各包的独立 `npx` 调用。

> 设计铁律：纯 Node 标准库、零依赖、零配置、可离线、确定性可复现。每个 doctor 都不联网、不执行你的代码、不读你的密钥，只做只读静态分析。

## 全家桶一览

| 子命令 | 包名 | 体检对象 |
| --- | --- | --- |
| `a11y`  | a11ydoctor  | Web 可访问性（HTML/JSX/Vue/Svelte 语义 a11y 反模式） |
| `commit`| commitdoctor | git 提交消息规范坏味道 |
| `dev`   | devdoctor    | 四维项目体检：依赖胖瘦 / license / 依赖环 / 明文密钥 |
| `doc`   | docdoctor    | Markdown 文档：死链/锚点/跳级/缺 alt/裸 URL |
| `pkg`   | pkgdoctor    | package.json 元数据与依赖声明卫生 |
| `rel`   | reldoctor    | 发布卫生：version / git tag / CHANGELOG 三者一致性 |
| `repo`  | repodoctor   | Git 仓库卫生：危险文件/密钥泄露/大文件/LICENSE/README |
| `type`  | typedoctor   | 类型纪律：explicit-any / any-cast / ts-ignore / double-cast |

## 互补关系图

```
代码质量治理分层
├─ 仓库层（git）
│   ├─ repodoctor   仓库工程卫生（危险文件/大文件/LICENSE/README/锁文件/无意义提交）
│   ├─ commitdoctor 提交消息格式规范
│   └─ reldoctor    发布三件套一致性（version/tag/CHANGELOG）
├─ 依赖层
│   ├─ devdoctor    依赖胖瘦 + license + cycles + 明文密钥（运行/源码态）
│   └─ pkgdoctor    package.json 声明规范
├─ 类型层
│   └─ typedoctor   类型纪律（any 密度）
├─ 文档层
│   └─ docdoctor    Markdown 文档健康
└─ 前端层
    └─ a11ydoctor   Web 可访问性（HTML/JSX/Vue/Svelte）
```

## 安装

```bash
# 作为全家桶使用
git clone https://github.com/huanweide/doctors.git
cd doctors
node cli.js --help
```

或单独使用某个 doctor（各包仍可独立 `npx`）：

```bash
npx a11ydoctor ./src
npx repodoctor .
npx typedoctor ./lib --json
```

## 用法

统一入口 `doctors <subcommand> [args...]`，参数原样转发给对应 doctor：

```bash
doctors a11y   ./src/index.jsx
doctors commit .
doctors dev    doctor .   # dev 需先选子模式：bloat | license | cycles | secrets | doctor
doctors doc    ./docs
doctors pkg    .
doctors rel    .          # 也支持 --root <dir>
doctors repo   .
doctors type   ./lib --json   # 也支持 --root <dir>
```

> 所有子命令默认扫描「当前目录」，可传一个位置参数指定目录（如 `doctors repo ../my-project`）。

每个子命令支持的参数（如 `--json`、`--fail-on-high`、`--max-issues`）与其独立仓库完全一致，详见各包 `packages/<name>/README.md`。

## 开发

```bash
# 跑全部 doctor 自检
node scripts/run-all-tests.js
# 或
npm test
```

## 目录结构

```
doctors/
├── cli.js                    # 统一入口调度器
├── scripts/run-all-tests.js  # 聚合自检
├── packages/
│   ├── a11ydoctor/
│   ├── commitdoctor/
│   ├── devdoctor/
│   ├── docdoctor/
│   ├── pkgdoctor/
│   ├── reldoctor/
│   ├── repodoctor/
│   └── typedoctor/
└── .github/workflows/ci.yml  # 多 Node 版本 CI 门禁
```

## License

MIT · © huanweide

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度；若存在不达标项会以非 0 退出码结束，从而拦下问题提交（具体参数见上方「快速开始」）。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/doctors) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

详见 [LICENSE](LICENSE)。

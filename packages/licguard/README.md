<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/licguard)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/licguard)](https://github.com/huanweide/licguard/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# licguard

零依赖 Node CLI：扫描依赖许可证，识别 **GPL/AGPL 强copyleft** 与未知许可，可进 CI 做合规门禁。

## 为什么需要它

你 `npm install` 一键装下的几百个包，可能藏着一颗 **GPL/AGPL 地雷**——一旦你的项目被判定为衍生作品，可能被迫开源全部源码。`licguard` 把「我的项目有几个传染型许可证」变成一行命令、一张彩色表，像 [`idiot-index`](https://github.com/huanweide/idiot-index) 称依赖胖瘦那样，称一称依赖的「法律体重」。

## 安装

```bash
git clone https://github.com/huanweide/licguard
cd licguard
node index.js .          # 零依赖：无需 npm install 任何东西
```

## 用法

```bash
node index.js .                     # 扫描当前项目依赖，彩色表格
node index.js . --json                # JSON 输出，给 CI 解析
node index.js . --fail-on strong      # 发现任何 GPL/AGPL 直接 exit 2（CI 门禁）
node index.js . --max 0               # 零容忍任何高危 / 未知许可
node index.js . --no-color            # 关颜色，管道友好
node index.js . --allow-missing       # 允许「声明了但未安装」的依赖存在
```

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 扫描基完整，且未命中门禁 |
| 2 | 命中门禁 / 参数错误 / 目标目录不可用 |
| 3 | **扫描基不完整**：根 `package.json` 声明了依赖，但没安装，无法给出可信结论 |

## ⚠️ 为什么会有退出码 3

老版本只扫 `node_modules`。在 CI 的干净 clone 里，`node_modules` 根本不存在，于是它扫到 **0 个包**、汇总全是 0、**退出码 0** —— 一句响亮的「合规通过」，实际上什么都没检查。

现在 `licguard` 会同时读根 `package.json` 的四个依赖字段：

```
dependencies / devDependencies / optionalDependencies / peerDependencies
```

声明了却没落地的包会被列为 `未安装`，按 `unknown` 计入汇总，并让进程以退出码 3 收场。修法很简单：**先 `npm ci`**，或显式加 `--allow-missing` 表示你接受这个盲区。

`workspace:` / `file:` / `link:` / `git+` / `github:` 这类非 registry 来源不算「未安装」。

## 🧰 同一作者的其他工具

> 作者在做一系列开源效率工具，欢迎顺手点 Star 支持：

- 📚 长篇创作 — AI 小说工坊，本地规则引擎零依赖：[点此访问](https://github.com/huanweide/novel-smith)
- 🎓 网课助手 — 智慧树自动播放/续播/AI 答题：[点此访问](https://github.com/huanweide/zhihuishu-helper)
- 🎬 字幕/视频 — B站字幕一键提取（零 Key 取官方字幕）：[点此访问](https://github.com/huanweide/bili-subtitle-universal)
- 📺 实时字幕 — 直播/会议实时字幕：[点此访问](https://github.com/huanweide/live-subtitle)
- ✂️ 视频摘要 — 长视频一键总结：[点此访问](https://github.com/huanweide/video-brief)
- 🖥️ 总览 — 作者全部开源项目集散：[点此访问](https://github.com/huanweide/family-showcase)
- 🩺 代码健康 — 零依赖多轴静态体检：[点此访问](https://github.com/huanweide/doctors)
## 许可证类别

| 类别 | 含义 | 代表 |
|---|---|---|
| 宽松 permissive | 安全 | MIT / ISC / Apache / BSD |
| 弱传染 weak | 警示 | LGPL / MPL / EPL |
| 强传染 strong | 高危（可能要求整体开源） | GPL / AGPL / EUPL |
| 未知 unknown | 需人工确认 | 无 license / UNLICENSED / 私有 / 声明未安装 |

SPDX 表达式（`MIT OR Apache-2.0`、`(MIT) AND GPL-3.0`）取**最严格** token 分类，合规保守。
LGPL 必须先于 GPL 命中（`LGPL-3.0` 是弱传染，不是强传染），分类器里这条顺序不能颠倒。

## JSON 输出

```json
{
  "scanned": 2,
  "installed": 1,
  "notInstalled": 1,
  "basisComplete": false,
  "summary": { "permissive": 1, "weak": 0, "strong": 0, "unknown": 1 },
  "packages": [ ... ]
}
```

`basisComplete` 就是给CI 判断「这次结论可不可信」的开关。

## CI 集成

```yaml
- run: npm ci                    # 关键：先把依赖装出来
- run: node licguard/index.js . --fail-on strong
```

## 与 idiot-index 的关系

`idiot-index` 查依赖「胖不胖」（冗余 / 过度工程），`licguard` 查依赖「干不干净」（法律传染风险）——合称**依赖体检双子**。

## 开发

```bash
node --test test.js         # 单元测试
node scripts/smoke-cli.js   # 端到端冒烟（真实子进程 + 退出码契约）
```

## License

MIT，详见 [LICENSE](LICENSE)。

## 作者

由 **ReTri · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/licguard) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，纯静态图片、不含任何密钥）。
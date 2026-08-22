# Changelog

## Unreleased

## [1.0.0] - 2026-08-15

- 首版：类型健康体检 CLI
- 检测 4 类类型纪律坏味道（explicit-any / any-cast / ts-ignore-comment / double-cast）
- 0–100 密度健康分 + `--fail-on-high` / `--max-*` / `--min-score` / `--json` CI 门禁
- 零依赖单文件，仅 Node 内置模块，不联网、不执行用户代码
- 降误报：逐字符 tokenizer（正则感知）/ .vue/.svelte 萃取 script / .tsx/.jsx 跳过 JSX `<any>` / 跳过 .d.ts

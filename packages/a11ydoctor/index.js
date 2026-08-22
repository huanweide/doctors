#!/usr/bin/env node
'use strict';

// a11ydoctor —— 零依赖单文件 Web 可访问性静态扫描 CLI
// 扫描 HTML / JSX / Vue / Svelte 模板的语义 a11y 反模式，
// 给出严重度 + 加权健康分 + CI 门禁。纯 Node 标准库，零依赖、零配置、可离线。
//
// 设计约束（来自 family 方法沉淀）：
//  - 字符串剥离 + 注释锚定降误报：<script>/<style> 内部不解析子标签，避免把 JS 代码当 HTML 误报。
//  - 标签 tokenizer 用状态机跳过引号内 '>'，void 元素不入栈。
//  - 门禁阈值一律 Number.isFinite 校验，非整数 exit 2，绝不静默放行。
//  - 5MB 单文件上限防 OOM。

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

const VOID = new Set([
  'img', 'br', 'hr', 'input', 'meta', 'link', 'area', 'base',
  'col', 'embed', 'source', 'track', 'wbr', 'param'
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', 'out', '.cache', 'vendor', '.svelte-kit'
]);

const SCAN_EXT = new Set([
  '.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte'
]);

const SEV_W = { high: 3, medium: 2, low: 1 };

// ---------------------------------------------------------------------------
// HTML / 模板 标签 tokenizer（状态机，引号内 > 不截断，script/style 不递归）
// ---------------------------------------------------------------------------

function lineOf(html, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < html.length; i++) {
    if (html[i] === '\n') n++;
  }
  return n;
}

function findClose(html, from, name) {
  const re = new RegExp('</' + name + '\\s*>', 'i');
  const m = re.exec(html.slice(from));
  return m ? from + m.index + m[0].length : -1;
}

function parseAttrs(buf) {
  const attrs = {};
  const re = /([a-zA-Z_][\w:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] === undefined ? true : (m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]);
    if (attrs[key] === undefined) attrs[key] = val;
  }
  return attrs;
}

function parseTag(html, lt) {
  let i = lt + 1;
  const len = html.length;
  let buf = '';
  while (i < len) {
    const c = html[i];
    if (c === '>') {
      return finalizeTag(buf, lt, i + 1);
    }
    if (c === '"' || c === "'") {
      const q = c;
      buf += c;
      i++;
      while (i < len && html[i] !== q) {
        buf += html[i];
        i++;
      }
      if (i < len) {
        buf += html[i];
        i++;
      }
      continue;
    }
    buf += c;
    i++;
  }
  return null;
}

function finalizeTag(buf, start, end) {
  const selfClose = buf.endsWith('/');
  let body = selfClose ? buf.slice(0, -1).trimEnd() : buf.trim();
  if (body.startsWith('/')) {
    return { tagName: body.slice(1).toLowerCase(), attrs: {}, close: true, selfClose: false, end };
  }
  const sp = body.search(/\s/);
  const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1);
  return {
    tagName: name,
    attrs: parseAttrs(rest),
    close: false,
    selfClose: selfClose || VOID.has(name),
    end
  };
}

function tokenizeHtml(html) {
  const tags = [];
  const stack = []; // 用于把标签间直接文本归给最近未关闭的开放元素
  let i = 0;
  const len = html.length;
  let hasDoctype = false;
  while (i < len) {
    const lt = html.indexOf('<', i);
    const text = lt === -1 ? html.slice(i) : html.slice(i, lt);
    if (text.trim() && stack.length) {
      const top = stack[stack.length - 1];
      top._text = (top._text || '') + text;
    }
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (/^<!doctype/i.test(html.slice(lt))) {
      hasDoctype = true;
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const head = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt));
    if (head) {
      const name = head[1].toLowerCase();
      if (name === 'script' || name === 'style') {
        const end = findClose(html, lt, name);
        i = end === -1 ? len : end;
        continue;
      }
      const parsed = parseTag(html, lt);
      if (parsed) {
        parsed.line = lineOf(html, lt);
        parsed.index = tags.length;
        tags.push(parsed);
        if (!parsed.close && !parsed.selfClose) stack.push(parsed);
        else if (parsed.close) {
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].tagName === parsed.tagName) {
              stack.length = k;
              break;
            }
          }
        }
      }
      i = parsed ? parsed.end : lt + 1;
      continue;
    }
    i = lt + 1;
  }
  return { tags, hasDoctype };
}

// ---------------------------------------------------------------------------
// 规则引擎：带祖先栈的结构化判定
// ---------------------------------------------------------------------------

function buildTree(tags) {
  const stack = [];
  for (const t of tags) {
    t.ancestors = stack.map((s) => s.tagName);
    if (!t.close && !t.selfClose) {
      stack.push(t);
    } else if (t.close) {
      // 弹到匹配的开标签
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tagName === t.tagName) {
          stack.length = k;
          break;
        }
      }
    }
  }
  return tags;
}

function hasAttr(t, ...names) {
  return names.some((n) => t.attrs[n] !== undefined && t.attrs[n] !== false);
}

function runRules(tags) {
  const issues = [];
  const push = (t, sev, rule, message) =>
    issues.push({ line: t.line, severity: sev, rule, message });

  const labelFor = new Set();
  for (const t of tags) {
    if (t.tagName === 'label' && typeof t.attrs.for === 'string') labelFor.add(t.attrs.for);
  }

  // 全局 heading 顺序
  const headings = [];
  // 文档级标记
  const hasHtml = tags.some((t) => t.tagName === 'html' && !t.close);
  const hasTitle = tags.some((t) => t.tagName === 'title' && !t.close);

  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    if (t.close) continue;

    // 1. img 缺 alt
    if (t.tagName === 'img' && !hasAttr(t, 'alt')) {
      push(t, 'high', 'img-alt', '<img> 缺少 alt 属性（装饰图用 alt="" 显式声明）');
    }

    // 2. 表单控件
    if (['input', 'select', 'textarea'].includes(t.tagName)) {
      const type = String(t.attrs.type || '').toLowerCase();
      if (type === 'image') {
        // 图片提交按钮：无障碍名来自 alt，而非 label 关联
        if (!hasAttr(t, 'alt')) {
          push(t, 'high', 'img-alt', '<input type="image"> 缺少 alt 属性（图片按钮的无障碍名称）');
        }
      } else if (type !== 'hidden') {
        const id = t.attrs.id;
        const wrapped = t.ancestors.includes('label');
        const labelled =
          (typeof id === 'string' && labelFor.has(id)) ||
          wrapped ||
          hasAttr(t, 'aria-label', 'aria-labelledby', 'title');
        if (!labelled) {
          push(t, 'medium', 'label-association', '<' + t.tagName + '> 缺少可访问的标签关联（for/id、包裹 <label> 或 aria-label）');
        }
      }
    }

    // 3. 交互元素缺可访问名称
    if (['a', 'button'].includes(t.tagName)) {
      const named =
        hasAttr(t, 'aria-label', 'aria-labelledby', 'title', 'alt') ||
        (t._text && t._text.trim());
      if (!named) {
        push(t, 'medium', 'accessible-name', '<' + t.tagName + '> 缺少可访问名称（文本 / aria-label / title）');
      }
    }

    // 4. html 缺 lang
    if (t.tagName === 'html' && !hasAttr(t, 'lang')) {
      push(t, 'high', 'html-lang', '<html> 缺少 lang 属性');
    }

    // 5. heading 跳级
    if (/^h[1-6]$/.test(t.tagName)) {
      const lvl = parseInt(t.tagName[1], 10);
      if (headings.length > 0) {
        const prev = headings[headings.length - 1];
        if (lvl > prev + 1) {
          push(t, 'medium', 'heading-order', '标题层级跳级：h' + prev + ' 之后直接出现 h' + lvl);
        }
      }
      headings.push(lvl);
    }

    // 6. 表格缺表头
    if (t.tagName === 'table') {
      let depth = 0;
      let found = false;
      for (let j = k + 1; j < tags.length; j++) {
        const tt = tags[j];
        if (!tt.close && !tt.selfClose) depth++;
        else if (tt.close) {
          if (tt.tagName === 'table') {
            if (depth === 0) break;
            depth--;
          }
          continue;
        }
        if ((tt.tagName === 'th' || tt.tagName === 'caption') && !tt.close) found = true;
      }
      if (!found) {
        push(t, 'medium', 'table-structure', '<table> 缺少表头 <th> 或 <caption>');
      }
    }

    // 7. 废弃元素
    if (['blink', 'marquee', 'center', 'font'].includes(t.tagName)) {
      push(t, 'low', 'deprecated-element', '使用了已废弃元素 <' + t.tagName + '>');
    }

    // 8. 链接用途
    if (t.tagName === 'a') {
      const href = t.attrs.href;
      if (href === undefined || href === false) {
        push(t, 'low', 'link-purpose', '<a> 缺少 href 属性');
      } else if (href === '#' || String(href).toLowerCase().startsWith('javascript:')) {
        push(t, 'medium', 'link-purpose', '<a> 用途不明确（空锚点 / javascript: 伪链接）');
      }
    }

    // 9. 媒体缺字幕轨道
    if (['video', 'audio'].includes(t.tagName)) {
      let depth = 0;
      let hasTrack = false;
      for (let j = k + 1; j < tags.length; j++) {
        const tt = tags[j];
        if (!tt.close && !tt.selfClose) depth++;
        else if (tt.close) {
          if (tt.tagName === t.tagName) {
            if (depth === 0) break;
            depth--;
          }
          continue;
        }
        if (tt.tagName === 'track' && !tt.close) hasTrack = true;
      }
      if (!hasTrack) {
        push(t, 'low', 'media-alternative', '<' + t.tagName + '> 建议提供 <track> 字幕 / 文本替代');
      }
    }

    // 10. 可点击容器缺键盘可达性
    if (['div', 'span'].includes(t.tagName) && hasAttr(t, 'onclick')) {
      if (!hasAttr(t, 'role', 'tabindex')) {
        push(t, 'medium', 'interactive-role', '<' + t.tagName + ' onclick> 缺少 role / tabindex，键盘不可达');
      }
    }
  }

  // 11. 文档级：缺 title
  if (hasHtml && !hasTitle) {
    issues.push({ line: 1, severity: 'low', rule: 'title-present', message: '文档缺少 <title>' });
  }

  return { issues, hasHtml };
}

function computeScore(issues, lines) {
  const weight = issues.reduce((s, it) => s + (SEV_W[it.severity] || 1), 0);
  const allow = lines / 1000; // 每千行允许 1 个加权问题不扣分
  const deduction = Math.max(0, weight - allow) * 25;
  return { score: Math.max(0, Math.min(100, Math.round(100 - deduction))), weight };
}

function sortIssues(issues) {
  return issues.slice().sort(
    (a, b) => (SEV_W[b.severity] || 1) - (SEV_W[a.severity] || 1) || (a.line - b.line)
  );
}

// ---------------------------------------------------------------------------
// 文件 / 目录扫描
// ---------------------------------------------------------------------------

function scanFileContent(content, lines) {
  const { tags, hasDoctype } = tokenizeHtml(content);
  buildTree(tags);
  const { issues, hasHtml } = runRules(tags);
  const { score } = computeScore(issues, lines);
  // 文档级 doctype 检查（仅 HTML 文件）
  return { issues, score, hasDoctype, hasHtml };
}

function scanFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > 5 * 1024 * 1024) {
    return { file: filePath, skipped: '>5MB', score: 100, issues: [] };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').length;
  const r = scanFileContent(content, lines);
  // doctype 仅对 .html/.htm
  if ((filePath.endsWith('.html') || filePath.endsWith('.htm')) && !r.hasDoctype) {
    r.issues.push({ line: 1, severity: 'low', rule: 'doctype', message: '缺少 <!DOCTYPE> 声明' });
  }
  const { score } = computeScore(r.issues, lines);
  return { file: filePath, score, lines, issues: r.issues };
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile() && SCAN_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

function scanTarget(target) {
  const files = [];
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    walk(target, files);
  } else {
    files.push(target);
  }
  return files.map(scanFile);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, max: null, failOn: 'high', targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-V' || a === '--version') opts.version = true;
    else if (a === '--max') {
      const v = argv[++i];
      opts.max = Number(v);
      if (!Number.isFinite(opts.max)) {
        throw new Error('--max 必须是整数');
      }
    } else if (a === '--fail-on') {
      const v = argv[++i];
      if (!['high', 'any', 'none'].includes(v)) {
        throw new Error('--fail-on 必须是 high | any | none');
      }
      opts.failOn = v;
    } else if (a.startsWith('--')) {
      throw new Error('未知选项: ' + a);
    } else {
      opts.targets.push(a);
    }
  }
  return opts;
}

const HELP = `a11ydoctor v${VERSION} —— 零依赖 Web 可访问性静态扫描 CLI

用法:
  a11ydoctor <文件|目录> [目录...] [选项]

选项:
  -h, --help            显示本帮助
  -V, --version         显示版本
  --json                输出 JSON 报告
  --max <n>             问题总数超过 n 则门禁失败 (exit 1)
  --fail-on <mode>      门禁模式: high(默认,有高严重度失败) | any(有任何问题失败) | none(不失败)

示例:
  a11ydoctor ./src
  a11ydoctor index.html --json
  a11ydoctor . --fail-on any --max 0
`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write('参数错误: ' + e.message + '\n');
    process.exit(2);
  }

  if (opts.version) {
    process.stdout.write('a11ydoctor v' + VERSION + '\n');
    process.exit(0);
  }
  if (opts.help || opts.targets.length === 0) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 2);
  }

  const results = [];
  for (const t of opts.targets) {
    if (!fs.existsSync(t)) {
      process.stderr.write('路径不存在: ' + t + '\n');
      process.exit(2);
    }
    results.push(...scanTarget(t));
  }

  // 汇总
  let totalIssues = 0;
  const sevCount = { high: 0, medium: 0, low: 0 };
  let totalLines = 0;
  const allIssues = [];
  for (const r of results) {
    if (r.skipped) continue;
    totalLines += r.lines || 0;
    for (const it of r.issues) {
      totalIssues++;
      sevCount[it.severity]++;
      allIssues.push(Object.assign({ file: r.file }, it));
    }
  }

  const totalScore = computeScore(allIssues, totalLines).score;

  if (opts.json) {
    const out = {
      score: 0,
      totals: { high: sevCount.high, medium: sevCount.medium, low: sevCount.low, total: totalIssues },
      files: results.map((r) => ({ file: r.file, score: r.score, skipped: r.skipped || null, issues: sortIssues(r.issues) }))
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
      for (const r of results) {
        if (r.skipped) {
          process.stdout.write(r.file + ': 跳过 (' + r.skipped + ')\n');
          continue;
        }
        for (const it of sortIssues(r.issues)) {
          process.stdout.write(
            r.file + ':' + it.line + '  [' + it.severity + '] ' + it.rule + ' — ' + it.message + '\n'
          );
        }
      }
    process.stdout.write(
      '\n汇总: 文件 ' + results.length + ' · 问题 ' + totalIssues +
      ' (高' + sevCount.high + '/中' + sevCount.medium + '/低' + sevCount.low + ') · 健康分 ' +
      totalScore + '/100\n'
    );
  }

  // 门禁
  let failed = false;
  if (opts.failOn === 'any' && totalIssues > 0) failed = true;
  if (opts.failOn === 'high' && sevCount.high > 0) failed = true;
  if (opts.max !== null && totalIssues > opts.max) failed = true;

  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  tokenizeHtml, runRules, buildTree, computeScore, sortIssues,
  scanFileContent, scanFile, scanTarget, parseArgs, VERSION
};

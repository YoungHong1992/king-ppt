// 内容大纲归一化（阶段1：Markdown 内容底稿）。仿 src/normalize.js 的「单一漏斗、永不抛错」范式：
// Agent 推来的大纲文本一律经此清洗，浏览器渲染与后续出片阶段消费同一份归一结果。
// 大纲是不可信输入（可能内嵌 HTML），故复用 src/svg-sanitize.js 的 removeTag 做入站清洗，
// 前端渲染器（web/src/md.js）再对一切文本 HTML 转义——两道防线。
const { removeTag } = require('./svg-sanitize');

// 与 svg-sanitize 一致：整棵子树连内容删除（脚本 / 样式 / 外部内容 / 元信息）
const STRIP_SUBTREE = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'];

const MAX_COMMENTS = 200;   // 单批批注上限
const MAX_FIELD = 2000;     // quote / comment 单字段长度上限
const MAX_TITLE = 200;      // 标题长度上限

// 把 Markdown 当不可信文本清洗：删危险子树 → 事件钩子 → javascript: → 原生 HTML 外链
function sanitizeMarkdown(md) {
  let s = String(md || '');
  for (const tag of STRIP_SUBTREE) s = removeTag(s, tag);
  return s
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') // 内嵌 HTML 的事件属性 onX=
    .replace(/javascript\s*:/gi, '');                          // javascript: 伪协议
  // 注：不动 Markdown 链接语法 [x](url)——渲染器不发 <a>/<img>，注入向量已从根断掉。
}

// 从多种形状里取出 Markdown 字符串（裸字符串 / {markdown} / {outline}）
function pickMarkdown(raw) {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.markdown === 'string') return raw.markdown;
  if (typeof raw.outline === 'string') return raw.outline;
  return null;
}

// 从首个一级标题提取文档标题；无则空串
function deriveTitle(md) {
  const m = String(md || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, MAX_TITLE) : '';
}

// 批注锚点匹配用：把 Markdown「渲染成纯文本」的近似——剥掉行内/块级语法标记与列表/引用前缀，
// 折叠空白。因为浏览器里用户划选的是「渲染后可见文本」(sel.toString())，其中不含 ** / ` / - / > /
// 换行等标记；而权威 doc 是原始 Markdown。若直接用 doc.includes(quote)，凡跨行内格式(如整条
// `- **术语**：说明`)或跨块的选区都不是原文子串，会被误判失效而静默丢弃。故两边都归一后再比对。
function toPlainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')       // 代码块整体移除
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // 行首：标题/引用/列表标记
    .replace(/(\*\*|__)(.*?)\1/g, '$2')    // 加粗
    .replace(/(\*|_)(.*?)\1/g, '$2')       // 斜体
    .replace(/`([^`]+)`/g, '$1')           // 行内代码
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片 → 文字
    .replace(/\s+/g, ' ')                   // 折叠所有空白（含换行）
    .trim();
}

// 高层入口：清洗 → 归一换行 → 取标题。永不抛错；无法解析回退空文档。
function normalizeOutline(raw) {
  try {
    const picked = pickMarkdown(raw);
    if (picked == null) return { type: 'outline', markdown: '', title: '' };
    const markdown = sanitizeMarkdown(picked).replace(/\r\n?/g, '\n');
    const obj = raw && typeof raw === 'object' ? raw : {};
    const title = (typeof obj.title === 'string' && obj.title.trim())
      ? obj.title.trim().slice(0, MAX_TITLE)
      : deriveTitle(markdown);
    return { type: 'outline', markdown, title };
  } catch {
    return { type: 'outline', markdown: '', title: '' };
  }
}

// 入站批注批次校验（浏览器 → Agent）。永不抛错：
//  - 剔除 block 非法 / quote 空 / comment 空 的条目
//  - 剔除 quote 在当前权威 doc 中已不存在的「失效批注」（Agent 上一轮改稿后旧引用失效）
//  - 截断超长字段与超量条目
function normalizeComments(rawComments, markdown) {
  const doc = String(markdown || '');
  const docPlain = toPlainText(doc); // 归一后的纯文本，用于兜底匹配跨标记选区
  const list = Array.isArray(rawComments) ? rawComments.slice(0, MAX_COMMENTS) : [];
  const out = [];
  let auto = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const block = Math.floor(Number(c.block));
    const quote = String(c.quote ?? '').trim().slice(0, MAX_FIELD);
    const comment = String(c.comment ?? '').trim().slice(0, MAX_FIELD);
    if (!Number.isFinite(block) || block < 0) continue;
    if (!quote || !comment) continue;
    // 失效引用剔除：先按原文直配（快路径），再按归一纯文本兜底（跨 **/`/列表/换行 的选区）
    if (doc && !doc.includes(quote) && !docPlain.includes(toPlainText(quote))) continue;
    const id = (typeof c.id === 'string' && c.id) ? c.id : `c_${++auto}`;
    out.push({ id, block, quote, comment });
  }
  return out;
}

module.exports = { normalizeOutline, sanitizeMarkdown, normalizeComments, deriveTitle };

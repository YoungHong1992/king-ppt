// 零依赖 Markdown 渲染器（阶段1 内容大纲）。纯函数、不碰 DOM/React，可单测。
// 关键约束：
//  1) 每个顶层块的外层元素带 data-block="{n}"（文档序、0 基）——划词批注据此锚定块序号。
//  2) escapeHtml 先跑，杀掉一切内嵌 HTML；再套自有白名单行内标签。故注入的 <script> 只会显示为文本。
//  3) 只发射 h1-3 / p / ul / ol / li / blockquote / pre / code / strong / em / hr / br，
//     不发 <a>/<img>——从根断掉链接/图片注入向量。
// 支持子集：# ## ### 标题、- * 无序列表、1. 有序列表、> 引用、``` 围栏码、--- 分隔线、
//           **粗体** *斜体* _斜体_ `行内码`、段落（软换行 <br>）。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 行内格式化：输入必须已 escapeHtml。顺序：行内码 → 粗体 → 斜体。
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9])/g, '$1<em>$2</em>');
}

const RE_HEADING = /^(#{1,3})\s+(.*)$/;
const RE_HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_UL = /^\s*[-*]\s+(.*)$/;
const RE_OL = /^\s*\d+\.\s+(.*)$/;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_FENCE = /^```/;

// 分块渲染。返回 HTML 字符串；每个顶层块外层带 data-block 索引。
function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];

    // 空行：跳过（块边界）
    if (!line.trim()) { i++; continue; }

    // 围栏代码块 ``` … ```
    if (RE_FENCE.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++; // 跳过收尾围栏
      blocks.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题 # ## ###
    const h = line.match(RE_HEADING);
    if (h) {
      const level = h[1].length;
      blocks.push(`<h${level}>${inline(escapeHtml(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线 ---
    if (RE_HR.test(line)) { blocks.push('<hr />'); i++; continue; }

    // 引用块 >（连续行合并）
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(inline(escapeHtml(lines[i].match(RE_QUOTE)[1])));
        i++;
      }
      blocks.push(`<blockquote>${buf.join('<br />')}</blockquote>`);
      continue;
    }

    // 无序列表（连续行）
    if (RE_UL.test(line)) {
      const items = [];
      while (i < lines.length && RE_UL.test(lines[i])) {
        items.push(`<li>${inline(escapeHtml(lines[i].match(RE_UL)[1]))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 有序列表（连续行）
    if (RE_OL.test(line)) {
      const items = [];
      while (i < lines.length && RE_OL.test(lines[i])) {
        items.push(`<li>${inline(escapeHtml(lines[i].match(RE_OL)[1]))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 段落：连续非空、非其它块起始的行，软换行合并
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !RE_HEADING.test(lines[i]) && !RE_HR.test(lines[i]) && !RE_QUOTE.test(lines[i]) &&
      !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) && !RE_FENCE.test(lines[i])
    ) {
      para.push(inline(escapeHtml(lines[i].trim())));
      i++;
    }
    blocks.push(`<p>${para.join('<br />')}</p>`);
  }

  // 给每个顶层块的外层标签插入 data-block 索引（选区锚点）
  return blocks
    .map((b, n) => b.replace(/^<(\w+)/, `<$1 data-block="${n}"`))
    .join('\n');
}

export { renderMarkdown, escapeHtml, inline };

// 阶段1：内容大纲生成 + 批注改稿。纯 LLM 逻辑——产出裸 Markdown 字符串；
// 归一（normalizeOutline）与 relay.setDoc 由 server.js 路由做，本模块不碰 relay。
const llm = require('./llm');

// 模块级 in-flight 守卫：大纲生成/改稿都写同一份 doc，禁止并发（双击、重复发批注）。
let inflight = false;
function acquire() {
  if (inflight) { const e = new Error('上一次大纲生成尚未结束，请稍候'); e.code = 'BUSY'; throw e; }
  inflight = true;
}

const SYSTEM = `你是资深演示策划师。产出一份 Markdown 内容大纲，供后续做成 PPT。
硬性要求：
- 只输出 Markdown 正文，不要输出 JSON、不要代码块围栏、不要额外解释。
- 第一行用一级标题「# 」承载演示总标题。
- 每一页用二级标题「## 」承载页面标题；要点用无序列表「- 」或有序列表。
- 金句可用引用「> 」。语言精炼，一页一个核心意思，逻辑连贯。`;

// 首次生成：{ topic, pages?, materials? } → Markdown 字符串
async function generateOutline({ topic, pages = 8, materials } = {}) {
  const t = String(topic || '').trim();
  if (!t) { const e = new Error('请先填写主题'); e.code = 'BAD_INPUT'; throw e; }
  acquire();
  try {
    const user = [
      `主题：${t}`,
      `期望页数：约 ${pages} 页（含封面与结尾页）。`,
      materials ? `参考素材（节选，酌情取用）：\n${String(materials).slice(0, 6000)}` : '',
      '请据此输出完整的 Markdown 大纲。',
    ].filter(Boolean).join('\n');
    return await llm.chat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      { temperature: 0.7 },
    );
  } finally {
    inflight = false;
  }
}

// 批注改稿：{ markdown, comments:[{quote,comment}] } → 修订后的完整 Markdown 字符串
async function reviseOutline({ markdown, comments } = {}) {
  const md = String(markdown || '');
  const list = Array.isArray(comments) ? comments : [];
  if (!md.trim()) { const e = new Error('当前没有可修订的大纲'); e.code = 'BAD_INPUT'; throw e; }
  if (list.length === 0) { const e = new Error('没有批注需要修订'); e.code = 'BAD_INPUT'; throw e; }
  acquire();
  try {
    const notes = list.map((c, i) => `${i + 1}. 针对原文「${c.quote}」：${c.comment}`).join('\n');
    const user = [
      '这是当前的 Markdown 大纲：', '', md, '',
      '用户对其中若干处做了划词批注，请据此修订：', notes, '',
      '要求：只改批注涉及之处，其余保持不变；输出修订后的完整 Markdown（不要 JSON、不要代码块围栏、不要解释）。',
    ].join('\n');
    return await llm.chat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      { temperature: 0.5 },
    );
  } finally {
    inflight = false;
  }
}

module.exports = { generateOutline, reviseOutline };

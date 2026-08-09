// Agent 核心：大纲生成、逐页幻灯片生成、局部修改
const { chat, extractJson } = require('./llm');

const SLIDE_TYPES = `
可用的幻灯片类型（type 字段只能取这四个之一）：
- "title"     封面页，字段: { title, subtitle }
- "section"   章节过渡页，字段: { title, subtitle? }
- "bullets"   要点页，字段: { title, bullets: string[] }（3~6 条，每条不超过 40 字）
- "twoColumn" 两栏对比页，字段: { title, leftTitle, leftBullets: string[], rightTitle, rightBullets: string[] }
`.trim();

// ---------- 大纲 ----------
async function generateOutline({ topic, pages = 8, extra = '' }) {
  const messages = [
    {
      role: 'system',
      content: `你是一名专业的演示文稿策划师。用户会给你主题，你输出一份 PPT 大纲。
只输出 JSON，格式如下（不要输出任何其他文字）：
{
  "title": "演示文稿总标题",
  "pages": [
    { "heading": "本页标题", "intent": "本页要表达的核心内容（一句话）" }
  ]
}
要求：
- 第 1 页固定为封面，最后一页固定为结束/致谢页
- pages 总数为 ${pages} 页
- 逻辑清晰、有叙事结构，避免空话套话`,
    },
    { role: 'user', content: `主题：${topic}${extra ? `\n补充材料/要求：\n${extra}` : ''}` },
  ];
  const raw = await chat(messages, { temperature: 0.7, json: true });
  const outline = extractJson(raw);
  if (!outline.pages || !Array.isArray(outline.pages) || outline.pages.length === 0) {
    throw new Error('大纲格式不正确');
  }
  return outline;
}

// ---------- 单页幻灯片 ----------
async function generateSlide({ outline, index }) {
  const page = outline.pages[index];
  const total = outline.pages.length;
  const messages = [
    {
      role: 'system',
      content: `你是一名专业的 PPT 内容撰写者。根据大纲中某一页的信息，输出该页的幻灯片 JSON。
${SLIDE_TYPES}

规则：
- 第 1 页（index 0）必须用 "title" 类型；最后一页（index ${total - 1}）必须用 "section" 类型作为致谢/结束页
- 其余页根据内容选择 "section"、"bullets" 或 "twoColumn"
- 只输出一个 JSON 对象（该页本身），不要输出其他文字
- 内容要具体、有信息量，避免空洞的口号`,
    },
    {
      role: 'user',
      content: `演示文稿总标题：${outline.title}
当前是第 ${index + 1}/${total} 页（index=${index}）
本页标题：${page.heading}
本页意图：${page.intent}`,
    },
  ];
  const raw = await chat(messages, { temperature: 0.7, json: true });
  const slide = extractJson(raw);
  return validateSlide(slide, index);
}

function validateSlide(slide, index) {
  const valid = ['title', 'section', 'bullets', 'twoColumn'];
  if (!slide || !valid.includes(slide.type)) {
    throw new Error(`第 ${index + 1} 页类型无效: ${slide && slide.type}`);
  }
  slide.index = index;
  return slide;
}

// ---------- 局部修改 ----------
async function reviseSlides({ slides, instruction }) {
  const messages = [
    {
      role: 'system',
      content: `你是一名 PPT 编辑助手。用户会给你一份完整的幻灯片 JSON 数组和一条修改指令。
${SLIDE_TYPES}

规则：
- 只修改指令涉及的页面，其余页面原样保留
- 输出**完整的**幻灯片 JSON 数组（包含所有页，含未修改的），保留每页的 index 字段
- 只输出 JSON 数组，不要输出其他文字`,
    },
    {
      role: 'user',
      content: `当前幻灯片：\n${JSON.stringify(slides, null, 2)}\n\n修改指令：${instruction}`,
    },
  ];
  const raw = await chat(messages, { temperature: 0.5, json: true });
  const result = extractJson(raw);
  const arr = Array.isArray(result) ? result : result.slides;
  if (!Array.isArray(arr)) throw new Error('修改结果格式不正确');
  return arr.map((s, i) => validateSlide(s, s.index ?? i));
}

module.exports = { generateOutline, generateSlide, reviseSlides };

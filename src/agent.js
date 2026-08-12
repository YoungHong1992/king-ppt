// Agent 核心：大纲生成、逐页幻灯片生成、局部修改
const { chat, extractJson } = require('./llm');

const VALID_TYPES = ['title', 'section', 'bullets', 'twoColumn', 'table', 'steps', 'quote', 'stats', 'free'];

const SLIDE_TYPES = `
可用的幻灯片类型（type 字段只能取以下之一）：
- "title"     封面页，字段: { title, subtitle }
- "section"   章节过渡页，字段: { title, subtitle? }
- "bullets"   要点页，字段: { title, bullets: string[] }（3~6 条，每条不超过 40 字）
- "twoColumn" 两栏对比页，字段: { title, leftTitle, leftBullets: string[], rightTitle, rightBullets: string[] }
- "table"     数据表格页，字段: { title, headers: string[], rows: string[][] }（3~5 列，2~6 行，单元格不超过 20 字）
- "steps"     流程步骤页，字段: { title, steps: [{ title, desc }] }（3~5 步，title 不超过 10 字，desc 不超过 30 字）
- "quote"     金句页，字段: { quote, author? }（一句有冲击力的引文，不超过 50 字）
- "stats"     关键数字页，字段: { title, stats: [{ value, label }] }（2~4 个数字，value 要醒目如 "87%"，label 不超过 12 字）
- "free"      自由排版页，字段: { title, html }（用 HTML/CSS 自由设计整页；每份演示主动安排 1~3 页，用于最值得视觉表现的页面，避免整套版式单调）

可选增强字段（有则输出，无则省略）：
- "eyebrow"    封面/章节页的眉题（不超过 12 字，如 "AI 提效 · 实践"）
- "conclusion" 内容页底部总结条的主结论（一句话，不超过 40 字）；搭配可选 "note"（补充说明，不超过 40 字）
- "author"     封面署名（如姓名/团队）

选型指引：有结构化数据/多维对比用 "table"；内容有先后顺序用 "steps"；需要强调一句话用 "quote"；有亮眼数字用 "stats"；核心卖点、重磅数字、创意展示等重点页优先用 "free" 制造视觉亮点（每份 1~3 页）；其余叙述性内容用 "bullets" 或 "twoColumn"。
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

// ---------- 模板字数约束 → prompt 文本 ----------
function constraintsText(constraints) {
  if (!constraints) return '';
  const parts = [];
  if (constraints.pageTitle) parts.push(`页面标题不超过 ${constraints.pageTitle} 字`);
  if (constraints.bullet) parts.push(`要点每条不超过 ${constraints.bullet} 字`);
  if (constraints.cardTitle) parts.push(`栏标题/步骤名不超过 ${constraints.cardTitle} 字`);
  if (constraints.tableCell) parts.push(`表格单元格不超过 ${constraints.tableCell} 字`);
  if (constraints.stepDesc) parts.push(`步骤描述不超过 ${constraints.stepDesc} 字`);
  if (constraints.quote) parts.push(`金句不超过 ${constraints.quote} 字`);
  if (constraints.conclusion) parts.push(`结论句不超过 ${constraints.conclusion} 字`);
  return parts.length ? `\n- 字数限制：${parts.join('；')}` : '';
}

// ---------- free 自由排版页：模板风格令牌 → prompt 文本 ----------
// 从 descriptor 提取 free 页 HTML 生成的风格约束（色板/字体/基调）
function buildFreeStyle(d) {
  const colors = {};
  for (const [role, hex] of Object.entries((d && d.palette) || {})) {
    if (hex) colors[role] = `#${hex}`;
  }
  const fonts = (d && d.typography && d.typography.fonts) || {};
  const fontFaces = [...new Set(
    Object.values(fonts).flatMap((f) => [f && f.latin, f && f.ea]).filter(Boolean),
  )];
  const grammar = (d && d.designGrammar) || {};
  const toneParts = [];
  if (grammar.density) toneParts.push(grammar.density === 'low' ? '低信息密度、大量留白' : '信息密度适中');
  if (grammar.cornerStyle) toneParts.push(grammar.cornerStyle === 'sharp' ? '直角/锐利几何' : '圆角柔和');
  return {
    canvas: { width: 1280, height: 720 },
    colors,
    fontStack: `'${fontFaces[0] || 'Microsoft YaHei'}', 'Microsoft YaHei', sans-serif`,
    tone: toneParts.join('，') || '简洁专业，大量留白，对齐严谨',
  };
}

function freeStyleText(fs) {
  const colorLines = Object.entries(fs.colors || {}).map(([role, hex]) => `${role} ${hex}`).join('；');
  return `
自由排版页（type: "free"）的 html 字段规范：
- 输出完整 HTML 片段：单个根 <div>，固定 ${fs.canvas.width}×${fs.canvas.height} px 画布（宽高写死，overflow:hidden，内部元素用 px 绝对定位或 flex/grid 布局）
- 只能使用以下模板配色（允许加透明度）：${colorLines || '由你选取协调的商务配色'}
- 字体仅限：${fs.fontStack}；不要声明其他 font-family
- 禁止：<script>、<iframe>、<link>、任何外部资源（图片/字体/CDN/URL/@import）、position:fixed、CSS 动画与 transition
- 布局自检：任何装饰元素（色块/圆形/线条）不得遮挡文字；文字必须完整可读，四周留至少 40px 安全边距
- 鼓励：CSS 渐变、几何色块装饰、圆角卡片、大字号数字、emoji 图标、精致的留白与对齐
- 设计基调：${fs.tone}
- 所有样式内联在元素 style 上或放在片段开头的一个 <style> 块内，不要引用外部样式表`.trimStart();
}

// ---------- 单页自愈：类型纠正 + 重试 + 兜底 ----------
// LLM 常见的类型写法偏差 → 标准类型
const TYPE_ALIASES = {
  cover: 'title', '封面': 'title',
  chapter: 'section', closing: 'section', end: 'section', ending: 'section', thanks: 'section', toc: 'section',
  content: 'bullets', list: 'bullets', text: 'bullets', points: 'bullets', bullet: 'bullets',
  'two-column': 'twoColumn', twocolumns: 'twoColumn', columns: 'twoColumn', comparison: 'twoColumn', compare: 'twoColumn',
  grid: 'table',
  step: 'steps', process: 'steps', flow: 'steps', timeline: 'steps', roadmap: 'steps',
  quotation: 'quote', slogan: 'quote', golden: 'quote',
  stat: 'stats', numbers: 'stats', kpi: 'stats', data: 'stats', metrics: 'stats', number: 'stats',
};

function coerceType(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (VALID_TYPES.includes(t)) return t;
  return TYPE_ALIASES[t.toLowerCase()] || null;
}

// 类型缺失/无法识别时，按已输出的字段推断最可能的类型
function inferType(slide) {
  if (Array.isArray(slide.steps)) return 'steps';
  if (Array.isArray(slide.stats)) return 'stats';
  if (Array.isArray(slide.rows) || Array.isArray(slide.headers)) return 'table';
  if (slide.leftBullets || slide.rightBullets) return 'twoColumn';
  if (slide.quote) return 'quote';
  return 'bullets';
}

// 位置契约：首页必须是 title，末页必须是 section；类型不对时只保留标题信息重建
function enforcePosition(slide, index, total) {
  if (index === 0 && slide.type !== 'title') {
    return { type: 'title', title: slide.title || '', subtitle: slide.subtitle || '' };
  }
  if (index === total - 1 && slide.type !== 'section') {
    return { type: 'section', title: slide.title || '谢谢观看', subtitle: slide.subtitle || '' };
  }
  return slide;
}

// 把 LLM 输出清洗成可渲染的幻灯片；无法挽救时返回 null（触发重试）
const KNOWN_KEYS = ['type', 'slideType', 'slide_type', 'layout', 'title', 'subtitle', 'bullets',
  'steps', 'stats', 'rows', 'headers', 'leftBullets', 'rightBullets', 'quote', 'conclusion', 'html'];
function sanitizeSlide(parsed, index, total, page) {
  let s = parsed;
  if (Array.isArray(s)) s = s[0]; // 模型偶尔把单页包成数组
  if (!s || typeof s !== 'object') return null;
  s = { ...s };
  // 一个已知字段都没有的对象视为垃圾输出，交给重试/兜底，不做无依据的脑补
  if (!KNOWN_KEYS.some((k) => s[k] !== undefined)) return null;
  // type 字段的常见别名键
  s.type = s.type ?? s.slideType ?? s.slide_type ?? s.layout;
  // free 自由排版页：html 为必备载荷，缺失交给重试/兜底，不做类型推断
  if (coerceType(s.type) === 'free') {
    if (typeof s.html !== 'string' || !s.html.includes('<')) return null;
    return enforcePosition({ ...s, type: 'free' }, index, total);
  }
  s.type = coerceType(s.type) || inferType(s);
  if (!s.title && page && page.heading) s.title = page.heading;
  if (s.type === 'bullets' && !Array.isArray(s.bullets)) {
    s.bullets = page && page.intent ? [page.intent] : [];
  }
  return enforcePosition(s, index, total);
}

// 重试全部失败后的兜底页：用大纲信息合成，保证整份 deck 不出空洞
function fallbackSlide(index, total, page) {
  const heading = (page && page.heading) || `第 ${index + 1} 页`;
  const intent = (page && page.intent) || '';
  let slide;
  if (index === 0) slide = { type: 'title', title: heading, subtitle: intent };
  else if (index === total - 1) slide = { type: 'section', title: '谢谢观看', subtitle: heading };
  else slide = { type: 'bullets', title: heading, bullets: intent ? [intent] : [] };
  slide._recovered = true;
  return slide;
}

// ---------- 单页幻灯片 ----------
async function generateSlide({ outline, index, constraints, freeStyle }) {
  const page = outline.pages[index];
  const total = outline.pages.length;
  // harness 指定重点展示页（5 页以上的 deck，内容页正中一页），硬性引导 free
  const suggestFree = Boolean(freeStyle) && total >= 5 && index === Math.floor((total - 1) / 2);
  const messages = [
    {
      role: 'system',
      content: `你是一名专业的 PPT 内容撰写者。根据大纲中某一页的信息，输出该页的幻灯片 JSON。
${SLIDE_TYPES}

规则：
- 第 1 页（index 0）必须用 "title" 类型；最后一页（index ${total - 1}）必须用 "section" 类型作为致谢/结束页
- 其余页根据选型指引，从 "section"、"bullets"、"twoColumn"、"table"、"steps"、"quote"、"stats"、"free" 中选择最合适的类型
- 每份演示必须安排 1~3 页 "free" 自由排版页（硬性要求至少 1 页），用于重点展示页制造视觉亮点，避免整套版式单调
- 只输出一个 JSON 对象（该页本身），不要输出其他文字
- 内容要具体、有信息量，避免空洞的口号${constraintsText(constraints)}${freeStyle ? `\n${freeStyleText(freeStyle)}` : ''}`,
    },
    {
      role: 'user',
      content: `演示文稿总标题：${outline.title}
当前是第 ${index + 1}/${total} 页（index=${index}）
本页标题：${page.heading}
本页意图：${page.intent}${suggestFree ? '\n本页是全篇的重点展示页，请使用 "free" 自由排版，按上方 HTML 规范输出有设计感的页面。' : ''}`,
    },
  ];
  // 自愈主循环：清洗成功即返回；失败把原因反馈给模型重试（最多 3 次）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await chat(messages, { temperature: 0.7, json: true });
      const slide = sanitizeSlide(extractJson(raw), index, total, page);
      if (slide) return validateSlide(slide, index);
      throw new Error('输出不是有效的幻灯片 JSON 对象');
    } catch (err) {
      if (attempt === 2) break;
      messages.push({
        role: 'user',
        content: `上次输出不符合要求：${err.message}。请重新输出第 ${index + 1} 页的 JSON：单个对象，type 只能是 ${VALID_TYPES.join(' / ')}，不要输出任何其他文字。`,
      });
    }
  }
  return validateSlide(fallbackSlide(index, total, page), index);
}

function validateSlide(slide, index) {
  if (!slide || !VALID_TYPES.includes(slide.type)) {
    throw new Error(`第 ${index + 1} 页类型无效: ${slide && slide.type}`);
  }
  slide.index = index;
  return slide;
}

// ---------- 局部修改 ----------
async function reviseSlides({ slides, instruction, constraints }) {
  const messages = [
    {
      role: 'system',
      content: `你是一名 PPT 编辑助手。用户会给你一份完整的幻灯片 JSON 数组和一条修改指令。
${SLIDE_TYPES}

规则：
- 只修改指令涉及的页面，其余页面原样保留
- 输出**完整的**幻灯片 JSON 数组（包含所有页，含未修改的），保留每页的 index 字段
- 只输出 JSON 数组，不要输出其他文字${constraintsText(constraints)}`,
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
  // 自愈：修改结果中损坏的页清洗修复，无法修复的保留原页，不让整条指令失败
  return arr.map((s, i) => {
    const idx = s && typeof s === 'object' && s.index !== undefined ? s.index : i;
    const cleaned = s && typeof s === 'object' ? sanitizeSlide(s, idx, arr.length, null) : null;
    const usable = cleaned || slides[idx] || slides[i];
    if (!usable) throw new Error(`第 ${idx + 1} 页修改结果损坏且无原页可回退`);
    return validateSlide(usable, idx);
  });
}

module.exports = { generateOutline, generateSlide, reviseSlides, buildFreeStyle };

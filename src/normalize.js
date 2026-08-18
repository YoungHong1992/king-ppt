// 幻灯片归一化：把外部（用户 Agent）传入的 slide JSON 清洗成可渲染对象。
// 这些是从旧 agent.js 迁出的纯函数——类型纠正 / 位置契约 / 兜底，
// 不含任何 LLM 调用、不含自愈重试循环（内容质量由用户 Agent 负责）。
const VALID_TYPES = ['title', 'section', 'bullets', 'twoColumn', 'table', 'steps', 'quote', 'stats', 'free'];

// 常见的类型写法偏差 → 标准类型
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

// 位置契约：首页宜为 title、末页宜为 section；结构化类型不对时只保留标题信息重建。
// free 自由排版页豁免——新模型鼓励用 free 做封面/收尾的视觉大页，不得抹掉其 svg 载荷。
function enforcePosition(slide, index, total) {
  if (slide.type === 'free') return slide;
  if (index === 0 && slide.type !== 'title') {
    return { type: 'title', title: slide.title || '', subtitle: slide.subtitle || '' };
  }
  if (index === total - 1 && slide.type !== 'section') {
    return { type: 'section', title: slide.title || '谢谢观看', subtitle: slide.subtitle || '' };
  }
  return slide;
}

// 把传入对象清洗成可渲染的幻灯片；无法挽救时返回 null（交由 normalizeSlide 兜底）
const KNOWN_KEYS = ['type', 'slideType', 'slide_type', 'layout', 'title', 'subtitle', 'bullets',
  'steps', 'stats', 'rows', 'headers', 'leftBullets', 'rightBullets', 'quote', 'conclusion', 'html', 'svg', 'imagePrompt'];
function sanitizeSlide(parsed, index, total, page) {
  let s = parsed;
  if (Array.isArray(s)) s = s[0]; // 偶尔把单页包成数组
  if (!s || typeof s !== 'object') return null;
  s = { ...s };
  // 一个已知字段都没有的对象视为垃圾输入，交给兜底，不做无依据的脑补
  if (!KNOWN_KEYS.some((k) => s[k] !== undefined)) return null;
  // type 字段的常见别名键
  s.type = s.type ?? s.slideType ?? s.slide_type ?? s.layout;
  // free 自由排版页：svg（新）/ html（旧会话兼容）必须有一个
  if (coerceType(s.type) === 'free') {
    const svgOk = typeof s.svg === 'string' && s.svg.includes('<');
    const htmlOk = typeof s.html === 'string' && s.html.includes('<');
    if (!svgOk && !htmlOk) return null;
    return enforcePosition({ ...s, type: 'free', html: htmlOk ? s.html : undefined }, index, total);
  }
  s.type = coerceType(s.type) || inferType(s);
  if (!s.title && page && page.heading) s.title = page.heading;
  if (s.type === 'bullets' && !Array.isArray(s.bullets)) {
    s.bullets = page && page.intent ? [page.intent] : [];
  }
  return enforcePosition(s, index, total);
}

// 兜底页：用大纲信息合成，保证整份 deck 不出空洞（页面损坏时的最后防线）
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

// 高层入口：清洗 → 兜底 → 保证类型合法 + 打上真实页位 index。永不抛错。
function normalizeSlide(raw, index, total, page = null) {
  const cleaned = sanitizeSlide(raw, index, total, page);
  const slide = cleaned || fallbackSlide(index, total, page);
  if (!VALID_TYPES.includes(slide.type)) slide.type = inferType(slide);
  slide.index = index;
  return slide;
}

// 从字符串中容错提取 JSON 对象/数组（迁自 llm.js；CLI 解析 stdin 用）
function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('输入中未找到 JSON');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error('输入的 JSON 不完整');
  return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = {
  VALID_TYPES, TYPE_ALIASES, coerceType, inferType, enforcePosition,
  sanitizeSlide, fallbackSlide, normalizeSlide, extractJson,
};

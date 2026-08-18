// 模板创作契约：把 descriptor 转成用户 Agent 能读懂的「在本模板限制内怎么写内容」规格。
// 这些文本原本注入 agent.js 的 prompt；现在改由 GET /api/templates/:id/spec 暴露，
// 让任意 Agent 拉取后按所选模板的字数/配色/free-SVG 规范生成 slide JSON。
// 静态部分（8 类版式字段）同时写进 SKILL.md 作为长期契约。

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
- "free"      自由排版页，字段: { title, svg }（用 SVG 自由设计整页；每份演示主动安排 1~3 页，用于最值得视觉表现的页面，避免整套版式单调）

可选增强字段（有则输出，无则省略）：
- "eyebrow"    封面/章节页的眉题（不超过 12 字，如 "AI 提效 · 实践"）
- "conclusion" 内容页底部总结条的主结论（一句话，不超过 40 字）；搭配可选 "note"（补充说明，不超过 40 字）
- "author"     封面署名（如姓名/团队）
- "image"      配图载荷（仅 bullets 要点页可选）：先用 POST /api/assets 上传图片拿到 { file, path, url }，整体挂到 slide.image；imageRight 版式会自动用它配图

选型指引：有结构化数据/多维对比用 "table"；内容有先后顺序用 "steps"；需要强调一句话用 "quote"；有亮眼数字用 "stats"；核心卖点、重磅数字、创意展示等重点页优先用 "free" 制造视觉亮点（每份 1~3 页）；其余叙述性内容用 "bullets" 或 "twoColumn"。

位置契约：第 1 页必须是 "title"；最后一页必须是 "section"（致谢/结束页）。
`.trim();

// 模板字数约束 → 人读文本
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
  return parts.length ? `字数限制：${parts.join('；')}` : '';
}

// 从 descriptor 提取 free 页的风格令牌（色板/字体/基调）
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
自由排版页（type: "free"）的 svg 字段规范：
- 输出一个完整的 SVG 字符串：根元素 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">，只输出 SVG 本身（字符串内的引号用 \\" 转义）
- 只允许这些元素：<rect> <circle> <ellipse> <line> <text> <g>（分组仅用于 transform="translate(x,y)"）
- 只能使用以下模板配色（可加 fill-opacity / stroke-opacity 做层次）：${colorLines || '由你选取协调的商务配色'}
- <text> 必须带 x、y、font-size、fill 属性；对齐用 text-anchor="start|middle|end"；换行 = 多个 <text> 元素；不要用 <tspan>
- 禁止：<script>、事件属性、任何外部资源（href/图片/字体）、<defs>、渐变、滤镜、mask、clip-path、CSS 动画
- 布局自检：装饰色块不得遮挡文字（文字元素放在最后）；文字距画布边缘至少 40px；字号不小于 16
- 鼓励：大小色块对比、圆形/线条几何装饰、fill-opacity 半透明叠层、超大号数字、精致的留白与对齐
- 设计基调：${fs.tone}`.trimStart();
}

// GET /api/templates/:id/spec 的完整响应体
function buildSpec(d) {
  const freeStyle = buildFreeStyle(d);
  return {
    templateId: d._id,
    name: d.meta && d.meta.name,
    canvas: d.canvas,
    constraints: (d.constraints && d.constraints.chars) || {},
    typeMapping: d.typeMapping || {},
    palette: d.palette || {},
    slideTypesText: SLIDE_TYPES,
    constraintsText: constraintsText(d.constraints && d.constraints.chars),
    freeStyle,
    freeStyleText: freeStyleText(freeStyle),
  };
}

module.exports = { SLIDE_TYPES, constraintsText, buildFreeStyle, freeStyleText, buildSpec };

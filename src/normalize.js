// 幻灯片归一化（SVG-as-IR 架构）：把用户 Agent 传入的 slide JSON 清洗成「一整页 SVG」。
// 旧的 8 类版式机器（type/scene graph）已退役——现在每页就是一个完整 SVG（viewBox 0 0 1280 720）。
// 复用 src/svg-sanitize.js 的 normalize（清洗脚本/外链 + 补 viewBox），保证预览与导出消费同一份 SVG。
const { normalize: normalizeSvg } = require('./svg-sanitize');

// 页面角色：仅用于目录标注 / 主题原型选择，不影响渲染（渲染完全由 SVG 决定）
const ROLES = ['cover', 'section', 'content', 'closing'];
const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#FFFFFF"/><text x="640" y="360" font-size="28" fill="#999999" text-anchor="middle">空白页</text></svg>';

// 首页倾向 cover、末页倾向 closing，其余 content；显式 role 优先
function coerceRole(raw, index, total) {
  const r = String(raw ?? '').trim().toLowerCase();
  if (ROLES.includes(r)) return r;
  if (index === 0) return 'cover';
  if (total > 1 && index === total - 1) return 'closing';
  return 'content';
}

// 从 Agent 可能发来的多种形状里取出 SVG 字符串（字符串直给 / {svg} / 旧 {type:free,svg}）
function pickSvg(raw) {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.svg === 'string') return raw.svg;
  return null; // 旧的 {html} 自由页路径已退役（导出不再依赖 Chrome 栅格化）
}

// 高层入口：清洗 SVG → 归一 → 打角色与页位。永不抛错；无法解析的载荷回退为空白页。
function normalizeSlide(raw, index, total) {
  const svgRaw = pickSvg(raw);
  const norm = svgRaw ? normalizeSvg(svgRaw) : null;
  const svg = norm || BLANK_SVG;
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    type: 'svg',
    svg,
    role: coerceRole(obj.role, index, total),
    title: typeof obj.title === 'string' ? obj.title : '',
    meta: obj.meta && typeof obj.meta === 'object' ? obj.meta : {},
    index,
    ...(norm ? {} : { _recovered: true }),
  };
}

module.exports = { normalizeSlide, coerceRole, ROLES, BLANK_SVG };

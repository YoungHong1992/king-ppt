// slides（SVG-as-IR）→ .pptx：每页就是一整页 SVG，经 svgToScene 编译为原生可编辑对象，再由 paint 落盘。
// 无需 Chrome、无需布局引擎——SVG 是唯一中间表示，浏览器预览与此处导出消费同一份 SVG，保证预览 == 导出。
const { svgToScene } = require('./svg-to-pptx');
const { paint } = require('./pptx-painter');

// 画布固定 16:9（与 SVG viewBox 1280×720 同比）。主题只承载配色/字体/原型，不改画布几何。
const DEFAULT_CANVAS = { width: 10, height: 5.625 };

async function buildPptx(slides, title, themeId, { canvas = DEFAULT_CANVAS } = {}) {
  const scenes = slides.map((s) => {
    const svg = s && s.svg;
    if (!svg) return { background: { color: 'FFFFFF' }, objects: [] }; // 空载荷兜底：空白页
    return svgToScene(svg, canvas);
  });
  return paint({ canvas, templateId: themeId, slides: scenes }, title);
}

module.exports = { buildPptx, DEFAULT_CANVAS };

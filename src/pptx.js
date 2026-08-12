// slides JSON → .pptx（薄入口：加载模板描述符 → Layout Resolver → PPTX Painter）
// free 自由排版页不经 Resolver，由 renderFree 钩子栅格化为 PNG 后整页嵌入
const { loadDescriptor } = require('./descriptor');
const { resolve } = require('./layout-resolver');
const { paint } = require('./pptx-painter');

async function buildPptx(slides, title, templateId, { renderFree } = {}) {
  const descriptor = loadDescriptor(templateId);
  const total = slides.length;
  const scenes = [];
  for (let index = 0; index < slides.length; index++) {
    const s = slides[index] || {};
    if (s.type === 'free' && s.html) {
      if (!renderFree) throw new Error('包含自由排版页，导出需要 HTML 渲染能力（本机 Chrome）');
      scenes.push(await renderFree(s)); // → { free: true, pngData }
    } else {
      scenes.push(resolve(descriptor, [s], { title, index, total }).slides[0]);
    }
  }
  return paint({ canvas: descriptor.canvas, templateId: descriptor._id, slides: scenes }, title);
}

module.exports = { buildPptx };

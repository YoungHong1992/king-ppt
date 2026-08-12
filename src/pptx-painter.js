// PPTX Painter：Resolved Scene Graph → .pptx（pptxgenjs）
// 纯绘制，不做任何设计决策（查表/选择/坐标已在 layout-resolver 完成）
const PptxGenJS = require('pptxgenjs');

function paintShape(slide, o) {
  const opts = { x: o.x, y: o.y, w: o.w, h: o.h };
  if (o.fill) opts.fill = { color: o.fill, transparency: o.transparency || 0 };
  if (o.line) opts.line = o.line;
  if (o.rectRadius !== undefined) opts.rectRadius = o.rectRadius;
  slide.addShape(o.shape, opts);
}

function paintText(slide, o) {
  slide.addText(o.text, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontSize: o.fontSize, bold: o.bold, color: o.color, fontFace: o.fontFace,
    align: o.align, valign: o.valign, charSpacing: o.charSpacing,
  });
}

function paintBullets(slide, o) {
  const items = (o.items || []).map((t) => ({
    text: t,
    options: {
      bullet: { code: '25AA', color: o.bulletColor },
      fontSize: o.fontSize, color: o.color, fontFace: o.fontFace,
      paraSpaceAfter: o.paraSpaceAfter,
    },
  }));
  slide.addText(items, { x: o.x, y: o.y, w: o.w, h: o.h });
}

function paintTable(slide, o) {
  const headerRow = o.headers.map((h) => ({
    text: h,
    options: {
      bold: o.header.bold, color: o.header.color, fill: { color: o.header.fill },
      fontSize: o.header.fontSize, fontFace: o.fontFace, align: o.header.align || 'center', valign: 'middle',
    },
  }));
  const bodyRows = o.rows.map((r, i) => r.map((c) => ({
    text: c,
    options: {
      color: o.cell.color, fill: { color: i % 2 ? o.cell.zebra : (o.cell.plain || 'FFFFFF') },
      fontSize: o.cell.fontSize, fontFace: o.fontFace, valign: 'middle',
    },
  })));
  slide.addTable([headerRow, ...bodyRows], {
    x: o.x, y: o.y, w: o.w,
    border: { type: 'solid', color: o.border.color, pt: o.border.pt },
    rowH: o.rowH,
  });
}

function paintImage(slide, o) {
  slide.addImage({ path: o.src, x: o.x, y: o.y, w: o.w, h: o.h });
}

const PAINTERS = {
  shape: paintShape,
  text: paintText,
  bullets: paintBullets,
  table: paintTable,
  image: paintImage,
};

function paint(sceneGraph, title) {
  const { width, height } = sceneGraph.canvas;
  const pptx = new PptxGenJS();
  const layoutName = `TPL_${width}x${height}`;
  pptx.defineLayout({ name: layoutName, width, height });
  pptx.layout = layoutName;
  pptx.title = title || 'AI 生成演示文稿';

  for (const s of sceneGraph.slides) {
    const slide = pptx.addSlide();
    if (!s) continue; // 空场景（不应出现，free 页在 buildPptx 已替换为图片场景）
    // free 自由排版页：HTML 已在导出前栅格化为 PNG，整页满铺
    if (s.free) {
      slide.addImage({ data: s.pngData, x: 0, y: 0, w: width, h: height });
      continue;
    }
    if (s.background && s.background.color) slide.background = { color: s.background.color };
    for (const o of s.objects) {
      const painter = PAINTERS[o.kind];
      if (painter) painter(slide, o);
    }
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { paint };

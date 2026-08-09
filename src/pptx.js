// slides JSON → .pptx（PptxGenJS，16:9）
const PptxGenJS = require('pptxgenjs');

// 统一主题 token
const THEME = {
  bg: 'FFFFFF',
  primary: '1F4E79',   // 深蓝
  accent: '2E86C1',    // 亮蓝
  text: '333333',
  muted: '777777',
  font: 'Microsoft YaHei',
};

function buildPptx(slides, title) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W16x9', width: 10, height: 5.625 });
  pptx.layout = 'W16x9';
  pptx.title = title || 'AI 生成演示文稿';

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: THEME.bg };
    switch (s.type) {
      case 'title': renderTitle(slide, s); break;
      case 'section': renderSection(slide, s); break;
      case 'bullets': renderBullets(slide, s); break;
      case 'twoColumn': renderTwoColumn(slide, s); break;
      default: renderBullets(slide, { title: s.title || '', bullets: s.bullets || [] });
    }
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

function renderTitle(slide, s) {
  slide.background = { color: THEME.primary };
  slide.addText(s.title || '', {
    x: 0.8, y: 1.9, w: 8.4, h: 1.2,
    fontSize: 36, bold: true, color: 'FFFFFF', fontFace: THEME.font, align: 'center',
  });
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: 0.8, y: 3.2, w: 8.4, h: 0.8,
      fontSize: 18, color: 'D6E4F0', fontFace: THEME.font, align: 'center',
    });
  }
}

function renderSection(slide, s) {
  slide.background = { color: THEME.primary };
  slide.addText(s.title || '', {
    x: 0.8, y: 2.2, w: 8.4, h: 1,
    fontSize: 30, bold: true, color: 'FFFFFF', fontFace: THEME.font, align: 'center',
  });
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: 0.8, y: 3.2, w: 8.4, h: 0.6,
      fontSize: 16, color: 'D6E4F0', fontFace: THEME.font, align: 'center',
    });
  }
}

function addPageTitle(slide, title) {
  slide.addText(title || '', {
    x: 0.5, y: 0.3, w: 9, h: 0.7,
    fontSize: 24, bold: true, color: THEME.primary, fontFace: THEME.font,
  });
  slide.addShape('rect', { x: 0.5, y: 1.0, w: 1.2, h: 0.05, fill: { color: THEME.accent } });
}

function renderBullets(slide, s) {
  addPageTitle(slide, s.title);
  const items = (s.bullets || []).map((t) => ({
    text: String(t),
    options: { bullet: { code: '25AA', color: THEME.accent }, fontSize: 16, color: THEME.text, fontFace: THEME.font, paraSpaceAfter: 12 },
  }));
  slide.addText(items, { x: 0.6, y: 1.3, w: 8.8, h: 4 });
}

function renderTwoColumn(slide, s) {
  addPageTitle(slide, s.title);
  const col = (title, bullets, x) => {
    slide.addShape('rect', { x, y: 1.3, w: 4.3, h: 0.5, fill: { color: THEME.primary } });
    slide.addText(title || '', {
      x, y: 1.3, w: 4.3, h: 0.5,
      fontSize: 15, bold: true, color: 'FFFFFF', fontFace: THEME.font, align: 'center', valign: 'middle',
    });
    const items = (bullets || []).map((t) => ({
      text: String(t),
      options: { bullet: { code: '25AA', color: THEME.accent }, fontSize: 14, color: THEME.text, fontFace: THEME.font, paraSpaceAfter: 10 },
    }));
    slide.addText(items, { x: x + 0.1, y: 2.0, w: 4.1, h: 3.3 });
  };
  col(s.leftTitle, s.leftBullets, 0.5);
  col(s.rightTitle, s.rightBullets, 5.2);
}

module.exports = { buildPptx };

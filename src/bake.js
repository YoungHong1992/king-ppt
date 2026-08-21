// 原件直用（bake）：把上传模板的关键页面栅格化为「去文字底图」，
// 让封面/章节/结尾页原样保留（背景、logo、装饰 100% 一致），
// 生成时只在实测文字槽上叠加标题。内容页顶栏（含 logo）同样烘焙为装饰图。
//
// 依赖链：pptx-pages（解析）→ 本模块渲染 HTML → html-shot（Chrome 截图 2x PNG）
// 需要本机 Chrome/Edge；烘焙失败时 extract 走参数级提取兜底，不影响上传。
const fs = require('fs');
const path = require('path');
const { parseSourcePages } = require('./pptx-pages');
const htmlShot = require('./html-shot');

const SHAPE_CSS = {
  ellipse: 'border-radius:50%;',
  roundRect: 'border-radius:10px;',
  triangle: 'clip-path:polygon(50% 0,100% 100%,0 100%);',
  diamond: 'clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);',
  parallelogram: 'clip-path:polygon(18% 0,100% 0,82% 100%,0 100%);',
  chevron: 'clip-path:polygon(0 0,86% 0,100% 50%,86% 100%,0 100%);',
  hexagon: 'clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);',
};
const rgba = (hex, transparency) => {
  if (!hex) return null;
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return null;
  if (!transparency) return `#${h}`;
  const a = Math.max(0, Math.min(1, 1 - transparency / 100));
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 页对象图 → HTML。skipObjs：不渲染的对象集合（烘焙底图时抠掉可替换文字）
// clipTopIn：只渲染顶部区域（英寸），用于内容页顶栏条
function pageToHtml(page, canvas, mediaDir, { skipObjs = new Set(), clipTopIn = null } = {}) {
  const S = 1280 / canvas.width; // px / inch
  const Hpx = Math.round((clipTopIn || canvas.height) * S);
  const px = (v) => `${(v * S).toFixed(1)}px`;
  const pt = (p) => `${(p / 72 * S).toFixed(1)}px`;
  const mediaUrl = (name) => {
    const f = path.join(mediaDir, name);
    if (!fs.existsSync(f)) return null;
    return `data:image/${path.extname(name).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(f).toString('base64')}`;
  };
  const fillCss = (fill) => {
    if (!fill || fill.none) return '';
    if (fill.gradient) {
      const dir = fill.gradient.direction === 'vertical' ? 'to bottom' : 'to right';
      const stops = fill.gradient.stops.map((s) => `${rgba(s.color, s.transparency) || '#000'} ${Math.round(s.pos * 100)}%`).join(',');
      return `background:linear-gradient(${dir},${stops});`;
    }
    return `background:${rgba(fill.color, fill.transparency)};`;
  };

  let bgCss = 'background:#fff;';
  let bgHtml = '';
  if (page.background) {
    if (page.background.color) bgCss = `background:${rgba(page.background.color)};`;
    if (page.background.image) {
      const u = mediaUrl(page.background.image);
      if (u) bgHtml = `<img style="position:absolute;inset:0;width:100%;height:100%" src="${u}">`;
    } else if (page.background.gradient) {
      bgHtml = `<div style="position:absolute;inset:0;${fillCss(page.background)}"></div>`;
    }
  }
  const body = (page.objects || []).map((o, i) => {
    if (skipObjs.has(i)) return '';
    const [x, y, w, h] = o.bbox;
    if (clipTopIn !== null && y > clipTopIn) return ''; // 顶栏条只保留区域内对象
    const box = `position:absolute;left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)};${o.rot ? `transform:rotate(${o.rot}deg);` : ''}`;
    if (o.type === 'image') {
      const u = mediaUrl(o.media);
      return u ? `<img style="${box}object-fit:fill" src="${u}">` : '';
    }
    if (o.shape === 'line') {
      const c = rgba(o.line && o.line.color) || '#666';
      const lw = `${((o.line && o.line.width) || 1) / 72 * S}px`;
      if (h <= 0.05) return `<div style="${box}height:${lw};background:${c}"></div>`;
      if (w <= 0.05) return `<div style="${box}width:${lw};background:${c}"></div>`;
      const len = Math.sqrt(w * w + h * h) * S;
      const ang = Math.round((Math.atan2(h, w) * 180) / Math.PI);
      return `<div style="position:absolute;left:${px(x + w / 2)};top:${px(y + h / 2)};width:${len.toFixed(1)}px;height:${lw};background:${c};transform:translate(-50%,-50%) rotate(${ang}deg)"></div>`;
    }
    // custGeom 自由形状（校徽/图标矢量拼块）：按真实路径画 SVG，否则只剩色块
    if (o.paths && o.paths.length) {
      const fill = rgba(o.fill && o.fill.color, o.fill && o.fill.transparency) || 'none';
      const stroke = o.line && o.line.color ? `stroke="${rgba(o.line.color)}" stroke-width="${(o.line.width || 1)}"` : '';
      const svgs = o.paths.map((p) => {
        const vbW = p.w || 1, vbH = p.h || 1;
        return `<svg style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none"><path d="${p.d}" fill="${fill}" fill-rule="evenodd" ${stroke}/></svg>`;
      }).join('');
      return `<div style="${box}">${svgs}</div>`;
    }
    let css = box + fillCss(o.fill);
    if (o.line && o.line.color) css += `border:${((o.line.width || 1) / 72 * S).toFixed(1)}px solid ${rgba(o.line.color)};`;
    css += SHAPE_CSS[o.shape] || '';
    let texts = '';
    if (o.texts && o.texts.length) {
      const paras = o.texts.map((p) => {
        const sizes = p.runs.map((r) => r.size).filter(Boolean);
        const size = sizes.length ? Math.max(...sizes) : 14;
        const spans = p.runs.map((r) => `<span style="${r.color ? `color:${rgba(r.color)};` : ''}${r.bold ? 'font-weight:700;' : ''}${r.italic ? 'font-style:italic;' : ''}${r.font ? `font-family:'${esc(r.font)}','Microsoft YaHei',sans-serif;` : ''}">${esc(r.text)}</span>`).join('');
        const align = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[p.align] || 'left';
        return `<div style="font-size:${pt(size)};text-align:${align};line-height:1.22">${spans}</div>`;
      }).join('');
      const anchor = { t: 'flex-start', ctr: 'center', b: 'flex-end' }[o.anchor] || 'flex-start';
      texts = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:${anchor};gap:2px;overflow:hidden">${paras}</div>`;
    }
    return `<div style="${css}">${texts}</div>`;
  }).join('');
  return `<div style="position:relative;width:1280px;height:${Hpx}px;${bgCss}overflow:hidden">${bgHtml}${body}</div>`;
}

// 文本对象 → 槽位描述（实测 bbox/字号/颜色/字体/对齐）
function textToSlot(o) {
  const allRuns = (o.texts || []).flatMap((p) => p.runs);
  const sized = allRuns.filter((r) => r.size);
  const top = sized.sort((a, b) => b.size - a.size)[0] || allRuns[0] || {};
  const firstPara = (o.texts || [])[0] || {};
  const align = { l: 'left', ctr: 'center', r: 'right' }[firstPara.align] || (o.anchor === 'ctr' ? 'center' : 'left');
  const valign = { t: 'top', ctr: 'middle', b: 'bottom' }[o.anchor] || 'middle';
  const r1 = (v) => Math.round(v * 100) / 100;
  return {
    rect: o.bbox.map(r1),
    size: Math.round(top.size || 28),
    color: top.color || '000000',
    bold: Boolean(top.bold),
    align,
    valign,
    font: top.font || null,
    role: 'content',
    behavior: 'replace',
  };
}

// 找页面的主/副标题文本对象（按字号排序的文本对象；返回对象下标）
function findTitleObjs(page) {
  const textIdx = (page.objects || [])
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.type === 'shape' && (o.texts || []).length > 0
      && String((o.texts[0].runs || []).map((r) => r.text).join('')).trim().length >= 2)
    .map(({ o, i }) => {
      const runs = o.texts.flatMap((p) => p.runs).filter((r) => r.size);
      const size = runs.length ? Math.max(...runs.map((r) => r.size)) : 0;
      return { i, o, size };
    })
    .sort((a, b) => b.size - a.size);
  const title = textIdx[0] || null;
  const subtitle = textIdx.slice(1).find((t) => title && t.o.bbox[1] > title.o.bbox[1]) || textIdx[1] || null;
  return { title, subtitle };
}

// 章节页识别：文本对象少且有大字（无正文列表）
function isSectionLike(page, pageTitleSize) {
  const texts = (page.objects || []).filter((o) => o.type === 'shape' && (o.texts || []).length > 0);
  if (texts.length === 0 || texts.length > 4) return false;
  const maxPara = Math.max(...texts.map((o) => Math.max(...o.texts.map((p) => p.runs.length))));
  if (maxPara > 1) return false; // 多段/列表 → 内容页
  const maxSize = Math.max(...texts.flatMap((o) => o.texts.flatMap((p) => p.runs.map((r) => r.size || 0))));
  return maxSize >= Math.max(24, (pageTitleSize || 20) * 1.1);
}

// 许可/广告页识别（模板站下载包常在末页塞使用条款，不是致谢页）：
// 含网址/条款关键词且没有大字标题
const LICENSE_RE = /(www\.|https?:\/\/|\.com|模板|付费|转载|版权|仅限个人|使用条款|许可)/i;
function pagePlainText(page) {
  return (page.objects || []).flatMap((o) => (o.texts || []).flatMap((p) => p.runs.map((r) => r.text))).join('');
}
function pageMaxFont(page) {
  return Math.max(0, ...(page.objects || []).flatMap((o) => (o.texts || []).flatMap((p) => p.runs.map((r) => r.size || 0))));
}
function isLicenseLike(page) {
  return LICENSE_RE.test(pagePlainText(page)) && pageMaxFont(page) < 40;
}

// 烘焙一页。fixedPage=true（封面/章节/结尾整页）：抠掉页上所有文字对象
// —— 示例文字（答辩人/日期/英文行）都是逐 deck 内容，不该留在底图里；
// clipTopIn（顶栏条）：抠掉与区域相交的所有文字，只留线条/logo/装饰。
async function bakePage({ page, canvas, mediaDir, file, clipTopIn = null }) {
  const { title, subtitle } = findTitleObjs(page);
  const skip = new Set();
  const slots = {};
  (page.objects || []).forEach((o, i) => {
    const hasText = o.type === 'shape' && (o.texts || []).length > 0;
    if (!hasText) return;
    if (clipTopIn === null || o.bbox[1] < clipTopIn + 0.4) skip.add(i);
  });
  if (title) {
    slots.title = textToSlot(title.o);
    // 顶栏标题框在原件里是自适应文字宽度的窄框；生成标题更长，
    // 把槽宽扩展到标题带（右侧给 logo 留 1.6in）
    if (clipTopIn !== null && slots.title.align === 'left') {
      slots.title.rect[2] = Math.max(slots.title.rect[2], canvas.width - slots.title.rect[0] - 1.6);
    }
  }
  if (clipTopIn === null && subtitle) {
    slots.subtitle = { ...textToSlot(subtitle.o), behavior: 'generate' };
  }
  const S = 1280 / canvas.width;
  const heightPx = Math.round((clipTopIn || canvas.height) * S);
  const html = pageToHtml(page, canvas, mediaDir, { skipObjs: skip, clipTopIn });
  const png = await htmlShot.renderToPng(html, { width: 1280, height: heightPx, scale: 2 });
  fs.writeFileSync(file, png);
  const images = (page.objects || []).filter((o) => o.type === 'image' && o.bbox)
    .sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]));
  return { slots, skipCount: skip.size, imageSlot: images[0] ? { rect: images[0].bbox, media: images[0].media } : null };
}

// 主入口：烘焙固定页与内容页顶栏，返回 descriptor 可直接消费的结果
async function bakeTemplateAssets(buffer, { stagingDir }) {
  const mediaDir = path.join(stagingDir, '.media');
  const assetsDir = path.join(stagingDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const { canvas, pages } = await parseSourcePages(buffer, { mediaDir });
  if (!pages.length) return {};

  const out = {};
  const pageTitleSize = 20;

  // 内容页：排除首末页与章节页后，选顶部元素最多的一页做顶栏源
  const sectionSet = new Set(pages.map((p, i) => (i > 0 && i < pages.length - 1 && isSectionLike(p, pageTitleSize) ? i : -1)).filter((i) => i >= 0));
  const contentIdx = pages.map((p, i) => i).filter((i) => i !== 0 && i !== pages.length - 1 && !sectionSet.has(i));
  const topbarSrcIdx = contentIdx.length
    ? contentIdx.reduce((best, i) => {
      const topObjs = (pages[i].objects || []).filter((o) => o.bbox[1] < 1.3).length;
      const bestObjs = (pages[best].objects || []).filter((o) => o.bbox[1] < 1.3).length;
      return topObjs > bestObjs ? i : best;
    }, contentIdx[0])
    : -1;

  // 顶栏条：取内容页顶部 1.3in（含 logo/校名/装饰），标题文字实测叠加
  if (topbarSrcIdx >= 0) {
    const clipTopIn = 1.3;
    const srcPage = pages[topbarSrcIdx];
    const { slots } = await bakePage({
      page: srcPage, canvas, mediaDir,
      file: path.join(assetsDir, 'baked-topbar.png'),
      clipTopIn,
    });
    if (slots.title) {
      const images = (srcPage.objects || []).filter((o) => o.type === 'image' && o.bbox && o.bbox[1] >= clipTopIn);
      const image = images.sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]))[0];
      out.topbar = {
        file: 'baked-topbar.png', hIn: clipTopIn, slot: slots.title,
        sourcePage: topbarSrcIdx,
        imageSlot: image ? { rect: image.bbox, media: image.media } : null,
      };
    }
  }

  // 封面：第 1 页原样（抠掉全部文字，槽位取主/副标题）
  {
    const { slots, imageSlot } = await bakePage({ page: pages[0], canvas, mediaDir, file: path.join(assetsDir, 'baked-cover.png') });
    if (slots.title) out.cover = { file: 'baked-cover.png', sourcePage: 0, slots, imageSlot };
  }
  // 章节页：优先实测识别的章节页，否则末页（答辩类模板末页即致谢页）
  {
    const idx = sectionSet.size ? [...sectionSet][0] : pages.length - 1;
    const { slots, imageSlot } = await bakePage({ page: pages[idx], canvas, mediaDir, file: path.join(assetsDir, 'baked-section.png') });
    // Divider pages commonly put a huge numeric chapter marker ahead of the
    // actual title. Preserve both slots instead of treating the number as the
    // editable title.
    const { title, subtitle } = findTitleObjs(pages[idx]);
    const sourceTitle = title && pagePlainText({ objects: [title.o] }).trim();
    if (/^\d{1,3}$/.test(sourceTitle || '') && slots.title && slots.subtitle) {
      slots.sectionNo = slots.title;
      slots.title = slots.subtitle;
      delete slots.subtitle;
    }
    if (slots.title) out.section = { file: 'baked-section.png', sourcePage: idx, slots, imageSlot };
  }
  // 结尾页：从末页往前跳过许可/广告页（模板站下载包的条款页不是致谢页）
  {
    let closingIdx = pages.length - 1;
    while (closingIdx > 0 && isLicenseLike(pages[closingIdx])) closingIdx--;
    if (pages.length > 1 && !sectionSet.has(closingIdx) && closingIdx > 0) {
      const { slots, imageSlot } = await bakePage({ page: pages[closingIdx], canvas, mediaDir, file: path.join(assetsDir, 'baked-closing.png') });
      if (slots.title) out.closing = { file: 'baked-closing.png', sourcePage: closingIdx, slots, imageSlot };
    }
  }
  out.canvas = canvas;
  out.sourceSlideCount = pages.length;
  out.sectionPages = [...sectionSet];
  return out;
}

module.exports = { bakeTemplateAssets };

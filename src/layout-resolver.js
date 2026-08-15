// Layout Resolver：descriptor + slides 内容 → Resolved Scene Graph
// 唯一的设计决策者：palette/字体/档位查表、variant 选择、渐变离散化、坐标计算
// 输出的场景图与模板无关，交给 painter（pptx / dom）纯绘制
const path = require('path');

// ---------- 查表 helpers ----------
function pal(d, role) {
  if (!role) return undefined;
  return (d.palette && d.palette[role]) || role; // 允许直接写色值
}

function sizeOf(d, s) {
  if (typeof s === 'number') return s;
  return (d.typography.scale && d.typography.scale[s]) || d.typography.scale.body || 14;
}

function fontOf(d, name) {
  const f = d.typography.fonts || {};
  return ((name && f[name]) || f.body || {}).latin || 'Microsoft YaHei';
}

function assetPath(d, rel) {
  return path.isAbsolute(rel) ? rel : path.join(d._dir, rel);
}

// 渐变蒙版离散化：pptxgenjs 不支持渐变，按 stops 插值切成 8 条阶梯透明度矩形带
// overlay.region 可选，归一化 [x, y, w, h]，限定蒙版覆盖区域（默认整页）
function overlayBands(overlay, canvas) {
  const stops = [...(overlay.stops || [])].sort((a, b) => a[0] - b[0]);
  if (stops.length < 2) return [];
  const interp = (t) => {
    if (t <= stops[0][0]) return stops[0][1];
    if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, a0] = stops[i];
      const [t1, a1] = stops[i + 1];
      if (t >= t0 && t <= t1) return a0 + ((a1 - a0) * (t - t0)) / (t1 - t0 || 1);
    }
    return stops[stops.length - 1][1];
  };
  const bands = [];
  const N = 8;
  const horizontal = overlay.direction !== 'vertical';
  const { width: W, height: H } = canvas;
  const [rx, ry, rw, rh] = overlay.region || [0, 0, 1, 1];
  const region = { x: rx * W, y: ry * H, w: rw * W, h: rh * H };
  for (let i = 0; i < N; i++) {
    const t0 = i / N;
    const t1 = (i + 1) / N;
    const alpha = Math.round(interp((t0 + t1) / 2));
    bands.push({
      kind: 'shape', shape: 'rect',
      x: horizontal ? region.x + t0 * region.w : region.x,
      y: horizontal ? region.y : region.y + t0 * region.h,
      w: horizontal ? (t1 - t0) * region.w + 0.02 : region.w,   // 微量重叠防缝隙
      h: horizontal ? region.h : (t1 - t0) * region.h + 0.02,
      fill: overlay.color, transparency: alpha,
    });
  }
  return bands;
}

// ---------- 装饰 / 槽位 ----------
function resolveDecoration(d, use, at) {
  const deco = (d.decorations || {})[use];
  if (!deco) return [];
  const [x, y] = at || [0, 0];
  if (deco.kind === 'baked') {
    const [w, h] = deco.defaultSize || [1, 1];
    return [{ kind: 'image', src: assetPath(d, deco.src), x, y, w, h }];
  }
  const [w, h] = deco.defaultSize || [1, 0.1];
  return [{
    kind: 'shape', shape: deco.shape || 'rect', x, y, w, h,
    fill: pal(d, deco.fill), color: pal(d, deco.color),
    line: deco.pt ? { color: pal(d, deco.color || deco.fill), width: deco.pt } : undefined,
  }];
}

function slotValue(slot, slide, ctx) {
  if (slot.text !== undefined) return slot.text;
  if (slot.fromIndex) return String(ctx.index + 1).padStart(2, '0');
  const raw = slide[slot.name];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return (slot.prefix || '') + String(raw);
}

function resolveSlots(d, variant, slide, ctx, objects) {
  for (const [name, slot] of Object.entries(variant.slots || {})) {
    const value = slotValue({ name, ...slot }, slide, ctx);
    if (value === undefined || value === '') continue;
    const [x, y, w, h] = slot.rect;
    // _edit：字段来自 slide[name] 的槽位可就地编辑（固定文案/页码槽不标）
    const editable = !slot.fromIndex && slot.text === undefined && slide[name] !== undefined;
    objects.push({
      kind: 'text', x, y, w, h, text: String(value),
      fontSize: sizeOf(d, slot.size),
      bold: Boolean(slot.bold),
      color: pal(d, slot.color) || pal(d, 'text'),
      fontFace: fontOf(d, slot.font),
      align: slot.align, valign: slot.valign,
      charSpacing: slot.letterSpacing,
      ...(editable ? { _edit: { field: name, prefix: slot.prefix || '' } } : {}),
    });
  }
}

// ---------- chrome 组件（每页固定出现）----------
const CHROME = {
  pageTitle(d, ctx, objects) {
    const p = (d.components || {}).pageTitle;
    if (!p || !ctx.slide.title) return;
    const [x, y, w, h] = p.slot.rect;
    objects.push({
      kind: 'text', x, y, w, h, text: String(ctx.slide.title),
      fontSize: sizeOf(d, p.slot.size), bold: Boolean(p.slot.bold),
      color: pal(d, p.slot.color), fontFace: fontOf(d, 'title'),
      _edit: { field: 'title' },
    });
    for (const dec of p.decorations || []) {
      objects.push(...resolveDecoration(d, dec.use, dec.at));
    }
  },

  // 斜切色带 + 圆点图标 + 页题（复古蓝米版式签名）
  titleBand(d, ctx, objects) {
    const p = (d.components || {}).titleBand;
    if (!p || !ctx.slide.title) return;
    for (const dec of p.decorations || []) {
      objects.push(...resolveDecoration(d, dec.use, dec.at));
    }
    const [x, y, w, h] = p.slot.rect;
    objects.push({
      kind: 'text', x, y, w, h, text: String(ctx.slide.title),
      fontSize: sizeOf(d, p.slot.size), bold: Boolean(p.slot.bold),
      color: pal(d, p.slot.color), fontFace: fontOf(d, 'title'),
      _edit: { field: 'title' },
    });
  },

  // 底部深蓝总结条（无 conclusion 内容时整条跳过）
  summaryBar(d, ctx, objects) {
    const p = (d.components || {}).summaryBar;
    if (!p || !ctx.slide.conclusion) return;
    const [x, y, w, h] = p.rect;
    objects.push({ kind: 'shape', shape: 'rect', x, y, w, h, fill: pal(d, p.fill) });
    if (p.edge) {
      const [ew] = [p.edge.width || 0.25];
      objects.push({ kind: 'shape', shape: 'rect', x, y, w: ew, h, fill: pal(d, p.edge.fill) });
    }
    for (const [name, slot] of Object.entries(p.slots || {})) {
      const raw = ctx.slide[name];
      if (!raw) continue;
      const [sx, sy, sw, sh] = slot.rect;
      objects.push({
        kind: 'text', x: sx, y: sy, w: sw, h: sh, text: String(raw),
        fontSize: sizeOf(d, slot.size), bold: Boolean(slot.bold),
        color: pal(d, slot.color), fontFace: fontOf(d), valign: 'middle',
        _edit: { field: name },
      });
    }
  },

  // 页脚：左标题右页码
  footer(d, ctx, objects) {
    const p = (d.components || {}).footer;
    if (!p) return;
    const size = sizeOf(d, p.size);
    const color = pal(d, p.color);
    const pageNo = `${String(ctx.index + 1).padStart(2, '0')} / ${String(ctx.total).padStart(2, '0')}`;
    if (ctx.title) {
      objects.push({
        kind: 'text', x: p.marginX || 0.5, y: p.y, w: 6, h: 0.35, text: String(ctx.title),
        fontSize: size, color, fontFace: fontOf(d),
      });
    }
    objects.push({
      kind: 'text', x: d.canvas.width - (p.marginX || 0.5) - 2, y: p.y, w: 2, h: 0.35, text: pageNo,
      fontSize: size, color, fontFace: fontOf(d), align: 'right',
    });
  },
};

// ---------- 主体组件（按内容类型）----------
// bullets 对象的 _edit.field 指向 slide 上的数组字段（bullets/leftBullets/rightBullets），
// 前端按条目下标逐条就地编辑
function bulletsObject(x, y, w, h, items, opts) {
  const { _edit, ...rest } = opts;
  return { kind: 'bullets', x, y, w, h, items: (items || []).map(String), ...rest, ...(_edit ? { _edit } : {}) };
}

const BODY = {
  bullets(d, ctx, objects) {
    const p = d.components.cardList;
    // 图片版式等变体可用 variant.bodyRect 收窄主体区域
    const [x, y, w, h] = ctx.bodyRect || p.rect;
    if (!ctx.bodyRect && p.card) {
      objects.push({
        kind: 'shape', shape: 'roundRect', x: p.card.rect[0], y: p.card.rect[1], w: p.card.rect[2], h: p.card.rect[3],
        fill: pal(d, p.card.fill), rectRadius: p.card.radius,
        line: p.card.border ? { color: pal(d, p.card.border.color), width: p.card.border.pt } : undefined,
      });
    }
    objects.push(bulletsObject(x, y, w, h, ctx.slide.bullets, {
      fontSize: sizeOf(d, p.size), color: pal(d, p.color),
      bulletColor: pal(d, p.bulletColor), paraSpaceAfter: p.paraSpaceAfter, fontFace: fontOf(d),
      _edit: { field: 'bullets' },
    }));
  },

  twoColumn(d, ctx, objects) {
    const p = d.components.cardPair;
    const s = ctx.slide;
    const cols = [
      { title: s.leftTitle, bullets: s.leftBullets, field: 'left' },
      { title: s.rightTitle, bullets: s.rightBullets, field: 'right' },
    ];
    cols.forEach((c, i) => {
      const x = p.columns.xs[i];
      const w = p.columns.w;
      if (p.card) {
        objects.push({
          kind: 'shape', shape: 'roundRect', x, y: p.columns.tagY - (p.card.offsetY || 0), w, h: p.columns.tagH + p.columns.bodyH + (p.card.offsetY || 0),
          fill: pal(d, p.card.fill), rectRadius: p.card.radius,
          line: p.card.border ? { color: pal(d, p.card.border.color), width: p.card.border.pt } : undefined,
        });
      }
      const tagFill = Array.isArray(p.tag.fill) ? p.tag.fill[i] : p.tag.fill;
      if (p.tag.ribbon) {
        objects.push({
          kind: 'shape', shape: 'parallelogram', x: x + (p.tag.offsetX || 0), y: p.columns.tagY,
          w: p.tag.w || 2.88, h: p.columns.tagH, fill: pal(d, tagFill),
        });
      } else {
        objects.push({ kind: 'shape', shape: 'rect', x, y: p.columns.tagY, w, h: p.columns.tagH, fill: pal(d, tagFill) });
      }
      objects.push({
        kind: 'text', x, y: p.columns.tagY, w, h: p.columns.tagH, text: String(c.title || ''),
        fontSize: sizeOf(d, p.tag.size), bold: Boolean(p.tag.bold), color: pal(d, p.tag.color),
        align: p.tag.align, valign: 'middle', fontFace: fontOf(d),
        _edit: { field: `${c.field}Title` },
      });
      objects.push(bulletsObject(x + p.columns.bodyPadX, p.columns.bodyY, w - p.columns.bodyPadX * 2, p.columns.bodyH, c.bullets, {
        fontSize: sizeOf(d, p.body.size), color: pal(d, p.body.color),
        bulletColor: pal(d, p.body.bulletColor), paraSpaceAfter: p.body.paraSpaceAfter, fontFace: fontOf(d),
        _edit: { field: `${c.field}Bullets` },
      }));
    });
  },

  table(d, ctx, objects) {
    const p = d.components.table;
    const s = ctx.slide;
    const headers = (s.headers || []).map(String);
    if (headers.length === 0) return;
    const rows = (s.rows || []).map((r) => (Array.isArray(r) ? r : [r]).map(String));
    const [x, y, w] = ctx.bodyRect || p.rect;
    objects.push({
      kind: 'table', x, y, w, headers, rows, rowH: p.rowH,
      header: { fill: pal(d, p.header.fill), color: pal(d, p.header.color), fontSize: sizeOf(d, p.header.size), bold: Boolean(p.header.bold), align: p.header.align },
      cell: { color: pal(d, p.cell.color), fontSize: sizeOf(d, p.cell.size), zebra: pal(d, p.cell.zebra), plain: pal(d, p.cell.plain || 'bg') },
      border: { color: pal(d, (p.cell.border || {}).color), pt: (p.cell.border || {}).pt || 1 },
      fontFace: fontOf(d),
      _edit: { field: 'table' },
    });
  },

  steps(d, ctx, objects) {
    const p = d.components.flowChain;
    const steps = (ctx.slide.steps || []).slice(0, p.maxItems || 5);
    if (steps.length === 0) return;
    const a = ctx.bodyRect
      ? { x: ctx.bodyRect[0], y: ctx.bodyRect[1], w: ctx.bodyRect[2], h: ctx.bodyRect[3], gap: p.area.gap }
      : p.area;
    const w = (a.w - a.gap * (steps.length - 1)) / steps.length;
    steps.forEach((st, i) => {
      const x = a.x + i * (w + a.gap);
      objects.push({
        kind: 'shape', shape: 'roundRect', x, y: a.y, w, h: a.h,
        fill: pal(d, p.card.fill), rectRadius: p.card.radius,
        line: p.card.border ? { color: pal(d, p.card.border.color), width: p.card.border.pt } : undefined,
      });
      const nd = p.num.d;
      objects.push({ kind: 'shape', shape: 'ellipse', x: x + w / 2 - nd / 2, y: a.y + p.num.offsetY, w: nd, h: nd, fill: pal(d, p.num.fill) });
      objects.push({
        kind: 'text', x: x + w / 2 - nd / 2, y: a.y + p.num.offsetY, w: nd, h: nd, text: String(i + 1),
        fontSize: sizeOf(d, p.num.size), bold: Boolean(p.num.bold), color: pal(d, p.num.color),
        align: 'center', valign: 'middle', fontFace: fontOf(d),
      });
      objects.push({
        kind: 'text', x: x + 0.15, y: a.y + p.title.offsetY, w: w - 0.3, h: p.title.h, text: String(st.title || ''),
        fontSize: sizeOf(d, p.title.size), bold: Boolean(p.title.bold), color: pal(d, p.title.color),
        align: 'center', fontFace: fontOf(d),
        _edit: { field: 'steps', index: i, key: 'title' },
      });
      objects.push({
        kind: 'text', x: x + 0.15, y: a.y + p.desc.offsetY, w: w - 0.3, h: p.desc.h, text: String(st.desc || ''),
        fontSize: sizeOf(d, p.desc.size), color: pal(d, p.desc.color),
        align: 'center', valign: 'top', fontFace: fontOf(d),
        _edit: { field: 'steps', index: i, key: 'desc' },
      });
    });
  },

  stats(d, ctx, objects) {
    const p = d.components.statCards;
    const stats = (ctx.slide.stats || []).slice(0, p.maxItems || 4);
    if (stats.length === 0) return;
    const a = ctx.bodyRect
      ? { x: ctx.bodyRect[0], y: ctx.bodyRect[1], w: ctx.bodyRect[2], h: ctx.bodyRect[3], gap: p.area.gap }
      : p.area;
    const w = (a.w - a.gap * (stats.length - 1)) / stats.length;
    stats.forEach((st, i) => {
      const x = a.x + i * (w + a.gap);
      objects.push({
        kind: 'shape', shape: 'roundRect', x, y: a.y, w, h: a.h,
        fill: pal(d, p.card.fill), rectRadius: p.card.radius,
        line: p.card.border ? { color: pal(d, p.card.border.color), width: p.card.border.pt } : undefined,
      });
      objects.push({
        kind: 'text', x, y: a.y + p.value.offsetY, w, h: p.value.h, text: String(st.value || ''),
        fontSize: sizeOf(d, p.value.size), bold: Boolean(p.value.bold), color: pal(d, p.value.color),
        align: 'center', valign: 'middle', fontFace: fontOf(d),
        _edit: { field: 'stats', index: i, key: 'value' },
      });
      objects.push({
        kind: 'text', x: x + 0.1, y: a.y + p.label.offsetY, w: w - 0.2, h: p.label.h, text: String(st.label || ''),
        fontSize: sizeOf(d, p.label.size), color: pal(d, p.label.color),
        align: 'center', fontFace: fontOf(d),
        _edit: { field: 'stats', index: i, key: 'label' },
      });
    });
  },

  quote() { /* closing 家族的 slots 已覆盖 */ },
};

// ---------- 主入口 ----------
// 候选选择：① slide._variant 显式指定（用户「换版式」按钮，按候选数取模）
// ② 有配图且有图片版式 → 优先；③ 默认按页码轮换，整本 deck 版式有节奏变化
function findVariant(d, cand) {
  const [fam, varName = 'default'] = String(cand).split('.');
  return ((((d.families || {})[fam] || {}).variants || {})[varName]) || null;
}

function pickCandidate(d, type, slide, ctx) {
  const all = ((d.typeMapping || {})[type] || {}).candidates || [];
  if (all.length === 0) return null;
  if (typeof slide._variant === 'number' && slide._variant >= 0) {
    return all[slide._variant % all.length];
  }
  // 图片专属版式（wantsImage）：无图时剔除（避免版式留空），有图时优先；
  // 全部都是图片版式时保持原样，让 bodyRect 兜底渲染
  const imageOnly = all.filter((c) => {
    const v = findVariant(d, c);
    return v && v.image && v.wantsImage;
  });
  let cands = all;
  if (imageOnly.length > 0 && imageOnly.length < all.length) {
    cands = slide.image ? imageOnly : all.filter((c) => !imageOnly.includes(c));
  }
  return cands[ctx.index % cands.length];
}

function resolveSlide(d, slide, ctx) {
  const type = (d.typeMapping && d.typeMapping[slide.type]) ? slide.type : 'bullets';
  const cand = pickCandidate(d, type, slide, ctx);
  const variant = (cand && findVariant(d, cand)) || {};
  const bgDef = variant.background || { color: 'bg' };

  const out = { background: undefined, objects: [] };

  // 背景：纯色 / 图片（可多图轮换）+ 渐变蒙版（可多层）
  out.background = { color: pal(d, bgDef.color || 'bg') };
  const images = bgDef.images || (bgDef.image ? [bgDef.image] : []);
  if (images.length > 0) {
    const img = images[ctx.index % images.length];
    out.objects.push({ kind: 'image', src: assetPath(d, img), x: 0, y: 0, w: d.canvas.width, h: d.canvas.height });
  }
  const overlays = bgDef.overlays || (bgDef.overlay ? [bgDef.overlay] : []);
  for (const ov of overlays) {
    out.objects.push(...overlayBands({ ...ov, color: pal(d, ov.color || 'bg') }, d.canvas));
  }

  // 页面级装饰 → 槽位 → chrome → 配图 → 主体
  for (const dec of variant.decorations || []) {
    out.objects.push(...resolveDecoration(d, dec.use, dec.at));
  }
  resolveSlots(d, variant, slide, ctx, out.objects);
  for (const c of variant.chrome || []) {
    if (CHROME[c]) CHROME[c](d, ctx, out.objects);
  }
  // 配图槽（variant.image 定义位置；slide.image 由生成管线的配图流程填充）
  if (slide.image && variant.image) {
    const [ix, iy, iw, ih] = variant.image.rect;
    const imgObj = { kind: 'image', src: slide.image.path, x: ix, y: iy, w: iw, h: ih };
    if (slide.image.url) imgObj.url = slide.image.url;
    if (variant.image.border) {
      imgObj.line = { color: pal(d, variant.image.border), width: 1 };
    }
    out.objects.push(imgObj);
  }
  if (BODY[type]) {
    BODY[type](d, { ...ctx, bodyRect: variant.bodyRect }, out.objects);
  }
  return out;
}

function resolve(d, slides, opts = {}) {
  const total = slides.length;
  return {
    canvas: d.canvas,
    templateId: d._id,
    slides: slides.map((s, index) => {
      const slide = s || {};
      // free 自由排版页：内容在 slide.html，预览/导出各自处理，场景图为空
      if (slide.type === 'free') return null;
      return resolveSlide(d, slide, { slide, index, total, ...opts });
    }),
  };
}

module.exports = { resolve };

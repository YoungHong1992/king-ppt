// 上传模板自动提取器：.pptx → 模板描述符草稿
// 三层策略：直接层（theme/canvas）→ 聚类层（跨页重复形状/字号直方图/背景检测）→ 估算层（套默认映射）
// 所有分析只读 Stage 0 的 Normalized Object Graph，不直接碰 XML
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { USER_DIR } = require('./descriptor');
const { BASE_DESCRIPTOR } = require('./base-descriptor');
const { resolve } = require('./layout-resolver');
const { profileFromPptx } = require('./template-profile');

const EMU = 914400;
const LIMITS = {
  compressed: 20 * 1024 * 1024,     // 上传压缩包 ≤ 20MB
  uncompressed: 200 * 1024 * 1024,  // 解压后 ≤ 200MB
  maxSlides: 200,
  maxAssetSize: 20 * 1024 * 1024,
};

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const emu2in = (v) => Number(v) / EMU;
const r1 = (v) => Math.round(v * 100) / 100;

// ---------- Stage 0：Normalized Object Graph ----------
function parseRels(relsXml) {
  const doc = xml.parse(relsXml);
  const map = {};
  for (const rel of asArray(doc.Relationships && doc.Relationships.Relationship)) {
    map[rel['@_Id']] = rel['@_Target'];
  }
  return map;
}

function fillOf(spPr) {
  if (!spPr) return null;
  const sf = spPr.solidFill;
  if (sf) {
    if (sf.srgbClr) return { color: sf.srgbClr['@_val'] };
    if (sf.schemeClr) return { scheme: sf.schemeClr['@_val'] };
  }
  if (spPr.gradFill) {
    const stops = asArray(spPr.gradFill.gsLst && spPr.gradFill.gsLst.gs).map((gs) => {
      const clr = gs.srgbClr || gs.schemeClr || {};
      const alpha = clr.alpha ? Number(clr.alpha['@_val']) / 1000 : 100;
      return { pos: Number(gs['@_pos']) / 100000, color: clr['@_val'], transparency: Math.round(100 - alpha) };
    });
    const ang = Number((spPr.gradFill.lin || {})['@_ang'] || 0);
    return { gradient: { stops, direction: ang >= 2700000 && ang <= 8100000 ? 'vertical' : 'horizontal' } };
  }
  return null;
}

function textsOf(sp) {
  const out = [];
  for (const p of asArray(sp.txBody && sp.txBody.p)) {
    for (const r of asArray(p.r)) {
      const rPr = r.rPr || {};
      const colorNode = rPr.solidFill && (rPr.solidFill.srgbClr || rPr.solidFill.schemeClr);
      out.push({
        text: String(r.t !== undefined ? r.t : ''),
        size: rPr['@_sz'] ? Number(rPr['@_sz']) / 100 : null,
        bold: rPr['@_b'] === '1' || rPr['@_b'] === true,
        color: colorNode ? colorNode['@_val'] : null,
        font: rPr.latin ? rPr.latin['@_typeface'] : null,
      });
    }
  }
  return out.filter((t) => t.text.trim() !== '');
}

function shapeBBox(spPr) {
  const xfrm = spPr && spPr.xfrm;
  if (!xfrm || !xfrm.off || !xfrm.ext) return null;
  return [r1(emu2in(xfrm.off['@_x'])), r1(emu2in(xfrm.off['@_y'])), r1(emu2in(xfrm.ext['@_cx'])), r1(emu2in(xfrm.ext['@_cy']))];
}

function parseSlide(xmlText, rels) {
  const doc = xml.parse(xmlText);
  const tree = doc.sld && doc.sld.cSld && doc.sld.cSld.spTree;
  const objects = [];
  let z = 0;

  const addShape = (n, bbox) => {
    const prst = n.spPr && n.spPr.prstGeom ? n.spPr.prstGeom['@_prst'] : (n.spPr && n.spPr.custGeom ? 'custGeom' : null);
    objects.push({
      type: 'shape', shape: prst, bbox,
      fill: fillOf(n.spPr), texts: textsOf(n), zIndex: objects.length + 1,
    });
  };
  const addPic = (n, bbox) => {
    const blip = n.blipFill && n.blipFill.blip;
    const rid = blip && blip['@_embed'];
    objects.push({ type: 'image', bbox, target: rid ? rels[rid] : null, zIndex: objects.length + 1 });
  };

  // 组合形状（grpSp）递归展开；子坐标经 chOff/chExt → off/ext 仿射变换还原到页面坐标
  // AlternateContent 下钻到 Choice/Fallback
  const walk = (node, tf) => {
    if (!node || typeof node !== 'object') return;
    const mapBox = (b) => {
      if (!b || !tf) return b;
      const [ox, oy, sx, sy] = tf;
      return [r1(ox + b[0] * sx), r1(oy + b[1] * sy), r1(b[2] * sx), r1(b[3] * sy)];
    };
    for (const sp of asArray(node.sp)) addShape(sp, mapBox(shapeBBox(sp.spPr)));
    for (const pic of asArray(node.pic)) addPic(pic, mapBox(shapeBBox(pic.spPr)));
    for (const grp of asArray(node.grpSp)) {
      const g = grp.grpSpPr && grp.grpSpPr.xfrm;
      let childTf = tf;
      if (g && g.off && g.ext && g.chOff && g.chExt) {
        const sx = emu2in(g.ext['@_cx']) / emu2in(g.chExt['@_cx'] || g.ext['@_cx']);
        const sy = emu2in(g.ext['@_cy']) / emu2in(g.chExt['@_cy'] || g.ext['@_cy']);
        const ox = emu2in(g.off['@_x']) - emu2in(g.chOff['@_x']) * sx;
        const oy = emu2in(g.off['@_y']) - emu2in(g.chOff['@_y']) * sy;
        childTf = tf
          ? [tf[0] + ox * tf[2], tf[1] + oy * tf[3], tf[2] * sx, tf[3] * sy]
          : [ox, oy, sx, sy];
      }
      walk(grp, childTf);
    }
    for (const ac of asArray(node.AlternateContent)) {
      walk(ac.Choice, tf);
      walk(ac.Fallback, tf);
    }
  };
  walk(tree, null);
  return objects;
}

// ---------- 聚类 helpers ----------
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const bboxKey = (b) => b.map((v) => r1(v)).join(',');

function isFullScreen(bbox, canvas, tol = 0.03) {
  if (!bbox) return false;
  return bbox[0] <= canvas.width * tol && bbox[1] <= canvas.height * tol
    && bbox[2] >= canvas.width * (1 - tol) && bbox[3] >= canvas.height * (1 - tol);
}

function luminance(hex) {
  if (!hex || hex.length !== 6) return 0.5;
  const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return 0.2126 * n(0) + 0.7152 * n(2) + 0.0722 * n(4);
}

// ---------- 主流程 ----------
async function extractFromPptx(buffer, filename = 'uploaded.pptx') {
  if (buffer.length > LIMITS.compressed) throw new Error('文件超过 20MB 上限');
  if (/\.pptm$/i.test(filename)) throw new Error('不支持带宏的 .pptm 文件');

  const zip = await JSZip.loadAsync(buffer);
  if (zip.file('ppt/vbaProject.bin')) throw new Error('不支持带宏的演示文稿');
  for (const [name] of Object.entries(zip.files)) {
    if (name.includes('..')) throw new Error('非法的压缩包路径');
  }

  // ---- 直接层：theme + canvas ----
  const themeFile = zip.file('ppt/theme/theme1.xml');
  if (!themeFile) throw new Error('不是有效的 .pptx（缺少 theme1.xml）');
  const theme = xml.parse(await themeFile.async('text'));
  const scheme = theme.theme && theme.theme.themeElements && theme.theme.themeElements.clrScheme;
  const rawColors = {};
  for (const key of Object.keys(scheme || {})) {
    const node = scheme[key];
    rawColors[key] = (node.srgbClr && node.srgbClr['@_val']) || (node.sysClr && node.sysClr['@_lastClr']) || null;
  }
  const fontScheme = theme.theme.themeElements.fontScheme || {};
  const fontOf = (f) => (f && f.latin ? f.latin['@_typeface'] : null);
  const eaOf = (f) => (f && f.ea ? f.ea['@_typeface'] : null);
  const fonts = {
    title: { latin: fontOf(fontScheme.majorFont), ea: eaOf(fontScheme.majorFont) || fontOf(fontScheme.majorFont) },
    body: { latin: fontOf(fontScheme.minorFont), ea: eaOf(fontScheme.minorFont) || fontOf(fontScheme.minorFont) },
  };

  const presXml = xml.parse(await zip.file('ppt/presentation.xml').async('text'));
  const sldSz = presXml.presentation.sldSz || {};
  const canvas = { width: r1(emu2in(sldSz['@_cx'] || 12192000)), height: r1(emu2in(sldSz['@_cy'] || 6858000)) };

  // ---- 逐页 Object Graph ----
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (slideNames.length === 0) throw new Error('pptx 中没有幻灯片');
  if (slideNames.length > LIMITS.maxSlides) throw new Error(`页数超过上限（${LIMITS.maxSlides}）`);

  const pages = [];
  let totalBytes = 0;
  for (const name of slideNames) {
    const text = await zip.file(name).async('text');
    totalBytes += text.length;
    if (totalBytes > LIMITS.uncompressed) throw new Error('解压后内容超过 200MB 上限');
    let rels = {};
    const relsName = name.replace('slides/', 'slides/_rels/') + '.rels';
    if (zip.file(relsName)) rels = parseRels(await zip.file(relsName).async('text'));
    pages.push(parseSlide(text, rels));
  }

  // ---- 聚类层 ----
  // 1. 背景：满屏 rect 的最常见填充 / 满屏图片
  const bgColorCount = {};
  const bgImages = [];
  const overlayDrafts = [];
  pages.forEach((objs) => {
    for (const o of objs) {
      if (o.type === 'shape' && isFullScreen(o.bbox, canvas)) {
        if (o.fill && o.fill.color) bgColorCount[o.fill.color] = (bgColorCount[o.fill.color] || 0) + 1;
        if (o.fill && o.fill.gradient && o.fill.gradient.stops.length >= 2) overlayDrafts.push(o.fill.gradient);
      }
      if (o.type === 'image' && isFullScreen(o.bbox, canvas) && o.target) bgImages.push(o.target);
    }
  });
  const bgColor = Object.entries(bgColorCount).sort((a, b) => b[1] - a[1])[0];

  // 2. 跨页重复形状 → decorations 候选（版式签名）
  //    容差聚类：x/y/h 近似即归一组（宽度随标题长度变化，不参与匹配）
  const clusters = [];
  pages.forEach((objs) => {
    const seen = new Set();
    for (const o of objs) {
      if (o.type !== 'shape' || !o.bbox || isFullScreen(o.bbox, canvas)) continue;
      if (o.texts && o.texts.length > 0) continue; // 带文本的另行分析
      const fill = o.fill && (o.fill.color || o.fill.scheme) || 'none';
      const key = o.shape + '|' + fill + '|' + bboxKey(o.bbox);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = clusters.find((c) => c.fill === fill && c.shape === o.shape
        && Math.abs(c.y - o.bbox[1]) <= 0.15 && Math.abs(c.h - o.bbox[3]) <= 0.15
        && Math.abs(c.x - o.bbox[0]) <= 0.3);
      if (hit) {
        hit.pages += 1;
        hit.ws.push(o.bbox[2]);
      } else {
        clusters.push({ shape: o.shape, fill, x: o.bbox[0], y: o.bbox[1], h: o.bbox[3], pages: 1, ws: [o.bbox[2]] });
      }
    }
  });
  const repeated = clusters
    .filter((c) => c.pages >= Math.min(3, pages.length))
    .sort((a, b) => b.pages - a.pages);

  // 3. 字号 → 档位：按频次与相对比例分桶，而非纯排名
  const sizeCount = {};
  pages.forEach((objs) => objs.forEach((o) => (o.texts || []).forEach((t) => {
    if (t.size) sizeCount[t.size] = (sizeCount[t.size] || 0) + 1;
  })));
  const pickMax = (lo, hi, exclude = new Set()) => {
    let best = null;
    for (const [s, c] of Object.entries(sizeCount)) {
      const n = Number(s);
      if (exclude.has(n)) continue;
      if (n >= lo && n <= hi && (!best || c > best.c)) best = { s: n, c };
    }
    return best ? best.s : null;
  };
  const body = pickMax(10, 20) || 15;
  const used = new Set([body]);
  const caption = pickMax(body * 0.7, body * 0.95, used) || r1(body * 0.9);
  used.add(caption);
  const footer = pickMax(6, caption * 0.95, used) || r1(caption * 0.9);
  used.add(footer);
  const eyebrow = pickMax(body * 1.02, body * 1.25, used) || r1(body * 1.1);
  used.add(eyebrow);
  const conclusion = pickMax(body * 1.25, body * 1.6, used) || r1(body * 1.4);
  used.add(conclusion);
  const pageTitle = pickMax(body * 1.6, body * 3, used) || r1(body * 2);
  used.add(pageTitle);
  const sectionTitle = pickMax(body * 1.6, body * 3.5, used) || r1(pageTitle * 1.2);
  used.add(sectionTitle);
  const display = pickMax(body * 3, body * 5, used) || r1(sectionTitle * 1.4);
  used.add(display);
  const sectionNo = pickMax(body * 5, 999, used) || r1(display * 2);
  const scale = { display, sectionNo, sectionTitle, pageTitle, conclusion, eyebrow, body, caption, footer };

  // 4. 标题槽位：内容页顶部大字号文本的最常见位置
  const titleBBoxes = {};
  pages.forEach((objs) => {
    for (const o of objs) {
      if (o.type !== 'shape' || !o.bbox || !(o.texts || []).length) continue;
      const big = o.texts.some((t) => t.size && t.size >= (scale.pageTitle || 24) * 0.8);
      if (big && o.bbox[1] < canvas.height * 0.3) {
        const key = bboxKey(o.bbox);
        titleBBoxes[key] = (titleBBoxes[key] || { count: 0, bbox: o.bbox });
        titleBBoxes[key].count += 1;
      }
    }
  });
  const titleSlot = Object.values(titleBBoxes).sort((a, b) => b.count - a.count)[0];

  // 5. 页脚：底部小字号文本，按 y+左右侧分桶计数（宽度随文字长度变化，不参与匹配）
  const footerGroups = {};
  pages.forEach((objs) => {
    const seen = new Set();
    for (const o of objs) {
      if (o.type !== 'shape' || !o.bbox || !(o.texts || []).length) continue;
      const small = o.texts.every((t) => !t.size || t.size <= (scale.footer || 12) * 1.2);
      if (!small || o.bbox[1] <= canvas.height * 0.88) continue;
      const key = r1(o.bbox[1]) + '|' + (o.bbox[0] < canvas.width / 2 ? 'L' : 'R');
      if (seen.has(key)) continue;
      seen.add(key);
      footerGroups[key] = footerGroups[key] || { count: 0, y: o.bbox[1], minX: o.bbox[0] };
      footerGroups[key].count += 1;
      footerGroups[key].minX = Math.min(footerGroups[key].minX, o.bbox[0]);
    }
  });
  const footers = Object.values(footerGroups).filter((f) => f.count >= Math.min(3, pages.length));

  // ---- palette 角色映射 ----
  const accents = [1, 2, 3, 4, 5, 6].map((i) => rawColors['accent' + i]).filter(Boolean);
  const sortedByLum = [...accents].sort((a, b) => luminance(a) - luminance(b));
  const palette = {
    bg: bgColor ? bgColor[0] : (rawColors.lt1 || 'FFFFFF'),
    surface: rawColors.lt2 || 'F5F5F5',
    primary: rawColors.accent1 || '1F4E79',
    primaryDeep: sortedByLum[0] && sortedByLum[0] !== rawColors.accent1 ? sortedByLum[0] : (rawColors.accent1 || '1F4E79'),
    accent: rawColors.accent2 || '2E86C1',
    secondary: rawColors.accent3 || rawColors.accent2 || '2E86C1',
    divider: rawColors.accent4 || 'D9D9D9',
    warn: 'C0392B',
    text: rawColors.dk1 || '333333',
    textMuted: rawColors.dk2 || '777777',
    textFaint: rawColors.dk2 || '999999',
    onDark: rawColors.lt1 || 'FFFFFF',
    onDarkMuted: rawColors.lt2 || 'EEEEEE',
  };

  // ---- 素材落盘到 staging ----
  const stagingId = crypto.randomBytes(8).toString('hex');
  const stagingDir = path.join(USER_DIR, '..', 'tmp', stagingId);
  fs.mkdirSync(path.join(stagingDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'source.pptx'), buffer);

  const savedImages = [];
  for (const target of [...new Set(bgImages)]) {
    const mediaName = 'ppt/media/' + path.basename(target);
    const file = zip.file(mediaName);
    if (!file) continue;
    const data = await file.async('nodebuffer');
    if (data.length > LIMITS.maxAssetSize) continue;
    const base = path.basename(target);
    fs.writeFileSync(path.join(stagingDir, 'assets', base), data);
    savedImages.push('assets/' + base);
  }

  // ---- 组装描述符草稿（以内置结构底板为底，按画布比例缩放，再覆盖提取结果）----
  const base = JSON.parse(JSON.stringify(BASE_DESCRIPTOR));
  delete base._dir; delete base._id;
  const ratio = canvas.width / base.canvas.width;
  const scaleRect = (r) => r.map((v, i) => r1(v * (i % 2 === 0 ? ratio : ratio))); // 16:9 同比例缩放
  const walkScale = (node) => {
    if (Array.isArray(node)) return node.map(walkScale);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'rect' && Array.isArray(v) && v.length === 4) out[k] = scaleRect(v);
        else if (k === 'at' && Array.isArray(v) && v.length === 2) out[k] = v.map((x) => r1(x * ratio));
        else out[k] = walkScale(v);
      }
      return out;
    }
    return node;
  };

  const descriptor = {
    ...walkScale(base),
    schemaVersion: '1.1',
    canvas,
    palette,
    meta: {
      id: stagingId,
      name: path.basename(filename, path.extname(filename)).slice(0, 30) || '上传模板',
      source: 'uploaded',
      licensing: { redistributable: false, commercialUse: 'unknown' },
      generalizationMode: 'conservative',
      confidence: {
        canvas: 1, palette: 1, typography: 0.9,
        background: savedImages.length > 0 || bgColor ? 0.85 : 0.5,
        decorations: repeated.length > 0 ? 0.7 : 0.4,
        families: savedImages.length > 0 ? 0.6 : 0.5,
        typeMapping: 0.4,
      },
    },
    typography: {
      fonts: { title: fonts.title.latin ? fonts.title : base.typography.fonts.title, body: fonts.body.latin ? fonts.body : base.typography.fonts.body, code: { latin: 'Consolas' } },
      fontFallback: {},
      scale,
    },
  };

  // 封面/章节页：应用满屏插画与渐变蒙版
  if (savedImages.length > 0) {
    descriptor.families.cover.variants.default.background = {
      color: 'bg', image: savedImages[0],
      overlays: overlayDrafts.length > 0
        ? overlayDrafts.slice(0, 1).map((g) => ({
            color: 'bg', direction: g.direction,
            stops: g.stops.map((s) => [s.pos, s.transparency]),
          }))
        : [{ color: 'bg', direction: 'horizontal', stops: [[0, 85], [1, 10]] }],
    };
    // 浅底插画上文字必须深色：覆盖 classic 底座的 onDark 配色与居中排版
    const cover = descriptor.families.cover.variants.default;
    cover.slots.title = { ...cover.slots.title, color: 'primary', align: 'left' };
    if (cover.slots.subtitle) cover.slots.subtitle = { ...cover.slots.subtitle, color: 'text', align: 'left' };
    cover.slots.eyebrow = {
      rect: [cover.slots.title.rect[0], r1(cover.slots.title.rect[1] - 0.6), cover.slots.title.rect[2], 0.5],
      size: 'eyebrow', color: 'secondary', bold: true, role: 'content', behavior: 'generate',
    };
    if (savedImages.length > 1) {
      descriptor.families.section.variants.default.background = {
        color: 'bg', images: savedImages.slice(1),
        overlay: { color: 'bg', direction: 'vertical', stops: [[0, 10], [1, 85]] },
      };
      const section = descriptor.families.section.variants.default;
      section.slots.title = { ...section.slots.title, color: 'primary', align: 'left' };
      if (section.slots.subtitle) section.slots.subtitle = { ...section.slots.subtitle, color: 'text', align: 'left' };
    }
  }

  // 标题槽位用实测位置
  if (titleSlot) {
    descriptor.components.pageTitle.slot.rect = titleSlot.bbox;
  }

  // 页脚用实测位置（取最左侧元素的 x 作为左边距）
  if (footers.length > 0) {
    descriptor.components.footer = {
      role: 'chrome', behavior: 'fixed',
      y: Math.max(...footers.map((f) => f.y)),
      marginX: Math.min(...footers.map((f) => f.minX)),
      size: 'footer', color: 'textFaint',
    };
    for (const fam of Object.values(descriptor.families)) {
      for (const v of Object.values(fam.variants || {})) {
        if (v.chrome && !v.chrome.includes('footer')) v.chrome.push('footer');
      }
    }
  }

  // 跨页重复形状 → 附加装饰（保持保守：仅记录，默认不启用）
  descriptor._extractNotes = {
    repeatedDecorations: repeated.slice(0, 8).map((c) => ({
      pages: c.pages, shape: c.shape, fill: c.fill,
      bbox: [c.x, c.y, r1(c.ws.reduce((a, b) => a + b, 0) / c.ws.length), c.h],
    })),
    overlayDetected: overlayDrafts.length > 0,
    footerDetected: footers.length > 0,
    titleSlotDetected: Boolean(titleSlot),
  };

  fs.writeFileSync(path.join(stagingDir, 'template.json'), JSON.stringify(descriptor, null, 2));

  // A descriptor captures broad tokens; the profile captures actual source
  // slides and baked chrome. Profile extraction is deliberately best-effort so
  // a browser-less machine can still save a conservative token template.
  let profile = null;
  let profileWarning = null;
  try {
    profile = await profileFromPptx(buffer, { stagingDir });
  } catch (err) {
    profileWarning = err.message;
  }

  // 确认面板用的 3 张样例场景
  const sampleScenes = buildSampleScenes(descriptor, stagingDir);

  return { stagingId, descriptor, sampleScenes, profile: profile ? { confidence: profile.extraction.confidence, roles: Object.keys(profile.roles) } : null, profileWarning };
}

function buildSampleScenes(descriptor, dir) {
  const d = JSON.parse(JSON.stringify(descriptor));
  delete d._extractNotes;
  d._dir = dir; d._id = 'staging';
  const samples = [
    { index: 0, type: 'title', title: '演示文稿标题', subtitle: '副标题示例文字' },
    { index: 1, type: 'section', title: '第一章节名', subtitle: '章节导语示例' },
    { index: 2, type: 'bullets', title: '页面标题', bullets: ['第一条要点内容', '第二条要点内容', '第三条要点内容'] },
  ];
  return resolve(d, samples, { title: '模板预览' }).slides;
}

// 保存确认后的模板：staging → templates/<id>/
function saveTemplate(stagingId, name) {
  const stagingDir = path.join(USER_DIR, '..', 'tmp', stagingId);
  if (!fs.existsSync(path.join(stagingDir, 'template.json'))) {
    throw new Error('提取结果不存在或已过期，请重新上传');
  }
  const id = 'u-' + stagingId;
  const target = path.join(USER_DIR, id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(stagingDir, target);
  const file = path.join(target, 'template.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.meta.id = id;
  if (name && name.trim()) d.meta.name = name.trim().slice(0, 30);
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return id;
}

module.exports = { extractFromPptx, saveTemplate, LIMITS };

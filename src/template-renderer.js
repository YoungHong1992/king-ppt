// Deterministic SVG renderer for an extracted template profile. The LLM writes
// the outline only; typography, fixed chrome, image frames, and geometry come
// from measured source slots + the derived token set, so a deck cannot drift
// page by page and stays legible on any source palette (light or dark).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readableOn } = require('./render-guard');

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const toDataUri = (file) => {
  if (!file || !fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};
const tok = (profile, key, fallback) => {
  const v = profile?.tokens?.[key];
  return v ? `#${String(v).replace('#', '')}` : fallback;
};
const px = (profile) => 1280 / num(profile?.canvas?.width, 13.333);
const fontPx = (pt) => Math.max(12, num(pt, 20) * 96 / 72);

// 均衡折行：把文本切成 k 行长度接近的行，而不是「前 k-1 行塞满、尾行剩孤字」。
// 同时保证：行首不出现收尾标点（，。、；：等挂在上一行行尾）、英文/数字单词不从中间断开、
// 超出容量时以 … 收尾且每行不超过 maxChars。
function lines(text, maxChars = 18, maxLines = 2) {
  const raw = String(text || '').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  if (raw.length <= maxChars) return [raw];
  const overflow = raw.length > maxChars * maxLines;
  const src = overflow ? raw.slice(0, maxChars * maxLines) : raw;
  const k = Math.min(maxLines, Math.ceil(src.length / maxChars));
  const base = Math.floor(src.length / k);
  let rem = src.length % k;
  const out = [];
  let pos = 0;
  for (let i = 0; i < k; i++) {
    let take = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    // 不要把拉丁单词/数字从中间切开：回退到词首（至少保留 4 个字符，避免死循环）
    if (pos + take < src.length && /[A-Za-z0-9]/.test(src[pos + take - 1]) && /[A-Za-z0-9]/.test(src[pos + take])) {
      let j = pos + take;
      while (j > pos + 4 && /[A-Za-z0-9]/.test(src[j - 1])) j--;
      if (j > pos + 3) take = j - pos;
    }
    out.push(src.slice(pos, pos + take));
    pos += take;
  }
  // 收尾标点不得出现在行首：挂回上一行行尾（标点为半宽，视觉不超框）
  for (let i = 1; i < out.length; i++) {
    while (out[i] && /^[，。、；：！？）》」』,.!:;?)]/.test(out[i])) {
      out[i - 1] += out[i][0];
      out[i] = out[i].slice(1);
    }
  }
  // 行尾不得悬挂开引号/开括号：推到下一行行首
  for (let i = 0; i < out.length - 1; i++) {
    while (out[i] && /["'“‘「『（《]$/.test(out[i]) && out[i].length > 1) {
      out[i + 1] = out[i].slice(-1) + out[i + 1];
      out[i] = out[i].slice(0, -1);
    }
  }
  if (overflow && out.length) out[out.length - 1] = `${out[out.length - 1].slice(0, -1)}…`;
  return out.filter(Boolean);
}
function bodyItems(section) {
  const items = String(section?.body || '').split('\n')
    .map((x) => x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((x) => x && !x.startsWith('>'));
  return items.slice(0, 5).map((x) => x.slice(0, 60));
}
function leadOf(section) {
  const line = String(section?.body || '').split('\n').find((l) => l.trim().startsWith('>'));
  return line ? line.replace(/^\s*>\s*/, '').trim() : '';
}
// Split a bullet into a bold lead + muted description at its first natural break.
function splitPoint(item) {
  const m = String(item || '').match(/^(.{2,16}?)[，：,:]\s*(.+)$/);
  return m ? { lead: m[1], desc: m[2] } : { lead: String(item || ''), desc: '' };
}
function asset(profile, templateDir, role) {
  const p = profile?.roles?.[role];
  return p?.asset ? toDataUri(path.join(templateDir, p.asset)) : null;
}
// 烘焙顶栏（内容页 chrome 图）里常带有模板自己的标记图形（如本模板的 2×2 橙色方格），
// 页面标题若从页边距起排就会压在标记上。这里解码 PNG 像素，在「标题带」内扫描
// 与背景差异大的标记色块，返回标题的安全起点（英寸）。任意上传模板通用：
// 没有标记、解码失败或图不是 PNG 时回退页边距 0.84。按文件路径+mtime 缓存。
const _insetCache = new Map();
function chromeTitleInset(assetPath, canvasW) {
  try {
    if (!assetPath || !fs.existsSync(assetPath)) return 0.84;
    const mtime = fs.statSync(assetPath).mtimeMs;
    const hit = _insetCache.get(assetPath);
    if (hit && hit.mtime === mtime) return hit.inset;
    const buf = fs.readFileSync(assetPath);
    if (buf.readUInt32BE(0) !== 0x89504e47) return 0.84;
    let pos = 8, w = 0, h = 0, ctype = 0;
    const idat = [];
    while (pos + 12 < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const data = buf.slice(pos + 8, pos + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
      else if (type === 'IDAT') idat.push(data);
      pos += 12 + len;
    }
    if (!w || (ctype !== 2 && ctype !== 6)) return 0.84;
    const ch = ctype === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const px = (x, y) => {
      const i = y * stride + x * ch;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    const bg = px(w - 1, 0); // 右上角像素即页面底色
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    let x1 = -1;
    const colLim = Math.floor(w * 0.15);
    const rowTop = Math.floor(h * 0.18);
    const rowBot = Math.floor(h * 0.75); // 只扫标题带：避开底栏装饰线
    for (let y = rowTop; y < Math.min(rowBot, h); y++) {
      let last = -1;
      for (let x = 0; x < colLim; x++) {
        if (dist(px(x, y), bg) > 120) last = x;
      }
      if (last > x1) x1 = last;
    }
    const iconRightIn = x1 < 0 ? 0 : (x1 + 1) * (canvasW / w);
    const inset = Math.min(Math.max(0.84, iconRightIn + 0.14), canvasW * 0.3);
    _insetCache.set(assetPath, { mtime, inset });
    return inset;
  } catch { return 0.84; }
}
function fontFamily(profile, raw) {
  const s = String(raw || '');
  if (s.startsWith('+mj')) return profile?.invariants?.fontFamilies?.title || profile?.invariants?.fonts?.[0] || 'Microsoft YaHei';
  if (s.startsWith('+mn')) return profile?.invariants?.fontFamilies?.body || profile?.invariants?.fonts?.[1] || 'Microsoft YaHei';
  return raw || profile?.invariants?.fonts?.[0] || 'Microsoft YaHei';
}
// Rough text width in viewBox px (CJK ~ 1em, latin ~ 0.56em) — used to size the
// exported text frame so PowerPoint never re-wraps a line (preview == export).
function estTextWpx(text, fsPx) {
  let u = 0;
  for (const ch of String(text)) u += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.56;
  return u * fsPx;
}
function textLine(x, y, value, { size = 16, fill = '#000', family = 'Microsoft YaHei', bold = false, anchor = 'start', boxWpx, opacity } = {}) {
  if (value === '' || value == null) return '';
  const fsPx = fontPx(size);
  const w = (boxWpx != null && boxWpx > 0) ? boxWpx : estTextWpx(value, fsPx) * 1.08 + 12;
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" data-box-w="${w.toFixed(1)}" font-family="${esc(family)}" font-size="${fsPx.toFixed(1)}" font-weight="${bold ? '700' : '400'}" fill="${fill}"${opacity != null ? ` fill-opacity="${opacity}"` : ''} text-anchor="${anchor}">${esc(value)}</text>`;
}
function textBlock(profile, xIn, yIn, wIn, value, opts = {}) {
  const scale = px(profile);
  const { size = 16, maxLines = 2, ...rest } = opts;
  const fs2 = fontPx(size);
  const boxWpx = wIn * scale;
  const maxChars = Math.max(6, Math.floor(boxWpx / (fs2 * 0.92)));
  return lines(value, maxChars, maxLines)
    .map((ln, i) => textLine(xIn * scale, yIn * scale + i * fs2 * 1.25, ln, { ...rest, size, family: rest.family || fontFamily(profile), boxWpx }))
    .join('');
}
function textAtSlot(slot, profile, value, { maxLines = 2, fallbackColor, maxSize } = {}) {
  if (!slot || !value) return '';
  const scale = px(profile);
  const [xIn, yIn, wIn, hIn] = slot.rect || [1, 1, 8, 1];
  const slotWpx = wIn * scale;
  // The measured slot size can be absurd (bake sometimes picks a giant
  // decorative number as the "title"). Clamp it, then shrink-to-fit so a longer
  // generated heading never overflows its box (no more page-wide titles).
  let ptSize = Number(slot.size) || 24;
  if (maxSize && ptSize > maxSize) ptSize = maxSize;
  let fs2 = fontPx(ptSize);
  const minPx = fontPx(14);
  while (fs2 > minPx && estTextWpx(value, fs2) > slotWpx * maxLines) fs2 -= 2;
  ptSize = fs2 * 72 / 96;
  const align = slot.align === 'center' ? 'middle' : slot.align === 'right' ? 'end' : 'start';
  const x = align === 'middle' ? (xIn + wIn / 2) * scale : align === 'end' ? (xIn + wIn) * scale : xIn * scale;
  const y0 = (yIn) * scale + Math.min(hIn * scale, fs2) * 0.82;
  const family = fontFamily(profile, slot.font);
  const fill = slot.color ? `#${String(slot.color).replace('#', '')}` : (fallbackColor || tok(profile, 'ink', '#111'));
  const maxChars = Math.max(6, Math.floor(slotWpx / (fs2 * 0.92)));
  return lines(value, maxChars, maxLines)
    .map((ln, i) => textLine(x, y0 + i * fs2 * 1.2, ln, { size: ptSize, fill, family, bold: slot.bold, anchor: align, boxWpx: Math.max(slotWpx, estTextWpx(ln, fs2) * 1.08 + 12) }))
    .join('');
}
const rect = (profile, xIn, yIn, wIn, hIn, { fill, opacity, rx = 0, stroke, sw = 0 } = {}) => {
  const s = px(profile);
  return `<rect x="${(xIn * s).toFixed(1)}" y="${(yIn * s).toFixed(1)}" width="${(wIn * s).toFixed(1)}" height="${(hIn * s).toFixed(1)}"`
    + `${rx ? ` rx="${(rx * s).toFixed(1)}"` : ''}${fill ? ` fill="${fill}"` : ' fill="none"'}${opacity != null ? ` fill-opacity="${opacity}"` : ''}`
    + `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}/>`;
};
// A small deterministic line icon (rounded square + dot) to add card density.
function geoIcon(profile, xIn, yIn, sIn, color) {
  const s = px(profile);
  return rect(profile, xIn, yIn, sIn, sIn, { stroke: color, sw: 1.6, rx: 0.05 })
    + `<circle cx="${((xIn + sIn / 2) * s).toFixed(1)}" cy="${((yIn + sIn / 2) * s).toFixed(1)}" r="${(sIn * 0.16 * s).toFixed(1)}" fill="${color}"/>`;
}
// Shared page footer: a thin rule, a left walk label, and NN / TT page numbers.
function footerChrome(profile, { index, total, left, bodyFont, muted }) {
  const scale = px(profile);
  const W = profile.canvas.width;
  const footY = profile.canvas.height - 0.46;
  const bx = 0.84;
  const pageNo = `${String(index + 1).padStart(2, '0')} / ${String(total || index + 1).padStart(2, '0')}`;
  return rect(profile, bx, footY - 0.22, W - bx * 2, 0.014, { fill: muted, opacity: 0.3 })
    + textLine((W - 0.84) * scale, footY * scale, pageNo, { size: 12.5, fill: muted, family: bodyFont, anchor: 'end' })
    + (left ? textLine(bx * scale, footY * scale, String(left).slice(0, 34), { size: 12, fill: muted, family: bodyFont }) : '');
}

// ---------- content page: token-driven card system + bottom conclusion ----------
function renderContent(profile, templateDir, section, index, total, imageData) {
  const scale = px(profile);
  const W = profile.canvas.width;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const muted = tok(profile, 'muted', '#94A3B8');
  const panel = tok(profile, 'panel', '#131C30');
  const accent = tok(profile, 'accent', '#38BDF8');
  const accent2 = tok(profile, 'accent2', '#F59E0B');
  const cardAccents = [accent, accent2]; // blue + amber alternation
  const bodyFontRaw = profile.invariants.fonts[1] || profile.invariants.fonts[0] || 'Microsoft YaHei';
  const bodyFont = esc(String(bodyFontRaw).startsWith('+') ? fontFamily(profile, bodyFontRaw) : bodyFontRaw);

  const role = profile.roles.content;
  const chrome = asset(profile, templateDir, 'content');
  // 标题起点避开烘焙顶栏里的模板标记图形（图标在左的模板，标题从图标右侧起排）。
  const titleX = chromeTitleInset(role.asset ? path.join(templateDir, role.asset) : null, W);
  // The measured content-title slot is unreliable (bake can pick a giant
  // decorative number elsewhere on the page as the "title"). Anchor the page
  // title on the baked top-bar at a page-title size; keep the measured
  // color/font when present.
  const barH = Number(role.hIn) || 1.3;
  const titleSlot = {
    rect: [titleX, Math.max(0.24, barH / 2 - 0.36), W - titleX - 0.84, 0.72],
    size: Math.min(Math.max(Number(role.slot && role.slot.size) || 26, 20), 30),
    color: readableOn(bg, role.slot && role.slot.color, [ink]), bold: true, align: 'left', font: role.slot && role.slot.font,
  };
  const tslot = titleSlot.rect;
  const title = textAtSlot(titleSlot, profile, section.heading, { maxLines: 1, fallbackColor: ink, maxSize: 30 });
  // Title underline (template cue) instead of a left tick.
  const underline = rect(profile, tslot[0], tslot[1] + tslot[3] + 0.04, 1.15, 0.045, { fill: accent });

  const [bx, by, bw] = role.bodyRect || [0.85, 1.6, W - 1.7, 0];
  const allItems = bodyItems(section);
  // 多行引用（诗/词/口诀）→ 诗文面板模式：诗行整体入面板，不再被截成一句当金句条。
  const quoteLines = String(section?.body || '').split('\n')
    .filter((l) => /^\s*>/.test(l))
    .map((l) => l.replace(/^\s*>\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const verse = quoteLines.length >= 3;
  // 「标签：」式空说明行（如「诗文：」「齐诵名句：」）不配成卡片——它的内容在引用块里。
  const labeled = allItems.filter((it) => !(!splitPoint(it).desc && /[:：]\s*$/.test(it.trim())));
  const items = labeled.length ? labeled : allItems;

  // Structure: N-1 cards up top + the last point as a bottom conclusion bar
  // (the source deck ends content pages with an emphasized takeaway strip).
  let cards = items;
  let conclusion = verse ? '' : leadOf(section);
  if (!conclusion && !verse && items.length >= 3) { conclusion = items[items.length - 1]; cards = items.slice(0, items.length - 1); }

  const footY = profile.canvas.height - 0.46;
  const calloutH = 0.98;
  const calloutY = conclusion ? footY - 0.42 - calloutH : footY - 0.3;
  let bandBottom = conclusion ? calloutY - 0.32 : footY - 0.3;
  const cardTop = by;

  // 诗文面板：版心带底部一整条，accent 左条 + 诗行双栏（列优先保持阅读顺序）
  let versePanel = '';
  if (verse) {
    const vPt = 16;
    const vLineH = (fontPx(vPt) * 1.55) / scale;
    const vCols = quoteLines.length > 4 ? 2 : 1;
    const vRows = Math.ceil(quoteLines.length / vCols);
    const vPad = 0.3;
    const verseH = vRows * vLineH + vPad * 2;
    const verseY = footY - 0.3 - verseH;
    bandBottom = verseY - 0.3;
    versePanel = rect(profile, bx, verseY, bw, verseH, { fill: panel, rx: 0.06 })
      + rect(profile, bx, verseY, 0.1, verseH, { fill: accent2 });
    const colW = (bw - 1.1) / vCols;
    quoteLines.forEach((ln, i) => {
      const col = Math.floor(i / vRows);
      const row = i % vRows;
      versePanel += textLine((bx + 0.55 + col * (colW + 0.4)) * scale, (verseY + vPad + (row + 0.74) * vLineH) * scale, ln.slice(0, 30), { size: vPt, fill: ink, family: bodyFont, boxWpx: colW * scale });
    });
  }
  const bandH = bandBottom - cardTop;

  let parts = '';
  const n = Math.min(Math.max(cards.length, 1), 4);
  if (n === 1 && !conclusion) {
    // Single point with no takeaway → a centered key-message statement.
    const cardH = Math.min(bandH, 2.4);
    const top = cardTop + Math.max(0, (bandH - cardH) / 2);
    parts += rect(profile, bx, top, bw, cardH, { fill: panel, rx: 0.06 });
    parts += rect(profile, bx, top, bw, 0.09, { fill: accent });
    parts += textLine((bx + 0.55) * scale, (top + 0.95) * scale, '01', { size: 32, fill: accent, family: bodyFont, bold: true });
    const sp = splitPoint(cards[0]);
    parts += textBlock(profile, bx + 0.55, top + 1.55, bw - 1.1, sp.desc ? sp.lead : cards[0], { size: 24, maxLines: 1, fill: ink, family: bodyFont, bold: true });
    if (sp.desc) parts += textBlock(profile, bx + 0.55, top + 2.12, bw - 1.1, sp.desc, { size: 18, maxLines: 1, fill: muted, family: bodyFont });
  } else {
    const gap = 0.28;
    const cardW = (bw - gap * (n - 1)) / n;
    const size = n >= 3 ? 16 : 17.5;
    const fs2 = fontPx(size);
    const maxChars = Math.max(6, Math.floor(((cardW - 0.64) * scale) / (fs2 * 0.92)));
    const descLineH = (fs2 * 1.3) / scale;
    const leadLineH = (fontPx(size + 1.5) * 1.25) / scale;
    // 卡片高度随内容自适应（下限 2.7，上限撑满版心带），整行在带内垂直居中：
    // 内容少时不再出现「满高卡片下半截空白」，内容多时依然填满整带。
    const headH = 1.42; // 编号/图标区高度（lead 基线在卡顶 +1.42 处）
    const padBottom = 0.30;
    const splits = cards.map((c) => splitPoint(c));
    const need = splits.map((sp, i) => {
      if (sp.desc) {
        const nDesc = lines(sp.desc, maxChars, 4).length;
        return headH + leadLineH + 0.16 + nDesc * descLineH + padBottom;
      }
      const nLines = lines(cards[i] || '', maxChars, 4).length;
      return headH + nLines * ((fontPx(size + 1) * 1.3) / scale) + padBottom;
    });
    const cardH = Math.min(bandH, Math.max(2.7, ...need));
    const rowTop = cardTop + (bandH - cardH) * 0.45;
    for (let i = 0; i < n; i++) {
      const x = bx + i * (cardW + gap);
      const ac = cardAccents[i % cardAccents.length];
      parts += rect(profile, x, rowTop, cardW, cardH, { fill: panel, rx: 0.06 });
      parts += rect(profile, x, rowTop, cardW, 0.09, { fill: ac }); // unified top accent bar
      parts += textLine((x + 0.32) * scale, (rowTop + 0.85) * scale, String(i + 1).padStart(2, '0'), { size: 27, fill: ac, family: bodyFont, bold: true });
      parts += geoIcon(profile, x + cardW - 0.62, rowTop + 0.34, 0.32, ac);
      const sp = splits[i];
      if (sp.desc) {
        const maxDesc = Math.max(1, Math.min(4, Math.floor((cardH - 1.95 - 0.22) / descLineH)));
        // 装不下时先降字号重排（每档 1.5pt，下限 13pt），把「末字变 …」换成一个更小的完整段落
        let dSize = size;
        const dLen = sp.desc.replace(/\s+/g, '').length;
        const fitsAt = (pt) => dLen <= Math.max(6, Math.floor(((cardW - 0.64) * scale) / (fontPx(pt) * 0.92))) * maxDesc;
        while (dSize > 13 && !fitsAt(dSize)) dSize -= 1.5;
        // lead 一行放不下时降字号（下限 13pt）而不是打省略号
        let lSize = size + 1.5;
        const leadLen = sp.lead.replace(/\s+/g, '').length;
        const leadFits = (pt) => leadLen <= Math.max(6, Math.floor(((cardW - 0.64) * scale) / (fontPx(pt) * 0.92)));
        while (lSize > 13 && !leadFits(lSize)) lSize -= 1.5;
        parts += textBlock(profile, x + 0.32, rowTop + 1.42, cardW - 0.62, sp.lead, { size: lSize, maxLines: 1, fill: ink, family: bodyFont, bold: true });
        parts += textBlock(profile, x + 0.32, rowTop + 1.95, cardW - 0.62, sp.desc, { size: dSize, maxLines: maxDesc, fill: muted, family: bodyFont });
      } else {
        parts += textBlock(profile, x + 0.32, rowTop + 1.45, cardW - 0.62, cards[i] || '', { size: size + 1, maxLines: 4, fill: ink, family: bodyFont });
      }
    }
  }

  // Bottom conclusion bar: amber left edge + bold takeaway (source signature).
  if (conclusion) {
    parts += rect(profile, bx, calloutY, bw, calloutH, { fill: panel, rx: 0.06 });
    parts += rect(profile, bx, calloutY, 0.1, calloutH, { fill: accent2 });
    const sp = splitPoint(conclusion);
    parts += textBlock(profile, bx + 0.4, calloutY + 0.42, bw - 0.8, sp.desc ? `${sp.lead}　${sp.desc}` : conclusion, { size: 18, maxLines: 2, fill: ink, family: bodyFont, bold: true });
  }
  parts += versePanel;

  const chap = section.chapter ? `${section.chapter.no}  ${section.chapter.title}` : '';
  const kicker = section.chapter
    ? textLine((W - 0.84) * scale, (tslot[1] + 0.52) * scale, `${section.chapter.no} · ${section.chapter.title}`.slice(0, 22), { size: 14, fill: accent, family: bodyFont, anchor: 'end' })
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, profile.canvas.height, { fill: bg })
    + (chrome ? `<image x="0" y="0" width="1280" height="${(role.hIn * scale).toFixed(1)}" href="${chrome}"/>` : '')
    + parts + underline + title + kicker
    + footerChrome(profile, { index, total, left: chap, bodyFont, muted })
    + `</svg>`;
}

// 大纲正文行 → 可上版面的干净文案：去列表符/加粗符/引用符，剥离「副标题：」「主视觉：」
// 这类元数据标签（主视觉/关键词等纯制作指令整行丢弃，不泄露到观众看到的页面上）。
function cleanLine(l) {
  return String(l || '').replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').replace(/^\s*>\s*/, '').trim();
}
function unlabel(s) {
  const m = String(s || '').match(/^([\u4e00-\u9fa5A-Za-z]{2,6})\s*[:：]\s*(.+)$/);
  if (!m) return s;
  if (/^(主视觉|视觉|配图|插图|意象|画面|核心关键词|关键词)$/.test(m[1])) return '';
  return m[2].trim();
}

// ---------- cover: full-bleed illustration + three-level title stack ----------
function renderCover(profile, templateDir, section, imageData, docTitle) {
  const W = profile.canvas.width; const H = profile.canvas.height;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const muted = tok(profile, 'muted', '#94A3B8');
  const accent2 = tok(profile, 'accent2', '#F59E0B');
  const frame = profile.roles.cover;
  const image = imageData || asset(profile, templateDir, 'cover');
  const slots = frame?.slots || {};
  const scale = px(profile);
  const title = docTitle || section.heading;
  const bodyTexts = [...(section.intro || []), ...String(section.body || '').split('\n')]
    .map(cleanLine).map(unlabel).filter(Boolean);
  const sub = bodyTexts[0] || (section.heading && section.heading !== title ? section.heading : '');
  const tagline = bodyTexts[1] || '';

  const tx = slots.title?.rect?.[0] ?? 0.73;
  const y = slots.title?.rect?.[1] ?? (H * 0.42);
  const maxW = W - tx - 0.9; // 右侧留给画面主体
  // 「主标题——副题」是中文封面常见结构：破折号前作大字主标，后作次级副题。
  const dash = title.match(/^(.+?)\s*——+\s*(.+)$/);
  const main = dash ? dash[1] : title;
  const suffix = dash ? dash[2] : '';

  // 两段式锚定：主标/副题锚在 title 槽位，副标题锚在 subtitle 槽位（正好落回模板
  // 自带的标题框里），两组互不推挤；无槽位时按前一行行距顺排。主标最低 30pt。
  let mainPt = Math.min(Number(slots.title?.size) || 44, 44);
  while (mainPt > 30 && estTextWpx(main, fontPx(mainPt)) > maxW * scale) mainPt -= 2;
  const mainH = fontPx(mainPt) / scale;
  const mainBase = y + mainH * 0.82;
  let sufPt = 0;
  if (suffix) {
    sufPt = 22;
    while (sufPt > 14 && estTextWpx(suffix, fontPx(sufPt)) > maxW * scale) sufPt -= 2;
  }
  const sufBase = suffix ? mainBase + mainH * 0.30 + (fontPx(sufPt) / scale) * 0.92 : 0;
  const subPt = 18;
  const subSlot = slots.subtitle?.rect;
  const subAsc = (fontPx(subPt) / scale) * 0.95;
  const minSubBase = (suffix ? sufBase + (fontPx(sufPt) / scale) * 0.30 : mainBase + mainH * 0.30) + 0.14;
  const subBaseCand = subSlot ? subSlot[1] + subAsc : minSubBase;
  const showSub = Boolean(sub) && subBaseCand < H - 0.4;
  const subBase = showSub ? Math.max(subBaseCand, minSubBase) : 0;
  const tagBase = (showSub ? subBase + (fontPx(subPt) / scale) * 0.40 : (suffix ? sufBase + (fontPx(sufPt) / scale) * 0.30 : mainBase + mainH * 0.30)) + 0.34;
  // 烤底封面自带装饰（眉条/色块），叠加金句条会飘进画面中段且对比度不可控——
  // 烤底走极简三行栈；AI 生图封面是干净画布，才画 tick + 金句条补足层次。
  const showTag = Boolean(tagline) && Boolean(imageData) && tagBase < H - 0.35;

  let parts = '';
  if (imageData) {
    parts += rect(profile, tx, y - 0.36, 1.9, 0.035, { fill: accent2 });
  }
  parts += textLine(tx * scale, mainBase * scale, main, { size: mainPt, fill: ink, family: fontFamily(profile, '+mj'), bold: true, boxWpx: maxW * scale });
  if (suffix) parts += textLine(tx * scale, sufBase * scale, suffix, { size: sufPt, fill: accent2, family: fontFamily(profile, '+mj'), bold: true, boxWpx: maxW * scale });
  if (showSub) parts += textLine(tx * scale, subBase * scale, sub, { size: subPt, fill: muted, family: fontFamily(profile), boxWpx: maxW * scale });
  if (showTag) {
    parts += rect(profile, tx, tagBase - 0.26, 0.055, 0.34, { fill: accent2 });
    parts += textLine((tx + 0.2) * scale, tagBase * scale, tagline, { size: 15, fill: ink, family: fontFamily(profile), bold: true, boxWpx: maxW * scale });
  }

  const scrimImg = profile.scrim ? toDataUri(path.join(templateDir, profile.scrim)) : null;
  const scrim = scrimImg
    ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="none" href="${scrimImg}"/>`
    : rect(profile, 0, H * 0.46, W, H * 0.54, { fill: bg, opacity: 0.5 });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + parts
    + `</svg>`;
}

// ---------- section divider: illustration + oversized number + bilingual eyebrow ----------
function renderSection(profile, templateDir, section, index, total, imageData) {
  const scale = px(profile);
  const W = profile.canvas.width; const H = profile.canvas.height;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const muted = tok(profile, 'muted', '#94A3B8');
  const accent = tok(profile, 'accent', '#38BDF8');
  const bodyFont = esc(fontFamily(profile));
  const image = imageData || asset(profile, templateDir, 'section');
  const slots = profile.roles.section?.slots || {};
  const no = section.sectionNo || String(Math.max(1, index)).padStart(2, '0');
  const chapterTitle = String(section.heading || '').replace(/^第[一二三四五六七八九十百\d]+[章节]\s*[:：]?\s*/, '');
  const cnChapter = section.heading?.match(/^(第[一二三四五六七八九十百\d]+[章节])/)?.[1] || `第 ${no} 章`;
  const eyebrow = `CHAPTER ${no} · ${cnChapter}`;
  const lead = leadOf(section) || String(section.body || '').split('\n').map((l) => l.replace(/^\s*[-*>]\s*/, '').trim()).filter(Boolean)[0] || '';

  const scrimImg = profile.scrim ? toDataUri(path.join(templateDir, profile.scrim)) : null;
  const scrim = !image ? ''
    : scrimImg
      ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="none" href="${scrimImg}"/>`
      : rect(profile, 0, 0, W, H, { fill: bg, opacity: 0.42 });
  // 巨大章节序号 = 右下角半透明水印，垫在文字层之下（绘制顺序在 scrim 之后、文字之前）。
  // 不再使用 bake 测得的 sectionNo 槽位——那槽位与左侧文字栈在长标题下必然相撞。
  const numberEl = textLine((W - 0.62) * scale, (H * 0.78) * scale, no, { size: 170, fill: accent, family: fontFamily(profile, '+mj'), bold: true, anchor: 'end', opacity: 0.26 });

  const tx = 0.84;
  const eyebrowY = H * 0.6;
  // 眉题行首短杠（不与标题竖向争空间——旧版横贯线会穿过章标题字形）
  const eyebrowBar = rect(profile, tx, eyebrowY - 0.15, 0.30, 0.05, { fill: accent });
  const eyebrowEl = textLine((tx + 0.46) * scale, eyebrowY * scale, eyebrow, { size: 16, fill: accent, family: bodyFont, bold: true });
  const titleEl = textBlock(profile, tx, eyebrowY + 0.62, W * 0.6, chapterTitle, { size: 38, maxLines: 2, fill: ink, family: fontFamily(profile, '+mj'), bold: true });
  const leadEl = lead ? textBlock(profile, tx, eyebrowY + 1.58, W * 0.55, lead, { size: 17, maxLines: 2, fill: muted, family: bodyFont }) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + numberEl + eyebrowBar + eyebrowEl + titleEl + leadEl
    + footerChrome(profile, { index, total, left: cnChapter, bodyFont, muted })
    + `</svg>`;
}

// ---------- closing ----------
function renderClosing(profile, templateDir, section, index, imageData, docTitle) {
  const W = profile.canvas.width; const H = profile.canvas.height;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const muted = tok(profile, 'muted', '#94A3B8');
  const accent = tok(profile, 'accent', '#38BDF8');
  const image = imageData || asset(profile, templateDir, 'closing');
  // 收尾主文案：优先引用块里的名句（> 行），其次第一条干净正文行，最后页标题。
  const bodyTexts = String(section.body || '').split('\n').map(cleanLine).map(unlabel).filter(Boolean);
  const title = leadOf(section) || bodyTexts[0] || section.heading || '谢谢观看';
  const sub = docTitle && docTitle !== title ? docTitle : (bodyTexts[1] || '');
  const scrim = image ? rect(profile, 0, 0, W, H, { fill: bg, opacity: 0.45 }) : '';
  const scale = px(profile);
  const tick = rect(profile, W / 2 - 0.28, H * 0.42, 0.56, 0.09, { fill: accent });
  // 落款跟在标题实际行数之后（两行名句时自动下移，绝不叠字）
  const tFs = fontPx(40);
  const titleLines = lines(title, Math.max(8, Math.floor(((W - 2) * scale) / (tFs * 0.92))), 2);
  const titleBase = H * 0.52;
  const subBase = titleBase + ((titleLines.length - 1) * tFs * 1.25) / scale + 0.55;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + tick
    + textBlock(profile, W / 2, titleBase, W - 2, title, { size: 40, maxLines: 2, fill: ink, family: fontFamily(profile, '+mj'), bold: true, anchor: 'middle' })
    + (sub && subBase < H - 0.4 ? textLine((W / 2) * px(profile), subBase * px(profile), sub, { size: 15, fill: muted, family: fontFamily(profile), anchor: 'middle' }) : '')
    + `</svg>`;
}

function renderTemplateSlide({ profile, templateDir, section, role, index, total, imageData, docTitle }) {
  if (role === 'cover') return renderCover(profile, templateDir, section, imageData, docTitle);
  if (role === 'section') return renderSection(profile, templateDir, section, index, total, imageData);
  if (role === 'closing') return renderClosing(profile, templateDir, section, index, imageData, docTitle);
  if (!profile?.roles?.content) return null;
  return renderContent(profile, templateDir, section, index, total, imageData);
}

module.exports = { renderTemplateSlide, bodyItems, lines };

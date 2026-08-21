// Deterministic SVG renderer for an extracted template profile. The LLM writes
// the outline only; typography, fixed chrome, image frames, and geometry come
// from measured source slots + the derived token set, so a deck cannot drift
// page by page and stays legible on any source palette (light or dark).
const fs = require('fs');
const path = require('path');

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

function lines(text, maxChars = 18, maxLines = 2) {
  const raw = String(text || '').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < maxLines; i += maxChars) out.push(raw.slice(i, i + maxChars));
  if (raw.length > maxChars * maxLines) out[out.length - 1] = `${out[out.length - 1].slice(0, -1)}…`;
  return out;
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
function textLine(x, y, value, { size = 16, fill = '#000', family = 'Microsoft YaHei', bold = false, anchor = 'start', boxWpx } = {}) {
  if (value === '' || value == null) return '';
  const fsPx = fontPx(size);
  const w = (boxWpx != null && boxWpx > 0) ? boxWpx : estTextWpx(value, fsPx) * 1.08 + 12;
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" data-box-w="${w.toFixed(1)}" font-family="${esc(family)}" font-size="${fsPx.toFixed(1)}" font-weight="${bold ? '700' : '400'}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
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
function textAtSlot(slot, profile, value, { maxLines = 2, fallbackColor } = {}) {
  if (!slot || !value) return '';
  const scale = px(profile);
  const [xIn, yIn, wIn, hIn] = slot.rect || [1, 1, 8, 1];
  const size = slot.size;
  const fs2 = fontPx(size);
  const align = slot.align === 'center' ? 'middle' : slot.align === 'right' ? 'end' : 'start';
  const x = align === 'middle' ? (xIn + wIn / 2) * scale : align === 'end' ? (xIn + wIn) * scale : xIn * scale;
  const y0 = (yIn) * scale + Math.min(hIn * scale, fs2) * 0.82;
  const family = fontFamily(profile, slot.font);
  const fill = slot.color ? `#${String(slot.color).replace('#', '')}` : (fallbackColor || tok(profile, 'ink', '#111'));
  const slotWpx = wIn * scale;
  const maxChars = Math.max(6, Math.floor(slotWpx / (fs2 * 0.92)));
  return lines(value, maxChars, maxLines)
    .map((ln, i) => textLine(x, y0 + i * fs2 * 1.2, ln, { size, fill, family, bold: slot.bold, anchor: align, boxWpx: Math.max(slotWpx, estTextWpx(ln, fs2) * 1.08 + 12) }))
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
  const tslot = role.slot?.rect || [0.84, 0.71, 10, 0.67];
  const title = textAtSlot(role.slot, profile, section.heading, { maxLines: 1, fallbackColor: ink });
  // Title underline (template cue) instead of a left tick.
  const underline = rect(profile, tslot[0], tslot[1] + tslot[3] + 0.08, 1.15, 0.045, { fill: accent });

  const [bx, by, bw] = role.bodyRect || [0.85, 1.6, W - 1.7, 0];
  const allItems = bodyItems(section);
  const lead = leadOf(section);

  // Structure: N-1 cards up top + the last point as a bottom conclusion bar
  // (the source deck ends content pages with an emphasized takeaway strip).
  let cards = allItems;
  let conclusion = lead;
  if (!conclusion && allItems.length >= 3) { conclusion = allItems[allItems.length - 1]; cards = allItems.slice(0, allItems.length - 1); }

  const footY = profile.canvas.height - 0.46;
  const calloutH = 0.98;
  const calloutY = conclusion ? footY - 0.42 - calloutH : footY - 0.3;
  const bandBottom = conclusion ? calloutY - 0.32 : footY - 0.3;
  const cardTop = by;
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
    const lineH = fs2 * 1.3 / scale;
    const cardH = bandH; // fill the body band so the page is never head-heavy
    for (let i = 0; i < n; i++) {
      const x = bx + i * (cardW + gap);
      const ac = cardAccents[i % cardAccents.length];
      parts += rect(profile, x, cardTop, cardW, cardH, { fill: panel, rx: 0.06 });
      parts += rect(profile, x, cardTop, cardW, 0.09, { fill: ac }); // unified top accent bar
      parts += textLine((x + 0.32) * scale, (cardTop + 0.85) * scale, String(i + 1).padStart(2, '0'), { size: 27, fill: ac, family: bodyFont, bold: true });
      parts += geoIcon(profile, x + cardW - 0.62, cardTop + 0.34, 0.32, ac);
      const sp = splitPoint(cards[i]);
      if (sp.desc) {
        parts += textBlock(profile, x + 0.32, cardTop + 1.42, cardW - 0.62, sp.lead, { size: size + 1.5, maxLines: 1, fill: ink, family: bodyFont, bold: true });
        parts += textBlock(profile, x + 0.32, cardTop + 1.95, cardW - 0.62, sp.desc, { size, maxLines: 4, fill: muted, family: bodyFont });
      } else {
        parts += textBlock(profile, x + 0.32, cardTop + 1.45, cardW - 0.62, cards[i] || '', { size: size + 1, maxLines: 4, fill: ink, family: bodyFont });
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

// ---------- cover: full-bleed illustration + three-level title stack ----------
function renderCover(profile, templateDir, section, imageData) {
  const W = profile.canvas.width; const H = profile.canvas.height;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const muted = tok(profile, 'muted', '#94A3B8');
  const accent = tok(profile, 'accent', '#38BDF8');
  const accent2 = tok(profile, 'accent2', '#F59E0B');
  const frame = profile.roles.cover;
  const image = imageData || asset(profile, templateDir, 'cover');
  const slots = frame?.slots || {};
  const title = section.heading;
  const bodyLines = String(section.body || '').split('\n').map((l) => l.replace(/^\s*[-*>]\s*/, '').trim()).filter(Boolean);
  const sub = bodyLines[0] || '';
  const tagline = bodyLines[1] || '';

  const titleY = slots.title?.rect?.[1] ?? (H * 0.62);
  const titleX = slots.title?.rect?.[0] ?? 0.73;
  const scale = px(profile);
  // Smooth gradient overlay mask (baked PNG) — falls back to a flat scrim only if absent.
  const scrimImg = profile.scrim ? toDataUri(path.join(templateDir, profile.scrim)) : null;
  const scrim = scrimImg
    ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="none" href="${scrimImg}"/>`
    : rect(profile, 0, H * 0.46, W, H * 0.54, { fill: bg, opacity: 0.5 });
  const tick = rect(profile, titleX, titleY - 0.34, 1.9, 0.035, { fill: accent2 });
  // Third level: a bold highlight tagline with an amber edge (source has this).
  const subBottom = (slots.subtitle?.rect?.[1] ?? titleY + 1.0) + (slots.subtitle?.rect?.[3] ?? 0.45) + 0.28;
  const taglineEl = tagline
    ? rect(profile, titleX, subBottom, 0.06, 0.34, { fill: accent2 })
      + textLine((titleX + 0.22) * scale, (subBottom + 0.3) * scale, tagline, { size: 15, fill: ink, family: fontFamily(profile), bold: true })
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + tick
    + textAtSlot(slots.title ? { ...slots.title, bold: true } : null, profile, title, { maxLines: 2, fallbackColor: ink })
    + textAtSlot(slots.subtitle ? { ...slots.subtitle, color: (profile.tokens?.muted || 'CBD5E1') } : null, profile, sub, { maxLines: 2, fallbackColor: muted })
    + taglineEl
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
  const numberEl = slots.sectionNo
    ? textAtSlot({ ...slots.sectionNo, color: profile.tokens.accent, bold: true }, profile, no, { maxLines: 1, fallbackColor: accent })
    : textLine((W - 1.0) * scale, (H * 0.58) * scale, no, { size: 150, fill: accent, family: fontFamily(profile, '+mj'), bold: true, anchor: 'end' });

  const tx = 0.84;
  const eyebrowY = H * 0.6;
  const tick = rect(profile, tx, eyebrowY + 0.3, 3.4, 0.03, { fill: accent });
  const eyebrowEl = textLine(tx * scale, eyebrowY * scale, eyebrow, { size: 16, fill: accent, family: bodyFont, bold: true });
  const titleEl = textBlock(profile, tx, eyebrowY + 0.62, W * 0.6, chapterTitle, { size: 38, maxLines: 2, fill: ink, family: fontFamily(profile, '+mj'), bold: true });
  const leadEl = lead ? textBlock(profile, tx, eyebrowY + 1.58, W * 0.55, lead, { size: 17, maxLines: 2, fill: muted, family: bodyFont }) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + numberEl + tick + eyebrowEl + titleEl + leadEl
    + footerChrome(profile, { index, total, left: cnChapter, bodyFont, muted })
    + `</svg>`;
}

// ---------- closing ----------
function renderClosing(profile, templateDir, section, index, imageData) {
  const W = profile.canvas.width; const H = profile.canvas.height;
  const bg = tok(profile, 'bg', '#0B1120');
  const ink = tok(profile, 'ink', '#F1F5F9');
  const accent = tok(profile, 'accent', '#38BDF8');
  const image = imageData || asset(profile, templateDir, 'closing');
  const title = section.body ? String(section.body).split('\n').map((l) => l.replace(/^\s*[-*>]\s*/, '').trim()).filter(Boolean)[0] : (section.heading || '谢谢观看');
  const scrim = image ? rect(profile, 0, 0, W, H, { fill: bg, opacity: 0.45 }) : '';
  const tick = rect(profile, W / 2 - 0.28, H * 0.42, 0.56, 0.09, { fill: accent });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`
    + rect(profile, 0, 0, W, H, { fill: bg })
    + (image ? `<image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${image}"/>` : '')
    + scrim + tick
    + textBlock(profile, W / 2, H * 0.52, W - 2, title, { size: 44, maxLines: 2, fill: ink, family: fontFamily(profile, '+mj'), bold: true, anchor: 'middle' })
    + `</svg>`;
}

function renderTemplateSlide({ profile, templateDir, section, role, index, total, imageData, docTitle }) {
  if (role === 'cover') return renderCover(profile, templateDir, section, imageData);
  if (role === 'section') return renderSection(profile, templateDir, section, index, total, imageData);
  if (role === 'closing') return renderClosing(profile, templateDir, section, index, imageData);
  if (!profile?.roles?.content) return null;
  return renderContent(profile, templateDir, section, index, total, imageData);
}

module.exports = { renderTemplateSlide, bodyItems, lines };

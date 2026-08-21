// Deterministic SVG renderer for an extracted template profile. The LLM writes
// the outline only; typography, fixed chrome, image frames, and geometry come
// from measured source slots so a deck cannot drift page by page.
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
const color = (profile, key, fallback) => {
  if (typeof key === 'string' && profile?.tokens?.[key]) return `#${profile.tokens[key].replace('#', '')}`;
  const item = profile?.invariants?.palette?.[key];
  return item?.hex ? `#${item.hex}` : fallback;
};
const px = (profile) => 1280 / num(profile?.canvas?.width, 13.333);
const fontPx = (pt) => Math.max(16, num(pt, 20) * 96 / 72);

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
  return items.slice(0, 4).map((x) => x.slice(0, 42));
}
function asset(profile, templateDir, role) {
  const p = profile?.roles?.[role];
  return p?.asset ? toDataUri(path.join(templateDir, p.asset)) : null;
}
function textAt(slot, profile, value, { maxLines = 2, fallbackFont, fallbackColor } = {}) {
  if (!slot || !value) return '';
  const scale = px(profile);
  const [xIn, yIn, wIn, hIn] = slot.rect || [1, 1, 8, 1];
  const fs = fontPx(slot.size);
  const align = slot.align === 'center' ? 'middle' : slot.align === 'right' ? 'end' : 'start';
  const x = align === 'middle' ? (xIn + wIn / 2) * scale : align === 'end' ? (xIn + wIn) * scale : xIn * scale;
  const y0 = (yIn + Math.min(hIn, fs / scale) * 0.82) * scale;
  const rawFamily = slot.font || fallbackFont || profile?.invariants?.fonts?.[0] || 'Microsoft YaHei';
  const family = String(rawFamily).startsWith('+mj') ? (profile?.invariants?.fontFamilies?.title || 'Microsoft YaHei')
    : String(rawFamily).startsWith('+mn') ? (profile?.invariants?.fontFamilies?.body || 'Microsoft YaHei') : rawFamily;
  const fill = slot.color ? `#${slot.color.replace('#', '')}` : (fallbackColor || color(profile, 'primary', '#2B4C7E'));
  return lines(value, Math.max(8, Math.floor((wIn * scale) / Math.max(fs * 0.9, 1))), maxLines)
    .map((line, i) => `<text x="${x.toFixed(1)}" y="${(y0 + i * fs * 1.2).toFixed(1)}" data-box-w="${(wIn * scale).toFixed(1)}" data-box-h="${(hIn * scale).toFixed(1)}" font-family="${esc(family)}" font-size="${fs.toFixed(1)}" font-weight="${slot.bold ? '700' : '400'}" fill="${fill}" text-anchor="${align}">${esc(line)}</text>`).join('');
}

function renderContent(profile, templateDir, section, index, imageData) {
  const role = profile.roles.content;
  const scale = px(profile);
  const bg = color(profile, 'bg', '#F7F1E5');
  const primary = color(profile, 'primary', '#2B4C7E');
  const accent = color(profile, 'accent', '#E2703A');
  const secondary = color(profile, 'secondary', '#5B8A72');
  const surface = color(profile, 'surface', '#EFE6D2');
  const chrome = asset(profile, templateDir, 'content');
  const title = textAt(role.slot, profile, section.heading, { maxLines: 1, fallbackFont: profile.invariants.fonts[0], fallbackColor: primary });
  const [bx, by, bw, bh] = role.bodyRect || [0.85, 1.7, profile.canvas.width - 1.7, profile.canvas.height - 2.5];
  const items = bodyItems(section);
  const bodyFont = esc(profile.invariants.fonts[1] || profile.invariants.fonts[0] || 'Microsoft YaHei');
  const textEl = (x, y, value, size = 17, fill = primary, anchor = 'start') => `<text x="${(x * scale).toFixed(1)}" y="${(y * scale).toFixed(1)}" font-family="${bodyFont}" font-size="${fontPx(size).toFixed(1)}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
  const wrap = (value, max = 26) => lines(value, max, 2).join(' ');
  const variant = index % 4;
  let content = '';
  if (variant === 0) {
    // Three horizontal story beats, matching the reference's low-density row.
    const count = Math.min(3, Math.max(items.length, 1));
    const gap = 0.18, w = (bw - gap * (count - 1)) / count, y = by + 0.55;
    content = items.slice(0, count).map((item, i) => {
      const x = bx + i * (w + gap);
      return `<rect x="${(x * scale).toFixed(1)}" y="${(y * scale).toFixed(1)}" width="${(w * scale).toFixed(1)}" height="${(1.45 * scale).toFixed(1)}" rx="6" fill="${surface}"/>`
        + `<rect x="${(x * scale).toFixed(1)}" y="${(y * scale).toFixed(1)}" width="${(w * scale).toFixed(1)}" height="${(0.16 * scale).toFixed(1)}" fill="${i % 2 ? secondary : accent}"/>`
        + textEl(x + 0.22, y + 0.52, String(i + 1).padStart(2, '0'), 20, i % 2 ? secondary : accent)
        + textEl(x + 0.22, y + 0.93, wrap(item, 18), 16, primary);
    }).join('') + `<rect x="${(bx * scale).toFixed(1)}" y="${((y + 2.05) * scale).toFixed(1)}" width="${(bw * scale).toFixed(1)}" height="${(0.58 * scale).toFixed(1)}" fill="${primary}"/>`
      + textEl(bx + bw / 2, y + 2.42, '把一个观点，讲成一条清晰的线', 18, '#F7F1E5', 'middle');
  } else if (variant === 1) {
    // Two-column contrast: useful for before/after, cause/response, or two ideas.
    const colW = (bw - 0.34) / 2;
    content = [0, 1].map((col) => {
      const x = bx + col * (colW + 0.34);
      const colItems = items.slice(col * 2, col * 2 + 2);
      return `<rect x="${(x * scale).toFixed(1)}" y="${(by * scale).toFixed(1)}" width="${(colW * scale).toFixed(1)}" height="${(3.1 * scale).toFixed(1)}" fill="${col ? '#EFE6D2' : '#FBF7EE'}"/>`
        + `<rect x="${(x * scale).toFixed(1)}" y="${(by * scale).toFixed(1)}" width="${(colW * scale).toFixed(1)}" height="${(0.18 * scale).toFixed(1)}" fill="${col ? secondary : primary}"/>`
        + colItems.map((item, i) => textEl(x + 0.26, by + 0.78 + i * 0.92, `${i + 1}. ${wrap(item, 22)}`, 16, primary)).join('');
    }).join('');
  } else if (variant === 2) {
    // A horizontal timeline gives process-oriented pages a different silhouette.
    const count = Math.min(4, Math.max(items.length, 1));
    const step = bw / count;
    content = `<line x1="${(bx * scale).toFixed(1)}" y1="${((by + 1.2) * scale).toFixed(1)}" x2="${((bx + bw) * scale).toFixed(1)}" y2="${((by + 1.2) * scale).toFixed(1)}" stroke="${secondary}" stroke-width="4"/>`
      + items.slice(0, count).map((item, i) => {
        const x = bx + step * i + step / 2;
        return `<circle cx="${(x * scale).toFixed(1)}" cy="${((by + 1.2) * scale).toFixed(1)}" r="${(0.16 * scale).toFixed(1)}" fill="${i % 2 ? secondary : accent}"/>`
          + textEl(x, by + 0.62, String(i + 1).padStart(2, '0'), 18, primary, 'middle')
          + textEl(x, by + 1.82, wrap(item, 15), 15, primary, 'middle');
      }).join('');
  } else {
    // Quote plus evidence: preserves breathing room for reflective pages.
    const quote = items[0] || section.heading;
    content = `<rect x="${(bx * scale).toFixed(1)}" y="${(by * scale).toFixed(1)}" width="${(4.05 * scale).toFixed(1)}" height="${(3.25 * scale).toFixed(1)}" fill="${primary}"/>`
      + textEl(bx + 0.38, by + 0.88, '“', 54, '#F7F1E5')
      + textEl(bx + 0.42, by + 1.55, wrap(quote, 16), 20, '#F7F1E5')
      + items.slice(1, 4).map((item, i) => textEl(bx + 4.65, by + 0.72 + i * 0.78, `• ${wrap(item, 30)}`, 17, primary)).join('');
  }
  const imageSlot = role.imageSlot && role.imageSlot.rect;
  const useImage = Boolean(imageData && imageSlot);
  const image = useImage ? `<rect x="${((imageSlot[0] - 0.08) * scale).toFixed(1)}" y="${((imageSlot[1] - 0.08) * scale).toFixed(1)}" width="${((imageSlot[2] + 0.16) * scale).toFixed(1)}" height="${((imageSlot[3] + 0.16) * scale).toFixed(1)}" rx="10" fill="${accent}" fill-opacity="0.25"/><image x="${(imageSlot[0] * scale).toFixed(1)}" y="${(imageSlot[1] * scale).toFixed(1)}" width="${(imageSlot[2] * scale).toFixed(1)}" height="${(imageSlot[3] * scale).toFixed(1)}" preserveAspectRatio="xMidYMid slice" href="${imageData}"/>` : '';
  const footer = `<text x="${(profile.canvas.width * scale - 48).toFixed(1)}" y="680" font-family="Microsoft YaHei" font-size="16" fill="${primary}" fill-opacity="0.42" text-anchor="end">${String(index + 1).padStart(2, '0')}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${bg}"/>${chrome ? `<image x="0" y="0" width="1280" height="${(role.hIn * scale).toFixed(1)}" href="${chrome}"/>` : ''}${image}${content}${title}${footer}</svg>`;
}

function renderTemplateSlide({ profile, templateDir, section, role, index, total, imageData }) {
  if (!profile?.roles?.[role]) return null;
  if (role === 'content') return renderContent(profile, templateDir, section, index, imageData);
  const frame = profile.roles[role];
  const base = asset(profile, templateDir, role);
  if (!base) return null;
  const slots = frame.slots || {};
  const primary = color(profile, 'primary', '#2B4C7E');
  const chapterTitle = String(section.heading || '').replace(/^第[一二三四五六七八九十百\d]+[章节]\s*[:：]?\s*/, '');
  const title = role === 'closing' ? (section.body || section.heading || '谢谢观看') : role === 'section' ? chapterTitle : section.heading;
  const sub = role === 'section' ? (section.body || '').replace(/\n/g, ' ') : role === 'cover' ? (section.body || '') : '';
  const no = section.sectionNo || String(Math.max(1, index)).padStart(2, '0');
  const scale = px(profile);
  const r = frame.imageSlot?.rect;
  const generatedImage = imageData && r ? `<image x="${(r[0] * scale).toFixed(1)}" y="${(r[1] * scale).toFixed(1)}" width="${(r[2] * scale).toFixed(1)}" height="${(r[3] * scale).toFixed(1)}" preserveAspectRatio="xMidYMid slice" href="${imageData}"/>` : '';
  const coverBand = role === 'cover' && slots.subtitle
    ? `<rect x="${(slots.subtitle.rect[0] * scale).toFixed(1)}" y="${(slots.subtitle.rect[1] * scale).toFixed(1)}" width="${(slots.subtitle.rect[2] * scale).toFixed(1)}" height="${(slots.subtitle.rect[3] * scale).toFixed(1)}" fill="${primary}"/>`
    : '';
  const subtitleSlot = role === 'cover' && slots.subtitle ? { ...slots.subtitle, color: 'F7F1E5' } : (slots.subtitle || slots.author);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><image x="0" y="0" width="1280" height="720" href="${base}"/>${generatedImage}${coverBand}${slots.sectionNo ? textAt(slots.sectionNo, profile, no, { maxLines: 1, fallbackColor: primary }) : ''}${textAt(slots.title || slots.quote, profile, title, { maxLines: role === 'cover' ? 2 : 1, fallbackColor: primary })}${textAt(subtitleSlot, profile, sub, { maxLines: 1, fallbackColor: primary })}</svg>`;
}

module.exports = { renderTemplateSlide, bodyItems, lines };

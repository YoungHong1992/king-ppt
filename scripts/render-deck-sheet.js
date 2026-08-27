// QA: render a saved deck (from /api/deck JSON) into a contact sheet PNG.
// Usage: node scripts/render-deck-sheet.js <deck.json> <out.png>
const fs = require('fs');
const path = require('path');
const htmlShot = require('../src/html-shot');

const deckFile = process.argv[2] || '.tmp-e2e-deck.json';
const outFile = process.argv[3] || path.join('exports', 'deck-contact.png');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const st = JSON.parse(fs.readFileSync(deckFile, 'utf8'));
  const slides = st.slides || [];
  const dir = path.join(path.dirname(outFile), 'slides');
  fs.mkdirSync(dir, { recursive: true });
  const pngs = [];
  for (let i = 0; i < slides.length; i++) {
    const svg = slides[i] && slides[i].svg;
    if (!svg) { console.log(`slide ${i + 1}: no svg`); continue; }
    const sized = svg.replace(/^<svg\s/i, '<svg width="1280" height="720" ');
    const png = await htmlShot.renderToPng(`<div style="width:1280px;height:720px;overflow:hidden">${sized}</div>`, { width: 1280, height: 720, scale: 2 });
    const f = path.join(dir, `s${i + 1}.png`);
    fs.writeFileSync(f, png);
    pngs.push({ f, slide: slides[i] });
  }
  const cols = 4;
  const cellW = 384;
  const rows = Math.ceil(pngs.length / cols);
  const cells = pngs.map((p, i) => {
    const url = 'file:///' + path.resolve(p.f).replace(/\\/g, '/');
    const cap = `${i + 1}. ${esc((p.slide && p.slide.role) || '')} · ${esc((p.slide && p.slide.title) || '')}`;
    return `<figure style="margin:0"><img src="${url}" style="width:${cellW}px;height:${Math.round(cellW * 9 / 16)}px;display:block;border:1px solid #e5e5e5"><figcaption style="font:13px sans-serif;padding:5px 2px;color:#333">${cap}</figcaption></figure>`;
  }).join('');
  const html = `<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:18px;padding:18px;background:#fafafa">${cells}</div>`;
  const W = cols * cellW + (cols + 1) * 18;
  const H = rows * (Math.round(cellW * 9 / 16) + 32) + (rows + 1) * 18 + 8;
  const sheet = await htmlShot.renderToPng(html, { width: W, height: H, scale: 1 });
  fs.writeFileSync(outFile, sheet);
  console.log(`contact sheet → ${outFile} (${pngs.length} slides)`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

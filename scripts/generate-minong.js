// Deterministically generate a 悯农-themed deck that follows an uploaded template.
//
// It reuses the engine end-to-end (profileFromPptx → splitOutline →
// renderTemplateSlide → buildPptx) — the same "engineering code" the product
// runs — with no LLM in the loop. Imagery is the template's OWN baked chrome
// (cover / section / closing backgrounds + the content top-bar), which is 16:9
// and therefore lands in the 16:9 slide frame at its native aspect: never
// stretched, never re-compressed (bytes pass through pptxgenjs verbatim).
//
// Beyond generating, it renders a QA contact sheet (SVG→PNG via the same
// headless Chrome the baker uses, so preview == export) and audits every image
// embedded in the exported .pptx: intrinsic size vs. on-slide display size
// (distortion check) and a byte-hash vs. the source asset (re-compression check).
//
// Usage:
//   node scripts/generate-minong.js [--ref <template.pptx>] [--out <dir>]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { profileFromPptx } = require('../src/template-profile');
const { renderTemplateSlide } = require('../src/template-renderer');
const { scoreDeck } = require('../src/style-score');
const { buildPptx } = require('../src/pptx');
const { splitOutline, generateSlideImage } = require('../src/generate-deck');
const htmlShot = require('../src/html-shot');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const has = (name) => process.argv.includes(name);
const REF = path.resolve(arg('--ref', path.join(process.cwd(), 'AI工作分享PPT_20260717_003232.pptx')));
const OUT = path.resolve(arg('--out', path.join(process.cwd(), 'exports', '悯农')));
const STAGING = path.join(OUT, '.staging');
const GEN_DIR = path.join(OUT, 'generated');
const EMU_PER_IN = 914400;

// Image generation for the cover + chapter dividers (首页 / 目录页). On by
// default; --no-images falls back to the template's own baked chrome.
// Generated illustrations are cached to <out>/generated so re-runs don't re-pay,
// and are cropped to 16:9 by the engine (coverCropDataUri) so export never
// stretches. --regen-images forces a fresh call.
const IMAGES_ON = !has('--no-images');
const REGEN = has('--regen-images');
const IMAGE_ROLES = ['cover', 'section', 'closing'];
const IMAGE_POLICY = {
  enabled: true,
  roles: IMAGE_ROLES,
  size: '1024x1024',
  // 悯农 art direction tuned to the template's own palette (cream paper / indigo
  // navy / terracotta orange) so generated art sits in the same visual world.
  prompt: '中国传统农耕主题的现代编辑插画：金黄稻田与层叠梯田，头戴斗笠的农人在烈日下弯腰劳作，'
    + '远处青山，米粒与土地的质感；米白宣纸底色，靛蓝与赭橙点缀，柔和自然光，扁平矢量风格带细微颗粒，'
    + '安静而充满敬意，大面积留白，16:9 宽幅构图；no text, no letters, no logos, no UI',
};

// 悯农 (Li Shen, Tang). Cover + two chapters (each: a divider + content pages) +
// a closing. Content bullets use a "lead：description" shape so the renderer's
// card system fills each page; every content page carries a "> " takeaway that
// becomes the bottom conclusion bar — matching the source deck's page rhythm.
const MARKDOWN = `# 悯农

## 悯农
- 唐 · 李绅
- 一粥一饭，读懂粮食背后的时间、劳作与敬畏

## 第一章：一粒米的来处
> 从春种到秋收，一粒米要走过整整一季的光阴。

## 春种：把希望埋进土里
- 深耕：翻开沉睡的土地，为种子备好温床
- 选种：一粒饱满的种子，是一季收成的起点
- 守时：顺着节气耕作，不误农时不负春
> 春天种下的每一个动作，都是写给秋天的承诺。

## 夏长：在风雨里守望
- 灌溉：秧苗最渴的时候，一瓢水就是一次托举
- 除害：与虫草争夺阳光，日复一日不敢松懈
- 抗灾：一场骤雨，可能改写一整季的收成
> 丰收从不是理所当然，而是无数次守候的回报。

## 第二章：一饭的分量
> 当我们端起饭碗，也在与土地、节气与劳作重逢。

## 谁知盘中餐，粒粒皆辛苦
- 时间：一粒米，凝结着长达数月的等待
- 汗水：锄禾日当午，弯下的是脊背，挺起的是生活
- 敬意：珍惜粮食，是对劳动最朴素的尊重
> 看见食物的来处，才懂得碗里的分量。

## 节约：从一碗饭开始
- 按需取餐：让每一份食物都被好好吃完
- 光盘行动：不是委屈自己，而是善待他人的劳动
- 言传身教：把珍惜，写进孩子的日常
> 节约不是口号，而是可以从今天践行的选择。

## 结语：把敬意留在每一餐
> 一粥一饭，当思来处不易；一丝一缕，恒念物力维艰。
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fileToDataUri = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

// Cover / divider illustration for one slide. Reuses the engine's
// generateSlideImage (prompt build → model call → crop to 16:9), caches the
// cropped PNG to disk for reuse, and returns an inline data URI (or null →
// caller falls back to the template's baked chrome).
async function imageForSlide(role, index, section, docTitle) {
  if (!IMAGES_ON || !IMAGE_ROLES.includes(role)) return null;
  const cache = path.join(GEN_DIR, `${role}-${index + 1}.png`);
  if (fs.existsSync(cache) && !REGEN) { console.log(`  · ${role} #${index + 1}: 复用缓存图`); return fileToDataUri(cache); }
  const data = await generateSlideImage({ role, index, docTitle, section, policy: IMAGE_POLICY });
  if (!data) { console.log(`  · ${role} #${index + 1}: 生图失败/未配置 → 回退模板底图`); return null; }
  const m = data.match(/^data:image\/\w+;base64,(.+)$/);
  if (m) { fs.mkdirSync(GEN_DIR, { recursive: true }); fs.writeFileSync(cache, Buffer.from(m[1], 'base64')); }
  console.log(`  · ${role} #${index + 1}: 生成 16:9 插画 ✓`);
  return data;
}

// SVG string → PNG file via headless Chrome. Both the browser preview and this
// QA render consume the exact same sanitized SVG the exporter compiles, so what
// the contact sheet shows is what the .pptx contains.
async function svgToPng(svg, file, scale = 2) {
  const sized = svg.replace(/^<svg\s/i, '<svg width="1280" height="720" ');
  const html = `<div style="width:1280px;height:720px;overflow:hidden">${sized}</div>`;
  const png = await htmlShot.renderToPng(html, { width: 1280, height: 720, scale });
  fs.writeFileSync(file, png);
}

async function contactSheet(pngFiles, labels, file) {
  const cols = 4;
  const cellW = 384;
  const rows = Math.ceil(pngFiles.length / cols);
  const cells = pngFiles.map((f, i) => `<figure style="margin:0">`
    + `<img src="file:///${f.replace(/\\/g, '/')}" style="width:${cellW}px;height:${Math.round(cellW * 9 / 16)}px;display:block;border:1px solid #e5e5e5;box-shadow:0 1px 3px rgba(0,0,0,.12)">`
    + `<figcaption style="font:13px/1.4 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;padding:5px 2px;color:#333">${i + 1}. ${esc(labels[i])}</figcaption>`
    + `</figure>`).join('');
  const html = `<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:18px;padding:18px;background:#fafafa">${cells}</div>`;
  const width = cols * cellW + (cols + 1) * 18;
  const height = rows * (Math.round(cellW * 9 / 16) + 32) + (rows + 1) * 18 + 8;
  const png = await htmlShot.renderToPng(html, { width, height, scale: 1 });
  fs.writeFileSync(file, png);
}

// --- image intrinsic size sniffers (no native deps) ---
function pngSize(b) { return b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null; }
function jpgSize(b) {
  if (!(b[0] === 0xFF && b[1] === 0xD8)) return null;
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
const imgSize = (b) => pngSize(b) || jpgSize(b);

// Audit every <p:pic> in the exported deck: does its on-slide box match the
// image's real aspect ratio (→ no stretch), and do its bytes match the source
// asset we fed in (→ no re-compression)?
async function auditPptx(pptxFile, sourceHashes) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxFile));
  const media = {};
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/media\//.test(name) || zip.files[name].dir) continue;
    const buf = await zip.file(name).async('nodebuffer');
    media[name.replace(/^ppt\//, '')] = { size: imgSize(buf), bytes: buf.length, hash: crypto.createHash('sha1').update(buf).digest('hex') };
  }
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const pics = [];
  for (const sn of slideNames) {
    const xml = await zip.file(sn).async('text');
    const relsName = sn.replace(/slides\//, 'slides/_rels/') + '.rels';
    const rels = zip.file(relsName) ? await zip.file(relsName).async('text') : '';
    const relMap = {};
    for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2].replace(/^\.\.\//, '');
    for (const block of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
      const b = block[0];
      const rid = (b.match(/r:embed="([^"]+)"/) || [])[1];
      const target = relMap[rid];
      const ext = b.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
      const src = b.match(/<a:srcRect([^/>]*)\/>/);
      const stretch = /<a:stretch>/.test(b);
      const pct = (attr) => { const mm = src && src[1].match(new RegExp(`${attr}="(-?\\d+)"`)); return mm ? Number(mm[1]) / 100000 : 0; };
      pics.push({
        slide: Number(sn.match(/(\d+)/)[1]), target,
        cx: ext ? Number(ext[1]) : null, cy: ext ? Number(ext[2]) : null,
        crop: src ? { l: pct('l'), r: pct('r'), t: pct('t'), b: pct('b') } : null,
        stretch: stretch && !src,
      });
    }
  }
  // evaluate
  const rows = pics.map((p) => {
    const info = media[p.target] || {};
    const dim = info.size;
    const dispAspect = p.cx && p.cy ? p.cx / p.cy : null;
    let srcAspect = null;
    let verdict = 'unknown';
    if (dim) {
      const cw = dim.w * (1 - (p.crop ? p.crop.l + p.crop.r : 0));
      const ch = dim.h * (1 - (p.crop ? p.crop.t + p.crop.b : 0));
      srcAspect = cw / ch;
      if (dispAspect) {
        const drift = Math.abs(dispAspect - srcAspect) / srcAspect;
        verdict = drift <= 0.02 ? 'OK (aspect preserved)' : `STRETCHED (${(drift * 100).toFixed(1)}% aspect drift)`;
      }
    }
    const srcHash = sourceHashes[info.hash];
    return {
      slide: p.slide, target: p.target,
      intrinsic: dim ? `${dim.w}x${dim.h}` : '?',
      displayIn: p.cx ? `${(p.cx / EMU_PER_IN).toFixed(2)}x${(p.cy / EMU_PER_IN).toFixed(2)}in` : '?',
      mode: p.stretch ? 'stretch-fill' : p.crop ? 'cover-crop' : 'as-is',
      verdict,
      recompressed: srcHash ? `NO (byte-identical to ${srcHash})` : 'unmatched (check)',
      kb: (info.bytes / 1024).toFixed(0),
    };
  });
  return { mediaCount: Object.keys(media).length, pics: rows };
}

(async () => {
  if (!fs.existsSync(REF)) throw new Error(`模板不存在: ${REF}`);
  // Rebuild everything except the generated-image cache (regenerating art is the
  // slow/paid step; keep it unless --regen-images).
  for (const p of [STAGING, path.join(OUT, 'slides'), path.join(OUT, 'contact-sheet.png'), path.join(OUT, '悯农.pptx'), path.join(OUT, 'report.json')]) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  if (REGEN) fs.rmSync(GEN_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });

  console.log('› 画像提取（烘焙模板底图）…');
  const profile = await profileFromPptx(fs.readFileSync(REF), { stagingDir: STAGING });

  console.log('› 切页…');
  const { title, sections } = splitOutline(MARKDOWN);
  console.log(`› 生成封面/章节页插画（生图：${IMAGES_ON ? '开' : '关'}）…`);
  const slides = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const imageData = await imageForSlide(s.role, i, s, title);
    slides.push({
      role: s.role,
      title: s.heading,
      svg: renderTemplateSlide({ profile, templateDir: STAGING, section: s, role: s.role, index: i, total: sections.length, imageData }),
    });
  }

  const score = scoreDeck({ profile, slides });

  console.log('› 编译为可编辑 .pptx（SVG→原生形状）…');
  const pptxBuf = await buildPptx(slides, title, 'reference-profile', { canvas: profile.canvas });
  const pptxFile = path.join(OUT, '悯农.pptx');
  fs.writeFileSync(pptxFile, Buffer.from(pptxBuf));

  console.log('› 渲染 QA 单页 PNG + 拼版…');
  const slidesDir = path.join(OUT, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  const pngFiles = [];
  for (let i = 0; i < slides.length; i++) {
    const f = path.join(slidesDir, `slide-${i + 1}.png`);
    await svgToPng(slides[i].svg, f);
    pngFiles.push(f);
  }
  await contactSheet(pngFiles, sections.map((s) => `${s.role} · ${s.heading}`), path.join(OUT, 'contact-sheet.png'));

  // Hash the assets we fed in, so the audit can prove the exported bytes are the
  // same PNGs (no re-encode). Baked chrome lives in <staging>/assets.
  const sourceHashes = {};
  for (const dir of [path.join(STAGING, 'assets'), GEN_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const label = path.basename(dir) === 'generated' ? 'generated' : 'assets';
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const h = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex');
      sourceHashes[h] = `${label}/${f}`;
    }
  }
  console.log('› 审计导出图片（拉伸 / 压缩）…');
  const audit = await auditPptx(pptxFile, sourceHashes);

  const report = {
    reference: REF,
    output: pptxFile,
    canvas: profile.canvas,
    tokens: profile.tokens,
    slideCount: slides.length,
    slides: slides.map((s, i) => ({ n: i + 1, role: s.role, title: s.title })),
    styleScore: { score: score.score, threshold: score.threshold, pass: score.pass, consistency: score.dimensions?.contentConsistency, dimensions: score.dimensions },
    imageAudit: audit,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n===== 生成完成 =====');
  console.log(`PPTX     : ${pptxFile}`);
  console.log(`拼版预览 : ${path.join(OUT, 'contact-sheet.png')}`);
  console.log(`风格评分 : ${score.score}/100 (阈值 ${score.threshold}, ${score.pass ? '通过' : '未过'}), 一致性 ${score.dimensions?.contentConsistency}%`);
  console.log(`画布     : ${profile.canvas.width}x${profile.canvas.height} in, tokens=${JSON.stringify(profile.tokens)}`);
  console.log('\n----- 图片审计（每个导出图元）-----');
  for (const r of audit.pics) {
    console.log(`slide ${r.slide} | ${r.target} | 原始 ${r.intrinsic} → 显示 ${r.displayIn} | ${r.mode} | ${r.verdict} | 压缩: ${r.recompressed} | ${r.kb}KB`);
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });

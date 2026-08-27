// Usage: node scripts/benchmark-template-style.js <reference.pptx> <output-dir>
// A repeatable regression harness: it scores the former free-SVG route against
// the extracted-template route using the same "悯农" content and writes an
// auditable before/after report plus an editable PPTX.
const fs = require('fs');
const path = require('path');
const { profileFromPptx } = require('../src/template-profile');
const { renderTemplateSlide } = require('../src/template-renderer');
const { scoreDeck } = require('../src/style-score');
const { buildPptx } = require('../src/pptx');
const { loadTheme, loadThemeLayouts } = require('../src/descriptor');
const { buildSpec } = require('../src/spec');
const { splitOutline, generateSlideSvg } = require('../src/generate-deck');

const ref = process.argv[2];
const outDir = process.argv[3] || path.join(process.cwd(), '.tmp-style-eval', 'run');
const generatedDir = process.argv.includes('--generated-images-dir')
  ? process.argv[process.argv.indexOf('--generated-images-dir') + 1] : null;
if (!ref || !fs.existsSync(ref)) throw new Error('请传入有效的参考 PPTX 路径');
fs.mkdirSync(outDir, { recursive: true });

const markdown = `# 悯农

## 悯农
- 读懂一粒米背后的时间、劳作与敬畏
- 李绅《悯农》主题分享

## 第一章：一粒米的来处
> 从春种到秋收，每一粒米都经历漫长等待。

## 春种：汗滴落进土地
- 锄禾不是一个瞬间，而是与节令同行的日常
- 太阳越高，农人的身影越低
- 泥土记得每一次弯腰与守候

## 夏长：风雨守住希望
- 秧苗需要水，也需要及时的照料
- 一场风雨，可能改变一季收成
- 丰收从来不是理所当然

## 第二章：一饭的分量
> 当我们端起饭碗，也应看见粮食抵达餐桌前的长路。

## 谁知盘中餐，粒粒皆辛苦
- 节约不是克制生活，而是尊重劳动
- 按需取餐，让每一份食物被好好完成
- 珍惜粮食，是每个人都能践行的温柔

## 把敬意留在每一餐
- 从今天的一碗饭开始，不负耕耘，不负时光
`;

// Reproduces the previous mode's unconstrained composition without making the
// regression suite dependent on a remote model. Pass --live-baseline to ask
// the configured model for the former free-SVG behavior instead.
function legacyFreeSvg(section, role) {
  const title = String(section.heading || '').replace(/[<&>]/g, '');
  const points = String(section.body || '').split('\n').filter(Boolean).slice(0, 3)
    .map((x) => x.replace(/^[-*>\s]+/, '').slice(0, 30));
  const rows = points.map((p, i) => `<text x="110" y="${310 + i * 82}" font-family="Arial" font-size="28" fill="#333333">${p}</text>`).join('');
  const bg = role === 'section' || role === 'closing' ? '#1F4E79' : '#FFFFFF';
  const fg = role === 'section' || role === 'closing' ? '#FFFFFF' : '#1F4E79';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${bg}"/><rect x="80" y="190" width="110" height="6" fill="#2E86C1"/><text x="80" y="160" font-family="Arial" font-size="58" fill="${fg}">${title}</text>${rows}</svg>`;
}

(async () => {
  const profile = await profileFromPptx(fs.readFileSync(ref), { stagingDir: outDir });
  const { title, sections } = splitOutline(markdown);
  // 工程不再内置模板；仅 --live-baseline 需要一个主题/spec，从 --theme <已上传模板id> 取。
  const themeId = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1] : null;
  const liveBaseline = process.argv.includes('--live-baseline');
  let spec = null;
  if (themeId) spec = buildSpec(loadTheme(themeId), loadThemeLayouts(themeId));
  if (liveBaseline && !spec) throw new Error('--live-baseline 需要 --theme <已上传模板 id>');

  const baseline = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const svg = liveBaseline
      ? await generateSlideSvg({ docTitle: title, section: s, role: s.role, index: i, total: sections.length, spec })
      : legacyFreeSvg(s, s.role);
    baseline.push({ role: s.role, title: s.heading, svg });
  }
  const before = scoreDeck({ profile, slides: baseline });

  const readGenerated = (s, i) => {
    if (!generatedDir || !['cover', 'section'].includes(s.role)) return null;
    const file = path.join(generatedDir, `${s.role}-${i + 1}.png`);
    if (!fs.existsSync(file)) return null;
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  };
  const refined = sections.map((s, i) => ({
    role: s.role,
    title: s.heading,
    svg: renderTemplateSlide({ profile, templateDir: outDir, section: s, role: s.role, index: i, total: sections.length, imageData: readGenerated(s, i) }),
  }));
  const after = scoreDeck({ profile, slides: refined });
  const pptx = await buildPptx(refined, title, 'reference-profile', { canvas: profile.canvas });
  const pptxFile = path.join(outDir, '悯农_模板风格对齐迭代版.pptx');
  fs.writeFileSync(pptxFile, Buffer.from(pptx));
  const report = {
    reference: path.resolve(ref),
    generatedAt: new Date().toISOString(),
    content: '悯农',
    baseline: { mode: liveBaseline ? 'free-svg-live-model' : 'free-svg-deterministic', ...before },
    iteration1: after,
    delta: Math.round((after.score - before.score) * 10) / 10,
    output: pptxFile,
  };
  fs.writeFileSync(path.join(outDir, 'style-score-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'style-score-report.txt'), `悯农模板风格评分\n基线（自由 SVG）：${before.score}/100\n迭代后（参考画像）：${after.score}/100\n提升：${report.delta}\n一致性：${after.dimensions.contentConsistency}%\n阈值：${after.threshold}\n通过：${after.pass ? '是' : '否'}\n`);
  console.log(JSON.stringify({ before: before.score, after: after.score, delta: report.delta, pass: after.pass, pptxFile }, null, 2));
})().catch((err) => { console.error(err.stack || err); process.exit(1); });

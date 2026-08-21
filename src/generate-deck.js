// 阶段2：按主题令牌 + 定稿大纲，逐页生成整页 SVG。纯 LLM 逻辑——产出裸 SVG 字符串；
// 切页、并发锁在此提供，relay 落库与 SSE 推送由 src/server.js 路由做（本模块不碰 relay）。
// 生成规则不自造：直接复用 buildSpec 产出的 tokensText（令牌）+ authoringText（SVG 硬规则，
// 即 svg-sanitize 会保留什么）+ 角色原型骨架，喂给模型，与 /spec 暴露的是同一份创作契约。
const llm = require('./llm');
const { deriveTitle } = require('./normalize-outline');
const llmprovider = require('./llmprovider');
const assets = require('./assets');
const htmlShot = require('./html-shot');
const fs = require('fs');

// Center-crop an image data URI to the deck aspect (default 16:9) so a square
// AI illustration fills a wide slide without distortion. pptxgenjs stretches
// data-URI images to the frame (its sizing:cover can't read their intrinsic
// size), so the crop must happen on the bytes — here, deterministically via the
// same headless browser used for baking. Falls back to the original on failure.
async function coverCropDataUri(dataUri, w = 1280, h = 720) {
  try {
    const html = `<img src="${dataUri}" style="display:block;width:${w}px;height:${h}px;object-fit:cover;object-position:center">`;
    const png = await htmlShot.renderToPng(html, { width: w, height: h, scale: 1 });
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch { return dataUri; }
}

// 模块级 in-flight 锁：整册生成与单页重画共用一把，禁止并发（双击 / 生成中再点）。
let inflight = false;
function acquire() {
  if (inflight) { const e = new Error('上一次生成尚未结束，请稍候'); e.code = 'BUSY'; throw e; }
  inflight = true;
}
function release() { inflight = false; }

function imageEnabledFor(policy, role, index) {
  if (!policy || policy.enabled === false) return false;
  // Cover and divider imagery is part of the template language. Do not use
  // the page-index cap for those roles; it skipped later chapter art.
  if (role === 'content' && Number(policy.maxPerDeck) >= 0 && index >= Number(policy.maxPerDeck)) return false;
  const roles = Array.isArray(policy.roles) && policy.roles.length ? policy.roles : ['cover', 'section'];
  if (!roles.includes(role)) return false;
  if (role === 'content' && Number(policy.contentEvery) > 1 && index % Number(policy.contentEvery) !== 0) return false;
  return Boolean(llmprovider.listActive().image);
}

async function addGeneratedImage(svg, { role, index, docTitle, section, policy }) {
  if (!svg || !imageEnabledFor(policy, role, index)) return svg;
  const hint = policy.prompt || 'editorial paper collage, warm natural light, hand-cut shapes, no words or lettering';
  const prompt = [
    `Create a single presentation illustration for the topic: ${docTitle || 'the presentation'}.`,
    `This slide is about: ${section.heading}.`,
    `Visual direction: ${hint}.`,
    role === 'section'
      ? 'Make this a wide chapter-divider illustration with the focal subject on the upper right and calm negative space in the lower left for the chapter number and title.'
      : role === 'cover'
        ? 'Make this a wide cover illustration with the subject grouped on the right and generous calm negative space on the left for the title.'
        : '',
    'Use a clean subject with generous negative space, no logos, no UI screenshots, no readable text.',
  ].join(' ');
  try {
    const result = await llm.generateImage(prompt, { size: policy.size || '1024x1024' });
    let saved;
    if (result.b64) saved = assets.saveImageBase64(result.b64, 'png');
    else if (result.url) saved = await assets.saveImageFromUrl(result.url);
    if (!saved || !fs.existsSync(saved.path)) return svg;
    const ext = saved.file.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const data = `data:${mime};base64,${fs.readFileSync(saved.path).toString('base64')}`;
    const p = policy.placement || {};
    const x = Number(p.x ?? 900), y = Number(p.y ?? 130), w = Number(p.w ?? 290), h = Number(p.h ?? 450);
    const frame = String(policy.frame || '#E2703A');
    const image = `<rect x="${x - 10}" y="${y - 10}" width="${w + 20}" height="${h + 20}" rx="24" fill="${frame}" fill-opacity="0.18"/><image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${data}"/>`;
    // 放在第一个文本节点前，始终保持插画在文字下层。
    const firstText = svg.search(/<text\b/i);
    return firstText >= 0 ? `${svg.slice(0, firstText)}${image}${svg.slice(firstText)}` : svg.replace(/<\/svg>\s*$/i, `${image}</svg>`);
  } catch {
    // 生图是增强能力；未配置或上游失败时不影响整册 SVG 出片。
    return svg;
  }
}

// Same image policy, but returns an inline data URI for the deterministic
// template renderer. Keeping image generation separate prevents it from
// changing layout or inserting an image into the wrong frame.
async function generateSlideImage({ role, index, docTitle, section, policy }) {
  if (!imageEnabledFor(policy, role, index)) return null;
  const hint = policy.prompt || 'editorial paper collage, warm natural light, hand-cut shapes, no words or lettering';
  const prompt = [
    `Create a single presentation illustration for the topic: ${docTitle || 'the presentation'}.`,
    `This slide is about: ${section.heading}.`, `Visual direction: ${hint}.`,
    role === 'section'
      ? 'Make this a wide chapter-divider illustration with the focal subject on the upper right and calm negative space in the lower left for the chapter number and title.'
      : role === 'cover'
        ? 'Make this a wide cover illustration with the subject grouped on the right and generous calm negative space on the left for the title.'
        : '',
    'Use a clean subject with generous negative space, no logos, no UI, no readable text.',
  ].join(' ');
  try {
    const result = await llm.generateImage(prompt, { size: policy.size || '1024x1024' });
    let saved;
    if (result.b64) saved = assets.saveImageBase64(result.b64, 'png');
    else if (result.url) saved = await assets.saveImageFromUrl(result.url);
    if (!saved || !fs.existsSync(saved.path)) return null;
    const ext = saved.file.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const raw = `data:${mime};base64,${fs.readFileSync(saved.path).toString('base64')}`;
    // Cover/section art is placed full-bleed into the 16:9 canvas; crop to that
    // aspect so it is not stretched on export (preview == export).
    return await coverCropDataUri(raw, 1280, 720);
  } catch { return null; }
}

// 角色语义（喂给模型，决定版式意图）；与 spec.js 的 ROLE_GUIDE 对齐
const ROLE_BRIEF = {
  cover: '封面页：超大主标题 + 眉题/副标题或署名，一个视觉锚点，大面积主色或留白',
  section: '章节过渡页：深色底 + 超大章节序号 + 章节名，信息极少',
  content: '正文页：页标题 + accent 下划线 + 2~5 个要点/卡片/数据，严格对齐、留白充足',
  closing: '结尾页：致谢/收束，一句话居中安静，可选行动号召',
};

// 确定性切页：# → 文档标题；每个 ## 连同其下正文 = 一页。无状态、同输入同切分，
// 故单页重画时重切取第 index 段即可，页序稳定可复现。
function splitOutline(markdown) {
  const md = String(markdown || '');
  const title = deriveTitle(md);
  const sections = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (cur) sections.push(cur);
      cur = { heading: h2[1].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
    // 首个 ## 之前的内容（# 标题 / 引言）仅用于 deriveTitle，不单独成页
  }
  if (cur) sections.push(cur);

  const total = sections.length;
  const isSectionHeading = (heading, body) => {
    const h = String(heading || '').trim();
    const short = String(body || '').replace(/\s+/g, '').length <= 65;
    return short && /^(第[一二三四五六七八九十百\d]+[章节]|[一二三四五六七八九十]+、|0?\d+[.、\s]|chapter\s+\d+)/i.test(h);
  };
  const isClosingHeading = (heading) => /(谢谢|感谢|结语|总结|尾声|结束|行动|倡议|寄语|致敬|takeaway|closing|thank\s*you)/i.test(String(heading || '').trim());
  const pages = sections.map((s, i) => {
    const body = s.bodyLines.join('\n').trim();
    const role = total <= 1 ? 'cover'
      : i === 0 ? 'cover'
        : isClosingHeading(s.heading) ? 'closing'
          : isSectionHeading(s.heading, body) ? 'section' : 'content';
    return { heading: s.heading, body, raw: `## ${s.heading}\n${body}`.trim(), role };
  });

  // Chapter numbers are semantic, not page indexes. A cover and content pages
  // must never turn a later divider into "04" just because it is page four.
  let chapterNo = 0;
  pages.forEach((page) => {
    if (page.role === 'section') page.sectionNo = String(++chapterNo).padStart(2, '0');
  });

  // Carry the current chapter onto its content pages, so a content footer can
  // show the section identifier the source deck keeps in its page chrome.
  let chapter = null;
  pages.forEach((page) => {
    if (page.role === 'section') {
      chapter = { no: page.sectionNo, title: String(page.heading).replace(/^第[一二三四五六七八九十百\d]+[章节]\s*[:：]?\s*/, '') };
    } else if (page.role === 'content' && chapter) {
      page.chapter = chapter;
    }
  });

  // 大纲无任何 ## 时兜底为单张封面页，避免出片阶段空册
  if (pages.length === 0) {
    pages.push({ heading: title || '演示文稿', body: '', raw: md.trim(), role: 'cover' });
  }
  return { title, sections: pages };
}

// 生成一页 SVG（裸字符串，未归一）。运行期错误（网络/超时）抛给路由；模型未产出 SVG 时
// 返回 ''——由路由经 normalizeSlide 归一为坏页（BLANK + _recovered），可事后单页重画。
async function generateSlideSvg({ docTitle, section, role, index, total, spec, feedback }) {
  const proto = (spec.layouts || []).find((l) => l.role === role);
  const system = [
    '你是资深 PPT 版式设计师。依据下面这套主题的设计令牌与创作规则，为「一页」内容创作一整张 SVG。',
    '',
    spec.tokensText,
    '',
    spec.authoringText,
    '',
    proto ? `该页角色的原型骨架（供参考，可在其基础上替换文字、按内容增删元素）：\n${proto.svg}` : '',
    '',
    '输出要求：只输出一整张 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">…</svg>；'
      + '不要任何解释、不要 Markdown 代码块围栏；严格遵守上面的创作规则（违规元素会被清洗，导致预览异常）。',
  ].filter(Boolean).join('\n');

  const user = [
    `演示主标题：${docTitle || '（无）'}`,
    `本页角色：${ROLE_BRIEF[role] || ROLE_BRIEF.content}（第 ${index + 1} 页 / 共 ${total} 页）`,
    '',
    '本页内容（Markdown）：',
    section.raw,
    feedback ? `\n本页修改意见（请据此重画）：${feedback}` : '',
    '',
    '请为这一页创作 SVG。',
  ].filter(Boolean).join('\n');

  const text = await llm.chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.6, maxTokens: 4000 },
  );
  return llm.extractSvg(text);
}

module.exports = { splitOutline, generateSlideSvg, addGeneratedImage, generateSlideImage, acquire, release };

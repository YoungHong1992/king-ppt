// 阶段2：按主题令牌 + 定稿大纲，逐页生成整页 SVG。纯 LLM 逻辑——产出裸 SVG 字符串；
// 切页、并发锁在此提供，relay 落库与 SSE 推送由 src/server.js 路由做（本模块不碰 relay）。
// 生成规则不自造：直接复用 buildSpec 产出的 tokensText（令牌）+ authoringText（SVG 硬规则，
// 即 svg-sanitize 会保留什么）+ 角色原型骨架，喂给模型，与 /spec 暴露的是同一份创作契约。
const llm = require('./llm');
const { deriveTitle } = require('./normalize-outline');

// 模块级 in-flight 锁：整册生成与单页重画共用一把，禁止并发（双击 / 生成中再点）。
let inflight = false;
function acquire() {
  if (inflight) { const e = new Error('上一次生成尚未结束，请稍候'); e.code = 'BUSY'; throw e; }
  inflight = true;
}
function release() { inflight = false; }

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
  const pages = sections.map((s, i) => {
    const body = s.bodyLines.join('\n').trim();
    const role = total <= 1 ? 'cover'
      : i === 0 ? 'cover'
        : i === total - 1 ? 'closing'
          : 'content';
    return { heading: s.heading, body, raw: `## ${s.heading}\n${body}`.trim(), role };
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

module.exports = { splitOutline, generateSlideSvg, acquire, release };

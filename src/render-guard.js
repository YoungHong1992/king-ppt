// 渲染护栏层：让「任意模板 × 任意内容 × 任意模型」都不产出崩坏的一页。
// 测量层(bake)与渲染层(template-renderer)共用同一套守卫——这是「能交付给广大
// 用户」和「只是个 demo」的分水岭：普通用户不会 debug，出一次 420px 巨字就流失。
//
// 提供：亮度/对比度、文本宽度估算、字号自适应、分角色字号上限、对比度安全取色、
// 装饰性巨字(水印/大号章节数字)识别。

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿㐀-䶿]/;

function lum(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 0.5;
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { return Math.abs(lum(a) - lum(b)); }

// 一行文本的估算宽度(px)：CJK≈1em，拉丁≈0.56em。用于自适应与不再让 PPT 重排。
function textWidthPx(text, fsPx) {
  let u = 0;
  for (const ch of String(text)) u += CJK.test(ch) ? 1 : 0.56;
  return u * fsPx;
}

// 自适应字号(px)：从 startPx 往下缩，直到 text 能在 maxLines 行内放进 boxWpx。
function fitPx(text, boxWpx, startPx, maxLines = 1, minPx = 14) {
  let px = Math.max(startPx, minPx);
  const budget = Math.max(1, boxWpx) * Math.max(1, maxLines) * 0.98; // 留一点边距
  while (px > minPx && textWidthPx(text, px) > budget) px -= 1;
  return Math.max(px, minPx);
}

// 分角色的合理字号上限(pt)：封面最大，正文页标题最克制。
const TITLE_CAP = { cover: 54, section: 46, content: 30, closing: 46, default: 40 };
function saneTitlePt(pt, role) {
  const cap = TITLE_CAP[role] || TITLE_CAP.default;
  const n = Number(pt);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : cap, 14), cap);
}

// 对比度安全取色：优先用设计师给的颜色(若在 bg 上够清晰)，否则在候选里挑，
// 再不行按 bg 明暗回退到白/近黑。避免「深底黑字」「浅底白字」这类看不见的标题。
function readableOn(bg, preferred, extra = []) {
  const cands = [preferred, ...extra].filter(Boolean).map((c) => String(c).replace('#', ''));
  for (const c of cands) if (contrast(c, bg) >= 0.4) return c;
  return lum(bg) < 0.5 ? 'F5F5F5' : '141414';
}

// 装饰性巨字识别：远超正常标题字号(水印)，或「大号纯数字」(章节序号水印)。
// 这类元素不该被当成页面标题——修的正是「315pt 的 04 被当标题」那个坑。
function isDecorativeText(text, sizePt) {
  const s = Number(sizePt) || 0;
  const t = String(text || '').trim();
  if (s >= 110) return true;
  if (s >= 64 && /^[0-9]{1,3}$/.test(t)) return true;
  return false;
}

module.exports = { lum, contrast, textWidthPx, fitPx, saneTitlePt, readableOn, isDecorativeText, TITLE_CAP };

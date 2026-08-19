// 文本宽度估算（英寸）：从旧 validate.js 迁出的纯函数，svg-to-pptx 的 <text> 包围盒计算依赖它。
// CJK 全角 ≈ 1em，拉丁/数字/半角标点 ≈ 0.55em。SVG-as-IR 架构下这是唯一保留的度量工具。
function textWidthIn(text, fontSizePt) {
  let units = 0;
  for (const ch of String(text)) {
    units += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.55;
  }
  return (units * fontSizePt) / 72;
}

module.exports = { textWidthIn };

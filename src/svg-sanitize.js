// SVG-as-IR 清洗 / 归一（纯字符串，无 DOM；Node 与浏览器构建通用）。
// 「预览 == 导出」契约的守门人：每页幻灯片 = 一个完整 SVG，浏览器内联预览、服务端
// src/svg-to-pptx.js 编译为原生 pptx 对象——二者消费同一份清洗结果。故这里只放行
// 「导出端能忠实还原」的元素；凡 pptxgenjs 无法复现的（渐变/滤镜/mask/CSS/外链）一律剔除。
//
// 历史：本模块原为 public/svg-frame.js（UMD，含浏览器 build()）。SVG 媒介切换后，服务端
// 只需纯字符串清洗，故迁出到 src/；前端预览由 Vite/React 侧自行内联渲染（服务端已清洗过）。

// 危险 / 不可导出的元素：整棵子树连内容一并删除
const STRIP_SUBTREE = [
  'script', 'foreignObject', 'iframe', 'style',                     // 安全：脚本 / 外部内容 / CSS
  'animate', 'animateTransform', 'animateMotion', 'set',            // 安全：SMIL 动画
  'defs', 'symbol', 'marker', 'pattern',                           // 导出不支持：引用型定义
  'linearGradient', 'radialGradient', 'filter', 'mask', 'clipPath', // 导出不支持：渐变/滤镜/蒙版/裁剪
];

// 删除某标签的成对子树、自闭合、以及游离的起止标签
function removeTag(s, tag) {
  const open = '<\\s*' + tag + '\\b[^>]*';
  return s
    .replace(new RegExp(open + '>[\\s\\S]*?<\\s*/\\s*' + tag + '\\s*>', 'gi'), '') // 成对含内容
    .replace(new RegExp(open + '/?>', 'gi'), '')                                   // 自闭合 / 游离起始
    .replace(new RegExp('<\\s*/\\s*' + tag + '\\s*>', 'gi'), '');                  // 游离闭合
}

// best-effort 字符串级清洗：删危险/不可导出子树 → 事件钩子 → javascript: → 外链 href（保留 data:）
// → <image> 仅放行 data: URI；<use> 删除；内联 style 删除
function sanitizeSvg(svg) {
  let s = String(svg || '');
  for (const tag of STRIP_SUBTREE) s = removeTag(s, tag);
  s = removeTag(s, 'use');
  s = s
    .replace(/<\s*image\b[^>]*?>/gi, (m) => (/(?:xlink:)?href\s*=\s*("|')\s*data:/i.test(m) ? m : ''))
    .replace(/<\s*\/\s*image\s*>/gi, '');
  return s
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')          // 事件属性 onX=
    .replace(/javascript\s*:/gi, '')                                    // javascript: 伪协议
    .replace(/(?:xlink:href|href)\s*=\s*"(?!\s*data:)[^"]*"/gi, '')     // 外链 href（双引号）
    .replace(/(?:xlink:href|href)\s*=\s*'(?!\s*data:)[^']*'/gi, '')     // 外链 href（单引号）
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');                  // 内联 style
}

// 根元素补齐 viewBox；解析失败（非 <svg> 根）返回 null
function normalize(svg) {
  const s = sanitizeSvg(svg).trim();
  if (!/^<svg[\s>]/i.test(s)) return null;
  if (!/viewBox\s*=/i.test(s)) return s.replace(/^<svg/i, '<svg viewBox="0 0 1280 720"');
  return s;
}

module.exports = { sanitizeSvg, normalize, removeTag, STRIP_SUBTREE };

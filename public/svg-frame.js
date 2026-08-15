// ================= free 自由排版页 → SVG 渲染框架 =================
// 前端：sanitize 后的 SVG 内联进 .slide 容器（矢量预览，随容器缩放）；
// 服务端（src/svg-to-pptx.js）复用同一份 sanitize，把 SVG 转成原生 pptx 对象。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvgFrame = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // best-effort 字符串级清洗（与 html-frame.sanitize 同思路）：
  // 剔除脚本/事件钩子/外部引用；只保留形状与文字
  function sanitizeSvg(svg) {
    return String(svg || '')
      .replace(/<\s*(script|foreignObject|iframe|image|use|animate|set|animateTransform)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/(?:xlink:href|href)\s*=\s*"(?!data:)[^"]*"/gi, '')
      .replace(/(?:xlink:href|href)\s*=\s*'(?!data:)[^']*'/gi, '');
  }

  // 根元素补齐 viewBox/尺寸；宽高 100% 跟随容器
  function normalize(svg) {
    let s = sanitizeSvg(svg).trim();
    if (!/^<svg[\s>]/i.test(s)) return null;
    if (!/viewBox\s*=/i.test(s)) {
      s = s.replace(/^<svg/i, '<svg viewBox="0 0 1280 720"');
    }
    // 宽高写死为 100%，preserveAspectRatio 保证等比铺满
    s = s.replace(/^<svg([^>]*)>/i, (m, attrs) => {
      attrs = attrs
        .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\spreserveAspectRatio\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      return `<svg${attrs} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`;
    });
    return s;
  }

  // 前端预览：.slide 容器 + 内联 SVG（DOMParser 解析，失败返回 null）
  function build(svg) {
    const norm = normalize(svg);
    if (!norm) return null;
    const container = document.createElement('div');
    container.className = 'slide dp-scene svg-frame';
    try {
      const doc = new DOMParser().parseFromString(norm, 'image/svg+xml');
      const el = doc.documentElement;
      if (el && el.nodeName.toLowerCase() === 'svg' && !doc.querySelector('parsererror')) {
        container.appendChild(document.importNode(el, true));
        return container;
      }
    } catch { /* 解析失败走兜底 */ }
    container.innerHTML = '<div class="muted" style="display:flex;height:100%;align-items:center;justify-content:center;font-size:14px">自由排版页解析失败</div>';
    return container;
  }

  return { sanitizeSvg, normalize, build };
}));

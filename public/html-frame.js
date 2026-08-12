// ================= free 自由排版页 → 安全 HTML 渲染框架 =================
// 前端：sandbox iframe 预览 + ResizeObserver 等比缩放；
// 服务端（src/html-shot.js）复用同一套 sanitize/wrap，保证预览 = 导出。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HtmlFrame = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // best-effort 字符串级清洗（威胁模型：本地应用 + 本机 LLM 生成的 HTML）
  // 剔除脚本/外链/事件钩子；iframe sandbox 作为第二道防线
  function sanitize(html) {
    return String(html || '')
      .replace(/<\s*(script|iframe|link|object|embed|base)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/@\s*import[^;"]*;?/gi, '')
      .replace(/https?:\/\/[^\s"'<>)]+/gi, '');
  }

  // 固定设计画布包裹：1280×720（16:9），与 Chrome 截图导出同一份
  function wrap(html, { width = 1280, height = 720 } = {}) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${html}</body></html>`;
  }

  // 前端预览：.slide 容器 + 不可交互 iframe，文档级 zoom 等比缩放
  // （不用 transform scale：headless/软件渲染下滚动容器内 iframe 变换有不合成像素的风险；
  //   zoom 是文档内部布局缩放，兼容性更好且文字不糊）
  function build(html, { width = 1280, height = 720 } = {}) {
    const container = document.createElement('div');
    container.className = 'slide dp-scene html-frame';
    const iframe = document.createElement('iframe');
    // allow-same-origin 让父页面能进文档调 zoom；不放开 allow-scripts，脚本仍全禁
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;pointer-events:none;';
    iframe.srcdoc = wrap(sanitize(html), { width, height });
    container.appendChild(iframe);
    const applyZoom = (w) => {
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.documentElement) doc.documentElement.style.zoom = String(w / width);
      } catch { /* 跨域兜底：忽略 */ }
    };
    iframe.addEventListener('load', () => applyZoom(container.clientWidth));
    new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) applyZoom(w);
    }).observe(container);
    return container;
  }

  return { sanitize, wrap, build };
}));

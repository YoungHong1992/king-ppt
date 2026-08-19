// 中继客户端：REST 动作 + SSE 订阅。前端只跟中继服务器对话，从不内置大模型。
// 协议回顾（medium-agnostic，SVG 切换后不变）：
//   浏览器 POST /api/agent/action {action,payload} → 入队给用户 Agent 长轮询；
//   有副作用的动作（theme-pick / edit）服务端先落权威 deck，再广播；
//   服务端 SSE /api/stream 推 deck / slide 事件回浏览器预览。

async function req(path, { method = 'GET', body, raw = false } = {}) {
  const resp = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch { /* 非 JSON 错误体 */ }
    throw new Error(detail || `${method} ${path} → ${resp.status}`);
  }
  return raw ? resp : resp.json();
}

export const api = {
  listThemes: () => req('/api/templates'),
  themeSpec: (id) => req(`/api/templates/${encodeURIComponent(id)}/spec`),
  state: () => req('/api/agent/state'),
  // 浏览器把人类动作交给 Agent。有副作用动作服务端会先落 deck。
  action: (action, payload = {}) => req('/api/agent/action', { method: 'POST', body: { action, payload } }),
  // 导出当前 deck 为 .pptx（返回 Blob）
  async export(slides, title, themeId) {
    const resp = await req('/api/export', { method: 'POST', raw: true, body: { slides, title, themeId } });
    return resp.blob();
  },
};

// SSE 订阅：deck（整册）/ slide（单页）。返回取消函数。自动重连由浏览器按 retry 处理。
export function subscribe({ onDeck, onSlide, onError }) {
  const es = new EventSource('/api/stream');
  es.addEventListener('deck', (e) => { try { onDeck(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.addEventListener('slide', (e) => { try { onSlide(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.onerror = () => { if (onError) onError(); };
  return () => es.close();
}

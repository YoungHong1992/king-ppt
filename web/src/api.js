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
  doc: () => req('/api/agent/doc'),
  // 浏览器把人类动作交给 Agent。有副作用动作服务端会先落 deck。
  action: (action, payload = {}) => req('/api/agent/action', { method: 'POST', body: { action, payload } }),
  // 阶段0：上传参考素材（base64）；服务端存盘并入队 material-added 通知 Agent
  uploadMaterial: (name, data) => req('/api/materials', { method: 'POST', body: { name, data } }),
  // 内置生成（阶段1，server-gen 模式）：多供应商配置读写/测试 + 生成/改稿大纲。生成结果经 SSE 'doc' 回来。
  getProviders: () => req('/api/providers'),
  createInstance: (body) => req('/api/instances', { method: 'POST', body }),
  updateInstance: (id, patch) => req(`/api/instances/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  deleteInstance: (id) => req(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
  testInstance: (id, override = {}) => req(`/api/instances/${encodeURIComponent(id)}/test`, { method: 'POST', body: override }),
  testModel: (id, model) => req(`/api/instances/${encodeURIComponent(id)}/test-model`, { method: 'POST', body: { model } }),
  testModels: (id) => req(`/api/instances/${encodeURIComponent(id)}/test-models`, { method: 'POST', body: {} }),
  remoteModels: (id) => req(`/api/instances/${encodeURIComponent(id)}/remote-models`, { method: 'POST', body: {} }),
  addModel: (id, model, caps, enabled) => req(`/api/instances/${encodeURIComponent(id)}/models`, { method: 'POST', body: { id: model, caps, enabled } }),
  removeModel: (id, model) => req(`/api/instances/${encodeURIComponent(id)}/models`, { method: 'DELETE', body: { model } }),
  setActive: (capability, instance, model) => req('/api/active', { method: 'POST', body: { capability, instance, model } }),
  generateOutline: ({ topic, pages, materials } = {}) =>
    req('/api/generate/outline', { method: 'POST', body: { topic, pages, materials } }),
  reviseOutline: (comments) =>
    req('/api/generate/outline', { method: 'POST', body: { comments } }),
  // 导出当前 deck 为 .pptx（返回 Blob）
  async export(slides, title, themeId) {
    const resp = await req('/api/export', { method: 'POST', raw: true, body: { slides, title, themeId } });
    return resp.blob();
  },
};

// SSE 订阅：deck（整册）/ slide（单页）/ doc（内容大纲）。返回取消函数。自动重连由浏览器按 retry 处理。
export function subscribe({ onDeck, onSlide, onDoc, onError }) {
  const es = new EventSource('/api/stream');
  es.addEventListener('deck', (e) => { try { onDeck(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.addEventListener('slide', (e) => { try { onSlide(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  if (onDoc) es.addEventListener('doc', (e) => { try { onDoc(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.onerror = () => { if (onError) onError(); };
  return () => es.close();
}

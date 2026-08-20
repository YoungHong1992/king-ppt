const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildPptx } = require('./pptx');
const { loadDescriptor, listDescriptors, loadTheme, loadThemeLayouts } = require('./descriptor');
const { resolve } = require('./layout-resolver'); // 仅供旧模板画廊 sample/preview 路由；P3 主题系统落地后连同这些路由一并移除
const assets = require('./assets');
const { extractFromPptx, saveTemplate } = require('./extract');
const { parseSourcePages } = require('./pptx-pages');
const sessions = require('./sessions');
const normalize = require('./normalize');
const normalizeOutline = require('./normalize-outline');
const materials = require('./materials');
const { buildSpec } = require('./spec');
const { createRelay } = require('./relay');
const { RUNTIME_FILE } = require('./paths');
const llmprovider = require('./llmprovider');
const genOutline = require('./generate-outline');

const app = express();
const relay = createRelay(); // Agent ↔ 浏览器 的有状态中继（deck 存储 + 事件总线 + 动作队列）

// 上传模板 / Agent 推 deck / 配图以 base64 进 JSON，放宽体积；其余路由维持 2mb
const jsonBody = express.json({ limit: '2mb' });
const jsonBodyLarge = express.json({ limit: '30mb' });
app.use((req, res, next) => {
  const large = req.path === '/api/templates/extract'
    || req.path === '/api/assets'
    || req.path === '/api/materials'
    || req.path.startsWith('/api/agent/')
    || req.path.startsWith('/api/generate/');
  return (large ? jsonBodyLarge : jsonBody)(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

function statusOf(err) {
  if (err.code === 'SESSION_NOT_FOUND' || err.code === 'ASSET_NOT_FOUND') return 404;
  if (err.code === 'BAD_SESSION_ID' || err.code === 'BAD_ASSET_NAME') return 400;
  if (err.code === 'NO_API_KEY') return 401;
  if (err.code === 'BAD_INPUT' || err.code === 'NO_MODEL_CONFIG' || err.code === 'CAPABILITY_NOT_SUPPORTED') return 400;
  if (err.code === 'BUSY') return 409;
  if (err.code === 'LLM_HTTP' || err.code === 'LLM_EMPTY' || err.code === 'LLM_TIMEOUT') return 502; // 上游模型错误
  return 500;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) return res.end(); // 已开始响应（如 sendFile 中途断开），只能放弃
      res.status(statusOf(err)).json({ error: err.message });
    }
  };
}

// ---------- 模板 ----------
app.get('/api/templates', (req, res) => {
  res.json({ templates: listDescriptors() });
});

// 所选主题的创作规格：设计令牌 + 4 个角色原型页 + SVG 创作规则，供用户 Agent 照着画整页 SVG
app.get('/api/templates/:id/spec', wrap(async (req, res) => {
  const theme = loadTheme(req.params.id);
  res.json(buildSpec(theme, loadThemeLayouts(req.params.id)));
}));

// 画廊卡片预览：3 张样例页的场景图
app.get('/api/templates/:id/sample', wrap(async (req, res) => {
  const d = loadDescriptor(req.params.id);
  const samples = [
    { index: 0, type: 'title', title: '演示文稿标题', subtitle: '副标题示例文字' },
    { index: 1, type: 'section', title: '第一章节名', subtitle: '章节导语示例' },
    { index: 2, type: 'bullets', title: '页面标题', bullets: ['第一条要点内容', '第二条要点内容', '第三条要点内容'] },
  ];
  res.json({ canvas: d.canvas, scenes: resolve(d, samples, { title: d.meta.name }).slides });
}));

app.get('/api/templates/:id/assets/:file', wrap(async (req, res) => {
  const { id, file } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || file !== path.basename(file)) {
    return res.status(400).json({ error: '非法的资源路径' });
  }
  const d = loadDescriptor(id);
  const full = path.join(d._dir, 'assets', file);
  if (!full.startsWith(path.join(d._dir, 'assets')) || !fs.existsSync(full)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(full);
}));

// 模板整册预览：上传模板解析 source.pptx 还原「原件每一页」；预设模板渲染 8 类版式效果页
const tplPreviewCache = new Map(); // id -> { mtime, data }
app.get('/api/templates/:id/preview', wrap(async (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: '非法的模板 id' });
  const d = loadDescriptor(id);
  const sourcePath = path.join(d._dir, 'source.pptx');
  if (fs.existsSync(sourcePath)) {
    const mtime = fs.statSync(sourcePath).mtimeMs;
    let hit = tplPreviewCache.get(id);
    if (!hit || hit.mtime !== mtime) {
      hit = { mtime, data: await parseSourcePages(fs.readFileSync(sourcePath), { mediaDir: path.join(d._dir, '.media') }) };
      tplPreviewCache.set(id, hit);
      if (tplPreviewCache.size > 8) tplPreviewCache.delete(tplPreviewCache.keys().next().value);
    }
    return res.json({ kind: 'source', name: d.meta.name, canvas: hit.data.canvas, pages: hit.data.pages });
  }
  const samples = [
    { index: 0, type: 'title', title: '演示文稿标题', subtitle: '副标题示例文字' },
    { index: 1, type: 'section', title: '第一章节名', subtitle: '章节导语示例' },
    { index: 2, type: 'bullets', title: '要点页标题', bullets: ['第一条要点内容', '第二条要点内容', '第三条要点内容'] },
    { index: 3, type: 'twoColumn', title: '两栏对比标题', leftTitle: '传统方式', leftBullets: ['人工排版耗时长', '多人协作版式乱'], rightTitle: '智能生成', rightBullets: ['十分钟出初稿', '版式自动统一'] },
    { index: 4, type: 'table', title: '数据表格标题', headers: ['指标', '本季度', '环比'], rows: [['产出效率', '92%', '+18%'], ['版式一致性', '100%', '+7%']] },
    { index: 5, type: 'steps', title: '流程步骤标题', steps: [{ title: '输入主题', desc: '可粘贴参考材料' }, { title: '确认大纲', desc: '逐页流式生成' }, { title: '导出编辑', desc: '下载可编辑 PPTX' }] },
    { index: 6, type: 'quote', quote: '别人熬夜做的，没你十分钟做的好。', author: '卷王PPT' },
    { index: 7, type: 'stats', title: '关键数字', stats: [{ value: '87%', label: '效率提升' }, { value: '10分钟', label: '平均出稿' }] },
  ];
  res.json({
    kind: 'descriptor',
    name: d.meta.name,
    canvas: d.canvas,
    types: samples.map((s) => s.type),
    scenes: resolve(d, samples, { title: d.meta.name }).slides,
  });
}));

// 原件预览引用的媒体（首次 preview 时解包到模板目录 .media/ 缓存）
app.get('/api/templates/:id/media/:file', wrap(async (req, res) => {
  const { id, file } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || file !== path.basename(file)) {
    return res.status(400).json({ error: '非法的资源路径' });
  }
  const d = loadDescriptor(id);
  const full = path.join(d._dir, '.media', file);
  if (!full.startsWith(path.join(d._dir, '.media')) || !fs.existsSync(full)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(full, { dotfiles: 'allow' }); // .media 是点目录，send 默认忽略
}));

app.post('/api/templates/extract', wrap(async (req, res) => {
  const { name, data } = req.body || {};
  if (!data) return res.status(400).json({ error: '请上传 pptx 文件（base64）' });
  const buffer = Buffer.from(data, 'base64');
  res.json(await extractFromPptx(buffer, name || 'uploaded.pptx'));
}));

app.post('/api/templates', wrap(async (req, res) => {
  const { stagingId, name } = req.body || {};
  if (!stagingId || !/^[a-f0-9]{16}$/.test(stagingId)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  res.json({ id: saveTemplate(stagingId, name), templates: listDescriptors() });
}));

// ---------- 会话 ----------
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: sessions.listSessions() });
});

app.post('/api/sessions', wrap(async (req, res) => {
  const session = sessions.createSession(req.body || {});
  res.json({ id: session.id, session });
}));

app.get('/api/sessions/:id', wrap(async (req, res) => {
  res.json(sessions.getSession(req.params.id));
}));

app.put('/api/sessions/:id', wrap(async (req, res) => {
  res.json({ session: sessions.updateSession(req.params.id, req.body || {}) });
}));

app.delete('/api/sessions/:id', wrap(async (req, res) => {
  sessions.deleteSession(req.params.id);
  res.json({ ok: true });
}));

// ---------- 配图 ----------
// 配图改由用户 Agent 环境供图：Agent 产图 → POST /api/assets（base64/url）→ 存 → 拿 slide.image
app.post('/api/assets', wrap(async (req, res) => {
  const { data, url, ext } = req.body || {};
  let image;
  if (data) image = assets.saveImageBase64(data, ext || 'png');
  else if (url) image = await assets.saveImageFromUrl(url);
  else return res.status(400).json({ error: '请提供 data(base64) 或 url' });
  res.json(image);
}));

// 生成配图文件（slide.image.url 引用）
app.get('/api/assets/:file', wrap(async (req, res) => {
  const full = assets.resolveAsset(req.params.file);
  res.sendFile(full);
}));

// ---------- 素材（阶段0） ----------
// 浏览器拖拽上传参考素材：base64 存盘（保留原文件名）→ 入队 material-added 通知 Agent 去读。
// 放进项目目录的素材不走这里——Agent 用自己的文件工具直读。
app.post('/api/materials', wrap(async (req, res) => {
  const { name, data } = req.body || {};
  if (!data) return res.status(400).json({ error: '请提供文件数据（base64）' });
  const saved = materials.saveMaterial(name, data);
  relay.enqueueAction({ action: 'material-added', payload: { name: saved.name, path: saved.path } });
  res.json(saved);
}));

// ---------- Agent 中继：内容源 ----------
// 整册推送（SVG-as-IR）：逐页归一为一整页 SVG → 存 deck → SSE 推 'deck' 给浏览器内联预览。
// 不再 resolve/质量校验——SVG 就是最终版式，浏览器预览与 .pptx 导出消费同一份 SVG。
app.post('/api/agent/deck', wrap(async (req, res) => {
  const { title, themeId, templateId, slides } = req.body || {};
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '请提供 slides 数组' });
  }
  const d = loadDescriptor(themeId || templateId);
  const total = slides.length;
  const enriched = slides.map((raw, index) => normalize.normalizeSlide(raw, index, total));
  const version = relay.setDeck({ title: title || '', templateId: d._id, canvas: d.canvas, slides: enriched });
  res.json({
    themeId: d._id,
    canvas: d.canvas,
    slides: enriched,
    recovered: enriched.map((s, i) => (s._recovered ? i : -1)).filter((i) => i >= 0),
    version,
  });
}));

// 单页推送：Agent 逐页流式生成（复刻旧 SSE 的逐页体验）；单页粒度写入，不覆盖整册
app.post('/api/agent/slide', wrap(async (req, res) => {
  const { index, slide: raw, themeId, templateId } = req.body || {};
  const idx = Number(index);
  if (!(idx >= 0)) return res.status(400).json({ error: 'index 非法' });
  const state = relay.getState();
  const d = loadDescriptor(themeId || templateId || state.templateId);
  const total = Math.max(state.slides.length, idx + 1);
  const slide = normalize.normalizeSlide(raw, idx, total);
  const version = relay.setSlide(idx, slide, d.canvas);
  res.json({ index: idx, slide, canvas: d.canvas, version });
}));

// 推内容大纲（阶段1）：Markdown 归一清洗 → 存 doc → SSE 推 'doc' 给浏览器渲染批注。
// 与幻灯片 deck 完全解耦，不碰 normalizeSlide / 导出路径。
app.post('/api/agent/outline', wrap(async (req, res) => {
  const { markdown, title } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: '请提供 markdown 大纲文本' });
  }
  const o = normalizeOutline.normalizeOutline({ markdown, title });
  const version = relay.setDoc({ markdown: o.markdown, title: o.title });
  res.json({ ...o, version });
}));

// 长轮询：阻塞直到有人类动作，或 ~25s 超时返回 heartbeat（取代被删的自愈 loop 的协作心跳）
app.get('/api/agent/next', wrap(async (req, res) => {
  const t = Number(req.query.timeout);
  const timeout = Number.isFinite(t) ? Math.min(Math.max(t, 1000), 60000) : 25000;
  res.json(await relay.waitForAction(timeout));
}));

// 完整 deck（Agent 重启/重连恢复用）
app.get('/api/agent/state', (req, res) => {
  res.json(relay.getState());
});

// 当前内容大纲快照（Agent 重连恢复用）
app.get('/api/agent/doc', (req, res) => {
  res.json(relay.getDoc());
});

// 浏览器把人类动作入队给 Agent；有副作用的动作先落权威 deck，避免被 Agent 下次 push 覆盖
app.post('/api/agent/action', wrap(async (req, res) => {
  const { action, payload = {} } = req.body || {};
  if (!action) return res.status(400).json({ error: '缺少 action' });
  if ((action === 'template-pick' || action === 'theme-pick') && (payload.themeId || payload.templateId)) {
    relay.setTemplate(payload.themeId || payload.templateId);
  } else if (action === 'edit' && Number(payload.index) >= 0 && payload.slide) {
    // 浏览器直接编辑：把改后的整页 SVG 归一清洗后落回权威 deck
    const state = relay.getState();
    const d = loadDescriptor(payload.themeId || payload.templateId || state.templateId);
    const idx = Number(payload.index);
    const total = Math.max(state.slides.length, idx + 1);
    const slide = normalize.normalizeSlide(payload.slide, idx, total);
    relay.setSlide(idx, slide, d.canvas);
  } else if (action === 'outline-annotate') {
    // 批注批次：用当前权威 doc 校验清洗，剔除已失效引用，再交给 Agent 长轮询取走
    payload.comments = normalizeOutline.normalizeComments(payload.comments, relay.getDoc().markdown);
  }
  // outline-finalize / material-added 等无副作用动作：直接入队即可
  const item = relay.enqueueAction({ action, payload });
  res.json({ ok: true, seq: item.seq, version: item.version });
}));

// ---------- 模型供应商（多供应商 × 多模型 × 能力绑定） ----------
// 有绑定「文本」默认模型（或 OPENAI_* 环境变量）即「server-gen 模式」，供纯人类用户无 Agent 也能出稿。
// 生成结果一律经既有 normalizeOutline + relay.setDoc 落库，preview==export 与 SSE 完全不变。

// 一次性拉取设置面板所需全部数据：能力枚举 + 供应商模板（投影）+ 已配实例 + 能力绑定
app.get('/api/providers', (req, res) => {
  res.json({
    capabilities: llmprovider.CAPABILITIES,
    capabilityLabels: llmprovider.CAPABILITY_LABELS,
    templates: llmprovider.PROVIDER_TEMPLATES.map((t) => ({
      id: t.id, name: t.name, baseURL: t.baseURL, keyUrl: t.keyUrl || null, noKey: Boolean(t.noKey),
      short: t.short || t.name[0], color: t.color || '#64748b', tagline: t.tagline || '', tag: t.tag || '',
    })),
    instances: llmprovider.listInstances(),
    active: llmprovider.listActive(),
  });
});

// 新建实例：{ preset?, name?, baseURL?, apiKey? } → { id }
app.post('/api/instances', wrap(async (req, res) => {
  const inst = llmprovider.createInstance(req.body || {});
  res.json({ id: inst.id });
}));

// 改实例（patch，空串=不改）：{ name?, apiKey?, enabled?, baseURL? }
app.put('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.updateInstance(req.params.id, req.body || {});
  res.json({ ok: true });
}));

// 删实例（连带清理指向它的 active 绑定）
app.delete('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.deleteInstance(req.params.id);
  res.json({ ok: true });
}));

// 连接测试（存库前先测）：body 可带 { baseURL?, apiKey? } 覆盖 → { ok, resolvedBaseURL, suggestedBaseURL }
app.post('/api/instances/:id/test', wrap(async (req, res) => {
  res.json(await llmprovider.testInstance(req.params.id, req.body || {}));
}));

// 单模型实测（真实收发一条消息，打 lastTest 标记）：{ model } → { ok, model, ... } | { ok:false, model, error }
app.post('/api/instances/:id/test-model', wrap(async (req, res) => {
  res.json(await llmprovider.testModel(req.params.id, req.body?.model));
}));

// 批量实测该实例下 enabled 的 chat/vision 模型 → { results: [...] }
app.post('/api/instances/:id/test-models', wrap(async (req, res) => {
  res.json(await llmprovider.testModels(req.params.id));
}));

// 从远端 /models 拉列表（只读不写库）→ { ids, existing, suggestedBaseURL }
app.post('/api/instances/:id/remote-models', wrap(async (req, res) => {
  res.json(await llmprovider.peekRemoteModels(req.params.id));
}));

// 加/改模型（upsert）：{ id:<modelId>, caps?, enabled? } → { models }
app.post('/api/instances/:id/models', wrap(async (req, res) => {
  const { id, caps, enabled } = req.body || {};
  res.json({ models: llmprovider.addModel(req.params.id, id, caps, enabled) });
}));

// 删模型（连带清理指向它的 active 绑定）：{ model } 或 ?model= → { models }
app.delete('/api/instances/:id/models', wrap(async (req, res) => {
  const model = req.body?.model || req.query.model;
  res.json({ models: llmprovider.removeModel(req.params.id, model) });
}));

// 设能力绑定：{ capability, instance, model } → { ok, active }
app.post('/api/active', wrap(async (req, res) => {
  const { capability, instance, model } = req.body || {};
  llmprovider.setActiveBinding(capability, instance, model);
  res.json({ ok: true, active: llmprovider.listActive() });
}));

// 生成 / 修订内容大纲：带 comments → 批注改稿（复用 normalizeComments 剔除失效引用）；否则按 topic 首次生成。
// 归一后写权威 doc → SSE 'doc' 推浏览器，走与 Agent 推大纲同一条 relay 路径。改稿不依赖任何人轮询 next。
app.post('/api/generate/outline', wrap(async (req, res) => {
  if (!llmprovider.listActive().chat) {
    return res.status(400).json({ error: '尚未配置模型：请打开右上角「模型设置」添加供应商并绑定「文本」默认模型' });
  }
  const { topic, pages, materials: pastedMaterials, comments } = req.body || {};
  let markdown;
  if (Array.isArray(comments) && comments.length) {
    const cur = relay.getDoc().markdown;
    const clean = normalizeOutline.normalizeComments(comments, cur); // 与 /api/agent/action 同一清洗
    if (clean.length === 0) return res.status(400).json({ error: '批注均已失效（引用不在当前大纲中）' });
    markdown = await genOutline.reviseOutline({ markdown: cur, comments: clean });
  } else {
    // server-gen：把已上传的文本类素材内容折进生成输入（纯人类无 Agent 读素材，故服务端自己读）
    const mat = materials.readMaterialsText();
    const merged = [pastedMaterials, mat.text].filter(Boolean).join('\n\n') || undefined;
    markdown = await genOutline.generateOutline({ topic, pages, materials: merged });
  }
  const o = normalizeOutline.normalizeOutline({ markdown });
  const version = relay.setDoc({ markdown: o.markdown, title: o.title });
  res.json({ ...o, version });
}));

// ---------- 浏览器：服务器推送（SSE） ----------
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // 新连接立即得到当前整册（含各页 scene），支持刷新/重连恢复
  res.write(`event: deck\ndata: ${JSON.stringify(relay.getState())}\n\n`);
  // 同时回放当前内容大纲，后连接的浏览器也能立即拿到阶段1 的 doc
  res.write(`event: doc\ndata: ${JSON.stringify(relay.getDoc())}\n\n`);
  const unsubscribe = relay.subscribe(res);
  req.on('close', unsubscribe);
});

app.post('/api/export', wrap(async (req, res) => {
  const { slides, title, themeId, templateId } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可导出的幻灯片' });
  }
  // SVG-as-IR：每页 slide.svg 经 svgToScene 编译为原生 pptx 对象，无需 Chrome 栅格化
  const d = loadDescriptor(themeId || templateId);
  const buf = await buildPptx(slides, title, d._id, { canvas: d.canvas });
  const filename = encodeURIComponent((title || 'slides') + '.pptx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(Buffer.from(buf));
}));

// body-parser 等中间件抛出的错误兜底：返回 JSON，避免默认 HTML 错误页让前端只能显示状态码
app.use((err, req, res, next) => {
  // 响应头已发出（SSE 流中、sendFile 传输中途客户端断开等）不能再写 JSON：
  // 交回默认处理器断开连接即可，否则这里二次抛错会把整个进程打挂
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status === 413) {
    const hint = req.path === '/api/templates/extract' ? '模板文件需小于 20MB' : '请求体过大';
    return res.status(413).json({ error: hint });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

function start(port = Number(process.env.PORT) || 3210) {
  return new Promise((resolveStart) => {
    const server = app.listen(port, () => {
      const actual = server.address().port;
      try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: actual, pid: process.pid }), 'utf8');
      } catch { /* 运行时文件写失败不致命，CLI 可退回 --port/PORT */ }
      const ping = setInterval(() => relay.pingAll(), 20000);
      ping.unref(); // 不因心跳阻止进程退出
      const cleanupRuntime = () => { try { fs.unlinkSync(RUNTIME_FILE); } catch { /* 已删则忽略 */ } };
      server.on('close', () => { clearInterval(ping); cleanupRuntime(); });
      // `king-ppt stop` 用 SIGTERM 终止；默认动作会跳过 server.close 的清理，
      // 故显式在退出前删掉运行时文件，避免残留 server.json 误导下条 CLI 命令连到死端口。
      const onSignal = () => { cleanupRuntime(); process.exit(0); };
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
      resolveStart({ server, port: actual });
    });
  });
}

module.exports = { app, start, relay };

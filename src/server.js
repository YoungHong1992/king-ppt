const path = require('path');
const express = require('express');
const { generateOutline, generateSlide, reviseSlides, buildFreeStyle } = require('./agent');
const htmlShot = require('./html-shot');
const { buildPptx } = require('./pptx');
const { setApiKey, getApiKey, BASE_URL, MODEL } = require('./llm');
const llmprovider = require('./llmprovider');
const { loadDescriptor, listDescriptors } = require('./descriptor');
const { resolve } = require('./layout-resolver');
const { extractFromPptx, saveTemplate } = require('./extract');
const sessions = require('./sessions');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function statusOf(err) {
  if (err.code === 'NO_API_KEY') return 401;
  if (err.code === 'SESSION_NOT_FOUND') return 404;
  if (err.code === 'BAD_SESSION_ID' || err.code === 'NO_MODEL_CONFIG' || err.code === 'CAPABILITY_NOT_SUPPORTED') return 400;
  return 500;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(statusOf(err)).json({ error: err.message });
    }
  };
}

app.get('/api/config', (req, res) => {
  res.json({
    hasKey: Boolean(getApiKey()),
    baseURL: BASE_URL(),
    model: MODEL(),
  });
});

app.post('/api/config', (req, res) => {
  setApiKey(req.body.apiKey);
  res.json({ hasKey: Boolean(getApiKey()) });
});

// ---------- 供应商实例与模型管理 ----------
app.get('/api/providers', (req, res) => {
  res.json({
    capabilities: llmprovider.CAPABILITIES,
    capabilityLabels: llmprovider.CAPABILITY_LABELS,
    templates: llmprovider.PROVIDER_TEMPLATES.map((t) => ({
      id: t.id, name: t.name, baseURL: t.baseURL, keyUrl: t.keyUrl || null,
      noKey: Boolean(t.noKey), modelCount: t.models.length,
      short: t.short || t.name[0], color: t.color || '#64748b',
      tagline: t.tagline || '', tag: t.tag || '',
    })),
    instances: llmprovider.listInstances(),
    active: llmprovider.listActive(),
  });
});

app.post('/api/instances', wrap(async (req, res) => {
  const inst = llmprovider.createInstance(req.body || {});
  res.json({ id: inst.id });
}));

app.put('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.updateInstance(req.params.id, req.body || {});
  res.json({ ok: true });
}));

app.delete('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.deleteInstance(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/instances/:id/test', wrap(async (req, res) => {
  res.json(await llmprovider.testInstance(req.params.id, req.body || {}));
}));

app.post('/api/instances/:id/test-model', wrap(async (req, res) => {
  res.json(await llmprovider.testModel(req.params.id, req.body?.model));
}));

app.post('/api/instances/:id/test-models', wrap(async (req, res) => {
  res.json(await llmprovider.testModels(req.params.id));
}));

app.post('/api/instances/:id/remote-models', wrap(async (req, res) => {
  const result = await llmprovider.peekRemoteModels(req.params.id);
  res.json(result);
}));

app.post('/api/instances/:id/models', wrap(async (req, res) => {
  const { id: modelId, caps, enabled } = req.body || {};
  const models = llmprovider.addModel(req.params.id, modelId, caps, enabled);
  res.json({ models });
}));

app.delete('/api/instances/:id/models', wrap(async (req, res) => {
  const models = llmprovider.removeModel(req.params.id, req.body?.model || req.query.model);
  res.json({ models });
}));

app.post('/api/active', wrap(async (req, res) => {
  const { capability, instance, model } = req.body || {};
  llmprovider.setActiveBinding(capability, instance, model);
  res.json({ ok: true, active: llmprovider.listActive() });
}));

// ---------- 模板 ----------
app.get('/api/templates', (req, res) => {
  res.json({ templates: listDescriptors() });
});

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
  const fs = require('fs');
  if (!full.startsWith(path.join(d._dir, 'assets')) || !fs.existsSync(full)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(full);
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

app.post('/api/outline', wrap(async (req, res) => {
  const { topic, pages, extra } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: '请提供主题' });
  const outline = await generateOutline({ topic: topic.trim(), pages, extra });
  res.json(outline);
}));

// SSE：逐页生成并推送（每页附带该模板的场景图）
app.post('/api/slides', async (req, res) => {
  try {
    if (req.body.apiKey) setApiKey(req.body.apiKey);
    const { outline, templateId } = req.body;
    if (!outline || !Array.isArray(outline.pages)) {
      return res.status(400).json({ error: '大纲格式不正确' });
    }
    const d = loadDescriptor(templateId);
    const constraints = d.constraints && d.constraints.chars;
    const freeStyle = buildFreeStyle(d);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('meta', { canvas: d.canvas, templateId: d._id });

    const total = outline.pages.length;
    let degraded = 0; // 重试失败、走了兜底页的页数
    for (let i = 0; i < total; i++) {
      try {
        const slide = await generateSlide({ outline, index: i, constraints, freeStyle });
        if (slide._recovered) degraded++;
        const scene = resolve(d, [slide], { title: outline.title, index: i, total }).slides[0];
        send('slide', { ...slide, scene });
      } catch (err) {
        send('slideError', { index: i, error: err.message });
      }
    }
    send('done', { total, degraded });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`event: fatal\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else {
      res.status(err.code === 'NO_API_KEY' ? 401 : 500).json({ error: err.message });
    }
  }
});

app.post('/api/revise', wrap(async (req, res) => {
  const { slides, instruction, templateId } = req.body;
  if (!Array.isArray(slides) || !instruction) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const d = loadDescriptor(templateId);
  const constraints = d.constraints && d.constraints.chars;
  const result = await reviseSlides({ slides, instruction, constraints });
  const scenes = resolve(d, result, { title: req.body.title }).slides;
  res.json({ slides: result, scenes, canvas: d.canvas });
}));

app.post('/api/export', wrap(async (req, res) => {
  const { slides, title, templateId } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可导出的幻灯片' });
  }
  // free 自由排版页：Chrome headless 截图 → PNG data URL，逐页串行
  const renderFree = async (slide) => {
    const png = await htmlShot.renderToPng(slide.html);
    return { free: true, pngData: `data:image/png;base64,${png.toString('base64')}` };
  };
  const buf = await buildPptx(slides, title, templateId, { renderFree });
  const filename = encodeURIComponent((title || 'slides') + '.pptx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(Buffer.from(buf));
}));

function start(port = Number(process.env.PORT) || 3210) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, port }));
  });
}

module.exports = { app, start };

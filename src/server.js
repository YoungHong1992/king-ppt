const path = require('path');
const express = require('express');
const { generateOutline, generateSlide, reviseSlides } = require('./agent');
const { buildPptx } = require('./pptx');
const { setApiKey, getApiKey, BASE_URL, MODEL } = require('./llm');
const llmprovider = require('./llmprovider');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function statusOf(err) {
  if (err.code === 'NO_API_KEY') return 401;
  if (err.code === 'NO_MODEL_CONFIG' || err.code === 'CAPABILITY_NOT_SUPPORTED') return 400;
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

app.post('/api/outline', wrap(async (req, res) => {
  const { topic, pages, extra } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: '请提供主题' });
  const outline = await generateOutline({ topic: topic.trim(), pages, extra });
  res.json(outline);
}));

// SSE：逐页生成并推送
app.post('/api/slides', async (req, res) => {
  try {
    if (req.body.apiKey) setApiKey(req.body.apiKey);
    const { outline } = req.body;
    if (!outline || !Array.isArray(outline.pages)) {
      return res.status(400).json({ error: '大纲格式不正确' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    for (let i = 0; i < outline.pages.length; i++) {
      try {
        const slide = await generateSlide({ outline, index: i });
        send('slide', slide);
      } catch (err) {
        send('slideError', { index: i, error: err.message });
      }
    }
    send('done', { total: outline.pages.length });
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
  const { slides, instruction } = req.body;
  if (!Array.isArray(slides) || !instruction) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const result = await reviseSlides({ slides, instruction });
  res.json({ slides: result });
}));

app.post('/api/export', wrap(async (req, res) => {
  const { slides, title } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可导出的幻灯片' });
  }
  const buf = await buildPptx(slides, title);
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

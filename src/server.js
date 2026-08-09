const path = require('path');
const express = require('express');
const { generateOutline, generateSlide, reviseSlides } = require('./agent');
const { buildPptx } = require('./pptx');
const { setApiKey, getApiKey, BASE_URL, MODEL } = require('./llm');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function wrap(handler) {
  return async (req, res) => {
    try {
      if (req.body && req.body.apiKey) setApiKey(req.body.apiKey);
      await handler(req, res);
    } catch (err) {
      const status = err.code === 'NO_API_KEY' ? 401 : 500;
      res.status(status).json({ error: err.message });
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

const path = require('path');
const fs = require('fs');
const express = require('express');
const { generateOutline, generateSlide, reviseSlides, buildFreeStyle } = require('./agent');
const htmlShot = require('./html-shot');
const { buildPptx } = require('./pptx');
const { setApiKey, getApiKey, BASE_URL, MODEL } = require('./llm');
const llmprovider = require('./llmprovider');
const { loadDescriptor, listDescriptors } = require('./descriptor');
const { resolve } = require('./layout-resolver');
const { validateSlide } = require('./validate');
const assets = require('./assets');
const { extractFromPptx, saveTemplate } = require('./extract');
const { parseSourcePages } = require('./pptx-pages');
const sessions = require('./sessions');

const app = express();
// 上传模板以 base64 进 JSON（extract 上限 20MB → base64 约 27MB），单独放宽；其余路由维持 2mb
const jsonBody = express.json({ limit: '2mb' });
const jsonBodyLarge = express.json({ limit: '30mb' });
app.use((req, res, next) => {
  if (req.path === '/api/templates/extract') return jsonBodyLarge(req, res, next);
  jsonBody(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

function statusOf(err) {
  if (err.code === 'NO_API_KEY') return 401;
  if (err.code === 'SESSION_NOT_FOUND' || err.code === 'ASSET_NOT_FOUND') return 404;
  if (err.code === 'BAD_SESSION_ID' || err.code === 'NO_MODEL_CONFIG' || err.code === 'CAPABILITY_NOT_SUPPORTED' || err.code === 'BAD_ASSET_NAME') return 400;
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
// 幻灯片带 imagePrompt 且已配置生图模型时：生成 → 存 ~/.king-ppt/assets → slide.image
// 失败不阻断生成（页面上只是没有配图），标记 _imageSkipped 供前端提示
async function attachSlideImage(slide) {
  if (!slide.imagePrompt || slide.image) return;
  try {
    const result = await llmprovider.generateImage(slide.imagePrompt, { size: '1024x1024' });
    slide.image = result.b64
      ? assets.saveImageBase64(result.b64, 'png')
      : await assets.saveImageFromUrl(result.url);
  } catch (err) {
    slide._imageSkipped = String(err.message || err);
  }
}

function imageCapabilityOn() {
  try {
    return Boolean(llmprovider.listActive().image);
  } catch {
    return false;
  }
}

// 生成配图文件（slide.image.url 引用）
app.get('/api/assets/:file', wrap(async (req, res) => {
  const full = assets.resolveAsset(req.params.file);
  res.sendFile(full);
}));

// ---------- 幻灯片生成管线 ----------
// 单页生成的公共出口：配图 → 场景图 → 质量校验
async function materializeSlide({ slide, d, outline, index }) {
  await attachSlideImage(slide);
  const total = outline.pages.length;
  const scene = resolve(d, [slide], { title: outline.title, index, total }).slides[0];
  const warnings = scene
    ? validateSlide({ slide, scene, canvas: d.canvas, constraints: d.constraints && d.constraints.chars, index })
    : [];
  return { slide, scene, warnings };
}

app.post('/api/outline', wrap(async (req, res) => {
  const { topic, pages, extra } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: '请提供主题' });
  const outline = await generateOutline({ topic: topic.trim(), pages, extra });
  res.json(outline);
}));

// SSE：逐页生成并推送（每页附带该模板的场景图 + 质量警告；首页过门禁）
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
    send('meta', { canvas: d.canvas, templateId: d._id, imageCapable: imageCapabilityOn() });

    const total = outline.pages.length;
    let degraded = 0; // 重试失败、走了兜底页的页数
    for (let i = 0; i < total; i++) {
      try {
        let out = await materializeSlide({
          slide: await generateSlide({ outline, index: i, constraints, freeStyle }),
          d, outline, index: i,
        });
        if (out.slide._recovered) degraded++;
        // 首页门禁：封面出 error 级问题会让整本气质崩掉，带反馈重试一次，仍差则保留较好版本
        if (i === 0 && out.warnings.some((w) => w.level === 'error')) {
          const feedback = out.warnings.filter((w) => w.level !== 'info').map((w) => `- ${w.message}`).join('\n');
          const retry = await materializeSlide({
            slide: await generateSlide({ outline, index: i, constraints, freeStyle, feedback }),
            d, outline, index: i,
          });
          const errs = (ws) => ws.filter((w) => w.level === 'error').length;
          if (errs(retry.warnings) < errs(out.warnings)) out = retry;
        }
        send('slide', { ...out.slide, scene: out.scene, warnings: out.warnings });
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

// 单页重新生成（换内容重写该页；feedback 可选注入修正要求）
app.post('/api/slide/regen', wrap(async (req, res) => {
  const { outline, index, templateId, feedback } = req.body;
  if (!outline || !Array.isArray(outline.pages) || !(index >= 0 && index < outline.pages.length)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const d = loadDescriptor(templateId);
  const constraints = d.constraints && d.constraints.chars;
  const slide = await generateSlide({ outline, index, constraints, freeStyle: buildFreeStyle(d), feedback });
  const out = await materializeSlide({ slide, d, outline, index });
  res.json(out);
}));

// 本地重排：slides 不变（就地编辑 / 换版式 / 换模板后），只重算场景图与警告
// total 可选（单页重排时传整本页数，页脚页码才正确）；index 用 slide.index（真实页位）
app.post('/api/reresolve', wrap(async (req, res) => {
  const { slides, templateId, title, total } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可重排的幻灯片' });
  }
  const d = loadDescriptor(templateId);
  const constraints = d.constraints && d.constraints.chars;
  const deckTotal = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : slides.length;
  const scenes = [];
  const warningsList = [];
  for (let pos = 0; pos < slides.length; pos++) {
    const slide = slides[pos] || {};
    if (slide.type === 'free') {
      scenes.push(null);
      warningsList.push([]);
      continue;
    }
    const index = Number.isFinite(Number(slide.index)) ? Number(slide.index) : pos;
    const scene = resolve(d, [slide], { title, index, total: deckTotal }).slides[0];
    scenes.push(scene);
    warningsList.push(validateSlide({ slide, scene, canvas: d.canvas, constraints, index }));
  }
  res.json({ scenes, warningsList, canvas: d.canvas, templateId: d._id });
}));

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
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, port }));
  });
}

module.exports = { app, start };

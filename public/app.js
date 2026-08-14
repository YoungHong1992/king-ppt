// ---------- 状态 ----------
const state = {
  outline: null,
  slides: [],        // 已生成的页（含 index）
  phase: 'idle',     // idle | outline | slides
  topic: '',
  pages: 8,
  busy: false,
  templateId: localStorage.getItem('king-ppt.template') || 'classic-blue',
  templates: [],     // /api/templates 列表缓存
  canvas: null,      // 当前模板画布（SSE meta / revise 响应更新）
  sessionId: null,   // 当前会话（后端持久化）
  sessions: [],      // /api/sessions 列表缓存
  messages: [],      // 结构化对话记录（持久化 & 恢复用）
  category: '全部',  // 首页模板分类
  providersData: null,          // /api/providers 缓存
  settingsView: 'services',     // 设置面板当前视图：services | defaults
  selectedInstanceId: undefined, // 模型服务当前展开的供应商（undefined=默认展开第一个，null=全部收起）
};

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const slidesEl = $('slides');
const inputEl = $('input');

// ---------- API ----------
async function api(path, body, method = 'POST') {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${resp.status})`);
  }
  return resp;
}

// ---------- Toast ----------
// 原生 <dialog> 在浏览器 top layer 中，任何 z-index 都压不过它；
// 设置弹窗打开期间把 toast 挂进 dialog 内部（跟随进入 top layer），保证始终最顶可见
function toastHost() {
  if (typeof settingsDialog !== 'undefined' && settingsDialog.open) {
    let host = settingsDialog.querySelector('#toasts-dialog');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts-dialog';
      settingsDialog.appendChild(host);
    }
    return host;
  }
  return $('toasts');
}
// 淡出并收拢高度，其余 toast 顺势上移顶替
function dismissToast(el) {
  if (!el || el.classList.contains('out')) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 420);
}
function toast(text, type = 'info', duration = 3200) {
  const div = document.createElement('div');
  div.className = `toast ${type === 'error' ? 'error' : type === 'ok' ? 'ok' : ''}`;
  const icon = type === 'ok' ? CHECK_ICON : type === 'error' ? X_ICON : '';
  div.innerHTML = `${icon ? `<span class="toast-icon">${icon}</span>` : ''}<span class="toast-text"></span>`;
  div.querySelector('.toast-text').textContent = text;
  const host = toastHost();
  // 最多同时在场 4 条（含淡入/淡出中的），超出的最早一条向上淡出顶替
  const live = () => [...host.children].filter((c) => !c.classList.contains('out'));
  while (live().length >= 4) dismissToast(live()[0]);
  host.appendChild(div);
  setTimeout(() => dismissToast(div), duration);
}

// ---------- 消息 ----------
function addMessage(text, who = 'user', isError = false) {
  const div = document.createElement('div');
  div.className = `msg msg-${who}${isError ? ' error' : ''}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  state.messages.push({ role: who, text, error: isError, ts: Date.now() });
  scheduleSave();
  return div;
}

function addTyping(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-agent';
  div.innerHTML = `${text ? `<div class="muted" style="font-size:12px;margin-bottom:6px">${esc(text)}</div>` : ''}
    <span class="typing"><i></i><i></i><i></i></span>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function finishTyping(div, text, isError = false) {
  div.textContent = text;
  if (isError) div.classList.add('error');
  messagesEl.scrollTop = messagesEl.scrollHeight;
  state.messages.push({ role: 'agent', text, error: isError, ts: Date.now() });
  scheduleSave();
}

// 从持久化的 messages 数组重建对话气泡（不含打字动画）
function renderMessages() {
  for (const m of state.messages) {
    const div = document.createElement('div');
    div.className = `msg msg-${m.role}${m.error ? ' error' : ''}`;
    div.textContent = m.text;
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  ['send-btn', 'gen-slides-btn', 'home-send-btn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
  inputEl.disabled = busy;
  const hi = $('home-input');
  if (hi) hi.disabled = busy;
}

// ---------- 视图切换（idle 首页 ↔ 工作视图） ----------
function showView() {
  const idle = state.phase === 'idle';
  $('home').classList.toggle('hidden', !idle);
  $('work-view').classList.toggle('hidden', idle);
}

// ---------- 大纲 ----------
function updateOutlineHint() {
  $('outline-hint').textContent = state.phase === 'slides'
    ? '点击条目可定位到对应页'
    : '可修改页数后重新生成';
}

// 点击大纲条目：平滑滚动到对应幻灯片并高亮闪烁
function scrollToSlide(i) {
  const card = slidesEl.querySelector(`.slide-card[data-index="${i}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth; // 重启动画
  card.classList.add('flash');
}

function renderOutline(outline) {
  const box = $('outline-box');
  box.classList.remove('hidden', 'collapsed');
  // 模板选择条只在「待生成」阶段出现；生成后切换模板不会重排已有页，不再展示
  $('outline-tpl').classList.toggle('hidden', state.phase !== 'outline');
  updateOutlineHint();
  const list = $('outline-list');
  list.innerHTML = '';
  const titleDiv = document.createElement('div');
  titleDiv.className = 'outline-title';
  titleDiv.textContent = `《${outline.title}》`;
  list.appendChild(titleDiv);
  outline.pages.forEach((p, i) => {
    const item = document.createElement('div');
    const clickable = state.phase === 'slides' && Boolean(state.slides[i]);
    item.className = `outline-item${clickable ? ' clickable' : ''}`;
    item.innerHTML = `<span class="no">${i + 1}</span><span>${esc(p.heading)} — ${esc(p.intent)}</span>`;
    if (clickable) {
      item.title = '点击定位到该页';
      item.addEventListener('click', () => scrollToSlide(i));
    }
    list.appendChild(item);
  });
  renderOutlineTplPicker();
}

async function doOutline(topic, pages) {
  state.topic = topic;
  setBusy(true);
  const msg = addTyping('正在生成大纲');
  try {
    const resp = await api('/api/outline', { topic, pages });
    const outline = await resp.json();
    state.outline = outline;
    state.phase = 'outline';
    finishTyping(msg, `大纲已生成：《${outline.title}》，共 ${outline.pages.length} 页。确认后点击「生成幻灯片」。`);
    $('work-title').textContent = `《${outline.title}》`;
    renderOutline(outline);
    scheduleSave();
  } catch (err) {
    finishTyping(msg, `大纲生成失败：${err.message}`, true);
    toast(err.message, 'error');
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

// ---------- 幻灯片（SSE 逐页） ----------
function updateProgress(done, total) {
  const bar = $('progress-bar');
  bar.classList.remove('hidden');
  $('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
}

async function doSlides() {
  if (!state.outline) return;
  state.slides = [];
  slidesEl.innerHTML = '';
  $('empty-tip').style.display = 'none';
  setBusy(true);
  const msg = addTyping('正在逐页生成幻灯片');

  try {
    const resp = await fetch('/api/slides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outline: state.outline, templateId: state.templateId }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = 0;
    const total = state.outline.pages.length;
    updateProgress(0, total);

    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const chunk of events) {
        const eventMatch = chunk.match(/^event: (\w+)/m);
        const dataMatch = chunk.match(/^data: (.*)$/m);
        if (!eventMatch || !dataMatch) continue;
        const event = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);
        if (event === 'meta') {
          state.canvas = data.canvas;
        } else if (event === 'slide') {
          state.slides[data.index] = data;
          renderSlide(data);
          done++;
          updateProgress(done, total);
          scheduleSave();
        } else if (event === 'slideError') {
          addMessage(`第 ${data.index + 1} 页生成失败：${data.error}`, 'agent', true);
        } else if (event === 'done') {
          const note = data.degraded
            ? `其中 ${data.degraded} 页多次生成异常，已按大纲自动降级为基础版式（可用修改指令重写该页）。`
            : '';
          finishTyping(msg, `全部 ${total} 页生成完成。${note}可以继续输入修改指令，或点击右上角导出。`);
          state.phase = 'slides';
          renderOutline(state.outline); // 重建为可点击定位形态
          $('outline-box').classList.add('collapsed'); // 收起，点标题栏可再展开
          $('export-btn').disabled = false;
          toast('幻灯片生成完成', 'ok');
          flushSave(); // 成品立即落盘，防止快速关闭丢失
        } else if (event === 'fatal') {
          finishTyping(msg, `生成中断：${data.error}`, true);
        }
      }
    }
  } catch (err) {
    finishTyping(msg, `生成失败：${err.message}`, true);
    toast(err.message, 'error');
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

// ---------- 局部修改 ----------
async function doRevise(instruction) {
  setBusy(true);
  const msg = addTyping('正在修改');
  try {
    const resp = await api('/api/revise', { slides: state.slides, instruction, templateId: state.templateId, title: state.outline?.title });
    const data = await resp.json();
    state.slides = data.slides;
    if (data.canvas) state.canvas = data.canvas;
    // scenes 与 slides 等长，按 index 对应：挂到 slide 上供 renderSlide 使用
    (data.scenes || []).forEach((scene, i) => {
      if (state.slides[i]) state.slides[i].scene = scene;
    });
    slidesEl.innerHTML = '';
    state.slides.forEach((s) => s && renderSlide(s));
    finishTyping(msg, '修改完成。');
    scheduleSave();
  } catch (err) {
    finishTyping(msg, `修改失败：${err.message}`, true);
    toast(err.message, 'error');
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

// ---------- 预览渲染 ----------
function renderSlide(s) {
  let card = slidesEl.querySelector(`[data-index="${s.index}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'slide-card';
    card.dataset.index = s.index;
    slidesEl.appendChild(card);
    // 保持按 index 排序
    [...slidesEl.children]
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .forEach((el) => slidesEl.appendChild(el));
  }
  const num = `<div class="slide-num">${s.index + 1}</div>`;
  // free 自由排版页：HTML iframe 渲染，不走场景图
  if (s.type === 'free' && s.html) {
    card.innerHTML = num;
    card.appendChild(HtmlFrame.build(s.html));
    return;
  }
  // Scene Graph 驱动渲染（新数据）；无 scene 的旧数据走下方手写渲染兜底
  if (s.scene) {
    card.innerHTML = num;
    card.appendChild(DomPainter.paintInto(s.scene, state.templateId, state.canvas || undefined));
    return;
  }
  let inner = '';
  if (s.type === 'title' || s.type === 'section') {
    inner = `<div class="slide slide-cover">
      <div class="cover-title">${esc(s.title)}</div>
      ${s.subtitle ? `<div class="cover-subtitle">${esc(s.subtitle)}</div>` : ''}
    </div>`;
  } else if (s.type === 'bullets') {
    inner = `<div class="slide">
      <div class="slide-title">${esc(s.title)}</div><div class="title-bar"></div>
      <ul class="slide-bullets">${(s.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`;
  } else if (s.type === 'twoColumn') {
    const col = (t, bs) => `<div class="col">
      <div class="col-title">${esc(t)}</div>
      <ul>${(bs || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`;
    inner = `<div class="slide">
      <div class="slide-title">${esc(s.title)}</div><div class="title-bar"></div>
      <div class="cols">${col(s.leftTitle, s.leftBullets)}${col(s.rightTitle, s.rightBullets)}</div>
    </div>`;
  } else if (s.type === 'table') {
    const rows = (s.rows || []).map((r) => (Array.isArray(r) ? r : [r]));
    inner = `<div class="slide">
      <div class="slide-title">${esc(s.title)}</div><div class="title-bar"></div>
      <table class="slide-table">
        <thead><tr>${(s.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
  } else if (s.type === 'steps') {
    inner = `<div class="slide">
      <div class="slide-title">${esc(s.title)}</div><div class="title-bar"></div>
      <div class="steps">${(s.steps || []).map((st, i) => `<div class="step">
        <div class="step-num">${i + 1}</div>
        <div class="step-title">${esc(st.title)}</div>
        <div class="step-desc">${esc(st.desc)}</div>
      </div>`).join('')}</div>
    </div>`;
  } else if (s.type === 'quote') {
    inner = `<div class="slide slide-quote">
      <div class="quote-mark">“</div>
      <div class="quote-text">${esc(s.quote)}</div>
      ${s.author ? `<div class="quote-author">—— ${esc(s.author)}</div>` : ''}
    </div>`;
  } else if (s.type === 'stats') {
    inner = `<div class="slide">
      <div class="slide-title">${esc(s.title)}</div><div class="title-bar"></div>
      <div class="stats">${(s.stats || []).map((st) => `<div class="stat">
        <div class="stat-value">${esc(st.value)}</div>
        <div class="stat-label">${esc(st.label)}</div>
      </div>`).join('')}</div>
    </div>`;
  }
  card.innerHTML = num + inner;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ================= 模板 =================
const tplSampleCache = {}; // templateId → { canvas, scenes }

// 首页分类 tab（对标 Kimi）；真实模板归入 全部/自定义，行业分类用占位卡填充
const HOME_CATEGORIES = ['全部', '自定义', '战略咨询', '金融投资', '工作汇报', '宣传推广', '学术研究'];
// 纯色占位卡：真实模板补齐前的视觉填充，点击提示即将上线
const FAKE_TEMPLATES = [
  { name: '战略蓝图', color: '#1f4e79', category: '战略咨询' },
  { name: '咨询灰调', color: '#334155', category: '战略咨询' },
  { name: '金融鎏金', color: '#b7791f', category: '金融投资' },
  { name: '资本深红', color: '#9b2c2c', category: '金融投资' },
  { name: '汇报青绿', color: '#0f766e', category: '工作汇报' },
  { name: '简报天青', color: '#2e86c1', category: '工作汇报' },
  { name: '推广品红', color: '#be185d', category: '宣传推广' },
  { name: '活力橙', color: '#c2410c', category: '宣传推广' },
  { name: '学术墨蓝', color: '#1e3a5f', category: '学术研究' },
  { name: '研究石青', color: '#0e7490', category: '学术研究' },
];

async function loadTemplates() {
  try {
    const resp = await api('/api/templates', undefined, 'GET');
    const data = await resp.json();
    state.templates = data.templates || [];
    renderHomeTemplates();
    renderTemplateChip();
    // 启动时用当前模板的画布初始化（SSE meta / revise 也会更新）
    if (state.templates.some((t) => t.id === state.templateId)) {
      fetchTplSample(state.templateId).then(({ canvas }) => { state.canvas = canvas; }).catch(() => {});
    }
  } catch (err) {
    const grid = $('home-grid');
    if (grid) grid.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:12px">模板列表加载失败：${esc(err.message)}</div>`;
  }
}

// ---------- 首页模板网格 + 分类 tab ----------
function renderHomeTemplates() {
  renderHomeTabs();
  renderHomeGrid();
}

function renderHomeTabs() {
  const wrap = $('home-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const cat of HOME_CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = `home-tab${cat === state.category ? ' active' : ''}`;
    btn.textContent = cat;
    btn.addEventListener('click', () => { state.category = cat; renderHomeTemplates(); });
    wrap.appendChild(btn);
  }
}

function renderHomeGrid() {
  const grid = $('home-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const cat = state.category;
  if (cat === '全部' || cat === '自定义') {
    const reals = cat === '自定义'
      ? state.templates.filter((t) => t.source === 'uploaded')
      : state.templates;
    for (const tpl of reals) grid.appendChild(buildHomeCard(tpl));
    grid.appendChild(buildHomeUploadCard());
    if (cat === '全部') {
      for (const f of FAKE_TEMPLATES) grid.appendChild(buildFakeCard(f));
    }
  } else {
    for (const f of FAKE_TEMPLATES.filter((f) => f.category === cat)) grid.appendChild(buildFakeCard(f));
  }
}

function buildHomeCard(tpl) {
  const card = document.createElement('div');
  card.className = `home-card${tpl.id === state.templateId ? ' active' : ''}`;
  card.dataset.tpl = tpl.id;
  card.innerHTML = `
    <div class="home-card-thumb"><div class="home-card-thumb-loading muted">…</div></div>
    <div class="home-card-meta">
      <span class="home-card-name">${esc(tpl.name)}</span>
      <span class="home-card-tag ${tpl.source === 'uploaded' ? 'uploaded' : ''}">${tpl.source === 'uploaded' ? '上传' : '预设'}</span>
    </div>`;
  card.addEventListener('click', () => selectTemplate(tpl.id));
  // paintThumb 成功/失败都会重建缩略图内容，按钮须在其之后再挂
  paintThumb(tpl.id, card.querySelector('.home-card-thumb')).finally(() => attachPreviewBtn(card, tpl.id));
  return card;
}

function buildHomeUploadCard() {
  const card = document.createElement('div');
  card.className = 'home-card upload';
  card.innerHTML = `
    <div class="home-card-thumb">
      <div class="home-card-thumb-plus">＋</div>
      <div class="muted" style="font-size:12px">上传 .pptx 模板</div>
    </div>
    <div class="home-card-meta"><span class="home-card-name">上传模板</span></div>`;
  card.addEventListener('click', () => $('tpl-upload-input').click());
  return card;
}

function buildFakeCard(fake) {
  const card = document.createElement('div');
  card.className = 'home-card fake';
  card.innerHTML = `
    <div class="home-card-thumb" style="background:linear-gradient(135deg, ${fake.color}, ${fake.color}cc)">
      <span class="home-card-badge">即将上线</span>
    </div>
    <div class="home-card-meta"><span class="home-card-name">${esc(fake.name)}</span><span class="home-card-tag">${esc(fake.category)}</span></div>`;
  card.addEventListener('click', () => toast('该模板即将上线，敬请期待', 'info'));
  return card;
}

// 输入框工具条上的当前模板 chip
function renderTemplateChip() {
  const tpl = state.templates.find((t) => t.id === state.templateId);
  const nameEl = document.querySelector('#home-tpl-chip .home-tpl-chip-name');
  const thumbEl = document.querySelector('#home-tpl-chip .home-tpl-chip-thumb');
  if (nameEl) nameEl.textContent = tpl ? tpl.name : '选择模板';
  if (thumbEl && tpl) paintThumb(tpl.id, thumbEl);
}

// 模板卡片（大纲内选择条复用）
function buildTplCard(tpl) {
  const card = document.createElement('div');
  card.className = `tpl-card${tpl.id === state.templateId ? ' active' : ''}`;
  card.dataset.tpl = tpl.id;
  card.innerHTML = `
    <div class="tpl-thumb"><div class="tpl-thumb-loading muted">…</div></div>
    <div class="tpl-meta">
      <span class="tpl-name">${esc(tpl.name)}</span>
      <span class="tpl-source ${tpl.source === 'uploaded' ? 'uploaded' : ''}">${tpl.source === 'uploaded' ? '上传' : '预设'}</span>
    </div>`;
  card.addEventListener('click', () => selectTemplate(tpl.id));
  paintThumb(tpl.id, card.querySelector('.tpl-thumb')).finally(() => attachPreviewBtn(card, tpl.id));
  return card;
}

function buildTplUploadCard() {
  const upload = document.createElement('div');
  upload.className = 'tpl-card tpl-upload';
  upload.innerHTML = `<div class="tpl-upload-plus">＋</div><div class="tpl-upload-text">上传模板</div>`;
  upload.addEventListener('click', () => $('tpl-upload-input').click());
  return upload;
}

// 大纲卡片内的模板选择条：生成前的模板决策点
function renderOutlineTplPicker() {
  const wrap = $('outline-tpl-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const tpl of state.templates) wrap.appendChild(buildTplCard(tpl));
  wrap.appendChild(buildTplUploadCard());
}

async function fetchTplSample(id) {
  if (!tplSampleCache[id]) {
    const resp = await api(`/api/templates/${encodeURIComponent(id)}/sample`, undefined, 'GET');
    tplSampleCache[id] = await resp.json();
  }
  return tplSampleCache[id];
}

async function paintThumb(id, thumbEl) {
  try {
    const { canvas, scenes } = await fetchTplSample(id);
    thumbEl.innerHTML = '';
    if (scenes && scenes[0]) {
      thumbEl.appendChild(DomPainter.paintInto(scenes[0], id, canvas));
    }
  } catch {
    thumbEl.innerHTML = '<div class="muted" style="font-size:11px;display:flex;height:100%;align-items:center;justify-content:center">预览失败</div>';
  }
}

// ---------- 模板整册预览 ----------
const tplPreviewCache = new Map();
const TYPE_LABELS = {
  title: '封面', section: '章节页', bullets: '要点页', twoColumn: '两栏对比',
  table: '数据表格', steps: '流程步骤', quote: '金句页', stats: '关键数字',
};

async function fetchTplPreview(id) {
  if (!tplPreviewCache.has(id)) {
    const resp = await api(`/api/templates/${encodeURIComponent(id)}/preview`, undefined, 'GET');
    tplPreviewCache.set(id, await resp.json());
  }
  return tplPreviewCache.get(id);
}

// 卡片缩略图右下角的悬浮「预览」按钮
function attachPreviewBtn(card, id) {
  const thumb = card.querySelector('.home-card-thumb, .tpl-thumb');
  if (!thumb) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tpl-preview-btn';
  btn.textContent = '预览';
  btn.addEventListener('click', (e) => { e.stopPropagation(); openTplPreview(id); });
  thumb.appendChild(btn);
}

// source.pptx 原件页 → DOM（与 DomPainter 同样的单位换算：英寸→百分比，pt→cqh）
function paintSourcePage(page, canvas, templateId) {
  const W = canvas.width;
  const H = canvas.height;
  const el = document.createElement('div');
  el.className = 'slide sp-source';
  el.style.aspectRatio = `${W} / ${H}`;
  const xPct = (v) => `${(v / W) * 100}%`;
  const yPct = (v) => `${(v / H) * 100}%`;
  const ptCqh = (pt) => `${((pt / 72) / H) * 100}cqh`;
  const rgba = (hex, transparency) => {
    if (!hex) return null;
    const h = String(hex).replace('#', '');
    if (h.length !== 6) return null;
    if (!transparency) return `#${h}`;
    const a = Math.max(0, Math.min(1, 1 - transparency / 100));
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
  };
  const mediaUrl = (name) => `/api/templates/${encodeURIComponent(templateId)}/media/${encodeURIComponent(name)}`;
  const fillCss = (fill) => {
    if (!fill || fill.none) return '';
    if (fill.gradient) {
      const dir = fill.gradient.direction === 'vertical' ? 'to bottom' : 'to right';
      const stops = fill.gradient.stops
        .map((s) => `${rgba(s.color, s.transparency) || '#000'} ${Math.round(s.pos * 100)}%`)
        .join(', ');
      return `background:linear-gradient(${dir}, ${stops});`;
    }
    const c = rgba(fill.color, fill.transparency);
    return c ? `background:${c};` : '';
  };
  const SHAPE_CSS = {
    ellipse: 'border-radius:50%;',
    roundRect: 'border-radius:1.2cqh;',
    triangle: 'clip-path:polygon(50% 0,100% 100%,0 100%);',
    diamond: 'clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);',
    parallelogram: 'clip-path:polygon(18% 0,100% 0,82% 100%,0 100%);',
    chevron: 'clip-path:polygon(0 0,86% 0,100% 50%,86% 100%,0 100%);',
    hexagon: 'clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);',
    rightArrow: 'clip-path:polygon(0 25%,68% 25%,68% 0,100% 50%,68% 100%,68% 75%,0 75%);',
  };
  // 原件未标注字号时按框高估一档（单行占框高约 7 成，多行按正文字号）
  const guessSize = (o) => {
    const hPt = (o.bbox ? o.bbox[3] : 0) * 72;
    return Math.round((o.texts || []).length <= 1 ? Math.min(60, Math.max(10, hPt * 0.72)) : 16);
  };

  el.style.background = (page.background && rgba(page.background.color)) || '#fff';
  let bgHtml = '';
  if (page.background) {
    if (page.background.image) {
      bgHtml = `<img class="sp-img" style="left:0;top:0;width:100%;height:100%" src="${mediaUrl(page.background.image)}" alt="">`;
    } else if (page.background.gradient) {
      bgHtml = `<div class="sp-shape" style="left:0;top:0;width:100%;height:100%;${fillCss(page.background)}"></div>`;
    }
  }
  el.innerHTML = bgHtml + (page.objects || []).map((o) => {
    const [x, y, w, h] = o.bbox;
    const box = `left:${xPct(x)};top:${yPct(y)};width:${xPct(w)};height:${yPct(h)};`
      + (o.rot ? `transform:rotate(${o.rot}deg);` : '');
    if (o.type === 'image') {
      return `<img class="sp-img" style="${box}" src="${mediaUrl(o.media)}" alt="">`;
    }
    if (o.shape === 'line') {
      const lw = ptCqh((o.line && o.line.width) || 1);
      const c = rgba(o.line && o.line.color) || '#666';
      if (h <= 0.05) return `<div class="sp-shape" style="${box}height:${lw};background:${c};"></div>`;
      if (w <= 0.05) return `<div class="sp-shape" style="${box}width:${lw};background:${c};"></div>`;
      // 斜线：按对角线长度旋转近似
      const len = Math.sqrt(w * w + h * h);
      const ang = Math.round((Math.atan2(h, w) * 180) / Math.PI);
      return `<div class="sp-shape" style="left:${xPct(x + w / 2)};top:${yPct(y + h / 2)};width:${xPct(len)};height:${lw};background:${c};transform:translate(-50%,-50%) rotate(${ang}deg);"></div>`;
    }
    let css = box + fillCss(o.fill);
    if (o.line && o.line.color) {
      css += `border:${ptCqh(o.line.width || 1)} solid ${rgba(o.line.color) || '#666'};`;
    }
    css += SHAPE_CSS[o.shape] || '';
    let texts = '';
    if (o.texts && o.texts.length) {
      const paras = o.texts.map((p) => {
        const sizes = p.runs.map((r) => r.size).filter(Boolean);
        const size = sizes.length ? Math.max(...sizes) : guessSize(o);
        const spans = p.runs.map((r) => {
          const style = (r.color && rgba(r.color) ? `color:${rgba(r.color)};` : '')
            + (r.bold ? 'font-weight:700;' : '')
            + (r.italic ? 'font-style:italic;' : '')
            + (r.font ? `font-family:'${esc(r.font)}','Microsoft YaHei',sans-serif;` : '');
          return style ? `<span style="${style}">${esc(r.text)}</span>` : esc(r.text);
        }).join('');
        const align = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[p.align] || 'left';
        return `<div class="sp-para" style="font-size:${ptCqh(size)};text-align:${align};">${spans}</div>`;
      }).join('');
      texts = `<div class="sp-texts" data-anchor="${o.anchor || 't'}">${paras}</div>`;
    }
    return `<div class="sp-shape" style="${css}">${texts}</div>`;
  }).join('');
  return el;
}

async function openTplPreview(id) {
  let data;
  try {
    data = await fetchTplPreview(id);
  } catch (err) {
    toast(`模板预览失败：${err.message}`, 'error');
    return;
  }
  const pages = data.kind === 'source' ? data.pages : data.scenes;
  if (!pages || pages.length === 0) {
    toast('该模板暂无可预览的页面', 'info');
    return;
  }
  const cur = { page: 0 };
  const overlay = document.createElement('div');
  overlay.className = 'tpl-preview-overlay';
  overlay.innerHTML = `
    <div class="tpl-preview-panel">
      <div class="tpl-preview-head">
        <span class="tpl-preview-name">${esc(data.name || '模板预览')}</span>
        <span class="tpl-preview-kind">${data.kind === 'source' ? '原件逐页' : '版式效果'}</span>
        <button class="tpl-preview-close" type="button" title="关闭 (Esc)">✕</button>
      </div>
      <div class="tpl-preview-stage"></div>
      <div class="tpl-preview-foot">
        <button class="tpl-preview-nav" type="button" data-nav="prev">◀ 上一页</button>
        <span class="tpl-preview-page"></span>
        <button class="tpl-preview-nav" type="button" data-nav="next">下一页 ▶</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('.tpl-preview-stage');
  const pageEl = overlay.querySelector('.tpl-preview-page');
  const prevBtn = overlay.querySelector('[data-nav="prev"]');
  const nextBtn = overlay.querySelector('[data-nav="next"]');
  const render = () => {
    stage.innerHTML = '';
    const el = data.kind === 'source'
      ? paintSourcePage(pages[cur.page], data.canvas, id)
      : DomPainter.paintInto(pages[cur.page], id, data.canvas);
    stage.appendChild(el);
    const label = data.kind === 'descriptor' && data.types ? ` · ${TYPE_LABELS[data.types[cur.page]] || ''}` : '';
    pageEl.textContent = `${cur.page + 1} / ${pages.length}${label}`;
    prevBtn.disabled = cur.page === 0;
    nextBtn.disabled = cur.page === pages.length - 1;
  };
  const prev = () => { if (cur.page > 0) { cur.page -= 1; render(); } };
  const next = () => { if (cur.page < pages.length - 1) { cur.page += 1; render(); } };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  };
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);
  overlay.querySelector('.tpl-preview-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  render();
}

async function selectTemplate(id) {
  if (id === state.templateId) return;
  state.templateId = id;
  localStorage.setItem('king-ppt.template', id);
  document.querySelectorAll('.tpl-card[data-tpl], .home-card[data-tpl]').forEach((c) => {
    c.classList.toggle('active', c.dataset.tpl === id);
  });
  renderTemplateChip();
  try {
    const { canvas } = await fetchTplSample(id);
    state.canvas = canvas;
  } catch { /* 画布沿用旧值，meta 事件也会更新 */ }
  // 已有 slides 用新模板场景重渲染（场景随 SSE/revise 下发，旧场景沿用各自模板重画）
  state.slides.forEach((s) => s && s.scene && renderSlide(s));
  scheduleSave();
}

// ---------- 上传模板 → 确认面板 ----------
$('tpl-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // 允许重复选同一文件
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast('文件超过 20MB 上限', 'error');
    return;
  }
  const msg = addTyping(`正在解析模板「${file.name}」`);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(',')[1] || '';
    const resp = await api('/api/templates/extract', { name: file.name, data: base64 });
    const result = await resp.json();
    finishTyping(msg, `模板「${file.name}」解析完成，请在确认面板中核对识别结果。`);
    openTemplateConfirm(result);
  } catch (err) {
    finishTyping(msg, `模板解析失败：${err.message}`, true);
    toast(`模板解析失败：${err.message}`, 'error');
  }
});

const CONFIDENCE_LABELS = {
  canvas: '画布', palette: '色板', typography: '字体', background: '背景',
  decorations: '装饰构件', families: '页面家族', typeMapping: '类型映射',
};
const FAMILY_LABELS = { cover: '封面', section: '章节页', content: '内容页', closing: '结尾页' };

function openTemplateConfirm({ stagingId, descriptor, sampleScenes }) {
  const d = descriptor || {};
  const canvas = d.canvas || { width: 13.33, height: 7.5 };
  const overlay = document.createElement('div');
  overlay.className = 'tpl-confirm-overlay';
  overlay.innerHTML = `
    <div class="tpl-confirm">
      <div class="tpl-confirm-head">
        <span>确认模板识别结果</span>
        <button class="btn btn-icon" data-role="close" title="关闭">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="tpl-confirm-body">
        <div class="tpl-confirm-left" data-role="samples"></div>
        <div class="tpl-confirm-right">
          <div class="tpl-sec">
            <div class="tpl-sec-title">识别结果</div>
            <div class="tpl-palette">
              ${Object.entries(d.palette || {}).map(([role, hex]) => `
                <div class="tpl-swatch" title="${esc(role)} #${esc(hex)}">
                  <span class="tpl-swatch-color" style="background:#${esc(hex)}"></span>
                  <span class="tpl-swatch-name">${esc(role)}</span>
                </div>`).join('')}
            </div>
            <div class="tpl-kv">
              ${Object.entries((d.typography || {}).fonts || {}).map(([k, f]) => `
                <div><span class="muted">${esc(k)}</span> ${esc([f.latin, f.ea].filter(Boolean).join(' / ') || '—')}</div>`).join('')}
              <div><span class="muted">画布</span> ${canvas.width} × ${canvas.height} in</div>
            </div>
          </div>
          <div class="tpl-sec">
            <div class="tpl-sec-title">页面家族</div>
            <div class="tpl-families">
              ${Object.entries(d.families || {}).map(([fam, f]) => `
                <div class="tpl-family">
                  <span class="tpl-family-name">${esc(FAMILY_LABELS[fam] || fam)}</span>
                  <span class="tpl-family-variants">${Object.keys((f || {}).variants || {}).map((v) => `<span class="tpl-variant">${esc(v)}</span>`).join('')}</span>
                </div>`).join('')}
            </div>
          </div>
          <div class="tpl-sec">
            <div class="tpl-sec-title">风险提示</div>
            <div class="tpl-risks">
              ${Object.entries((d.meta || {}).confidence || {}).map(([k, v]) => `
                <div class="tpl-risk${v < 0.7 ? ' low' : ''}">
                  <span>${esc(CONFIDENCE_LABELS[k] || k)}</span>
                  <span>${Math.round(v * 100)}%${v < 0.7 ? ' · 置信度较低' : ''}</span>
                </div>`).join('') || '<div class="muted">无置信度数据</div>'}
              ${(() => {
                const n = d._extractNotes || {};
                const flags = [
                  ['footerDetected', '页脚'], ['titleSlotDetected', '标题槽位'], ['overlayDetected', '渐变蒙版'],
                ];
                return `<div class="tpl-notes">${flags.map(([k, label]) =>
                  `<span class="tpl-note ${n[k] ? 'on' : ''}">${n[k] ? '✓' : '✕'} ${label}</span>`).join('')}</div>`;
              })()}
            </div>
          </div>
          <div class="tpl-sec tpl-save-row">
            <input data-role="name" class="tpl-name-input" value="${esc((d.meta || {}).name || '上传模板')}" placeholder="模板名称" spellcheck="false" />
            <button class="btn btn-primary" data-role="save">保存模板</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-role="close"]').addEventListener('click', close);

  // ① 左侧样例页：extract 返回的 sampleScenes 中 image.src 指向服务器 staging
  // 临时目录，前端不可达——不传 templateId，dom-painter 自动以占位色块代替图片
  const samplesEl = overlay.querySelector('[data-role="samples"]');
  const SAMPLE_LABELS = ['封面', '章节页', '内容页'];
  (sampleScenes || []).forEach((scene, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'tpl-sample';
    wrap.appendChild(DomPainter.paintInto(scene, null, canvas));
    const label = document.createElement('div');
    label.className = 'tpl-sample-label muted';
    label.textContent = SAMPLE_LABELS[i] || `样例 ${i + 1}`;
    wrap.appendChild(label);
    samplesEl.appendChild(wrap);
  });

  overlay.querySelector('[data-role="save"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const name = overlay.querySelector('[data-role="name"]').value.trim();
    if (!name) {
      toast('请填写模板名称', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const resp = await api('/api/templates', { stagingId, name });
      const data = await resp.json();
      close();
      state.templates = data.templates || state.templates;
      state.templateId = null; // 强制 selectTemplate 生效
      renderHomeTemplates();
      renderOutlineTplPicker();
      await selectTemplate(data.id);
      toast(`模板「${name}」已保存`, 'ok');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '保存模板';
      toast(`保存失败：${err.message}`, 'error');
    }
  });
}

// ---------- 事件 ----------
function submitInput() {
  const text = inputEl.value.trim();
  if (!text || state.busy) return;
  inputEl.value = '';
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  addMessage(text, 'user');
  if (state.phase === 'slides') {
    doRevise(text);
  } else {
    doOutline(text, Number($('pages').value) || 8);
  }
}

$('input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitInput();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitInput();
  }
});

// ---------- 首页创作中枢事件 ----------
async function submitHome() {
  const hi = $('home-input');
  const text = hi.value.trim();
  if (!text || state.busy) return;
  const pages = Number($('home-pages').value) || 8;
  hi.value = '';
  state.topic = text;
  state.pages = pages;
  await ensureSession();
  addMessage(text, 'user');
  $('work-title').textContent = text;
  $('empty-tip').style.display = '';
  state.phase = 'outline';   // 立即切到工作视图，展示生成中
  showView();
  doOutline(text, pages);
}

$('home-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitHome();
});
$('home-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitHome();
  }
});
$('home-upload-btn').addEventListener('click', () => $('tpl-upload-input').click());
$('home-tpl-chip').addEventListener('click', () => {
  $('home-grid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('new-session-btn').addEventListener('click', newSession);

// ---------- 会话持久化 ----------
let saveTimer = null;

function sessionPayload() {
  return {
    phase: state.phase,
    topic: state.topic,
    pages: state.pages,
    templateId: state.templateId,
    title: state.outline ? `《${state.outline.title}》` : (state.topic || '新会话'),
    outline: state.outline,
    slides: state.slides,
    canvas: state.canvas,
    messages: state.messages,
  };
}

function scheduleSave() {
  if (!state.sessionId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1000);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.sessionId) return;
  try {
    await api(`/api/sessions/${state.sessionId}`, sessionPayload(), 'PUT');
    loadSessions();
  } catch { /* 本地工具，保存失败静默重试于下次触发 */ }
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const resp = await api('/api/sessions', {
    topic: state.topic, templateId: state.templateId, pages: state.pages,
  });
  const { id } = await resp.json();
  state.sessionId = id;
  loadSessions();
  return id;
}

async function loadSessions() {
  try {
    const resp = await api('/api/sessions', undefined, 'GET');
    state.sessions = (await resp.json()).sessions || [];
  } catch {
    state.sessions = [];
  }
  renderSessionList();
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function renderSessionList() {
  const list = $('session-list');
  if (!list) return;
  list.innerHTML = '';
  const empty = $('session-empty');
  if (empty) empty.style.display = state.sessions.length ? 'none' : '';
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
    item.innerHTML = `
      <span class="session-item-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
      <span class="session-item-main">
        <span class="session-item-title">${esc(s.title || '新会话')}</span>
        <span class="session-item-sub">${s.pageCount ? s.pageCount + ' 页 · ' : ''}${relTime(s.updatedAt)}</span>
      </span>
      <button class="session-del" title="删除会话"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
    item.addEventListener('click', () => loadSession(s.id));
    item.querySelector('.session-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });
    list.appendChild(item);
  }
}

function newSession() {
  if (state.busy) return;
  flushSave();
  Object.assign(state, {
    outline: null, slides: [], phase: 'idle', topic: '', pages: 8,
    canvas: null, messages: [], sessionId: null,
  });
  messagesEl.innerHTML = '';
  slidesEl.innerHTML = '';
  $('outline-box').classList.add('hidden', 'collapsed');
  $('empty-tip').style.display = '';
  $('export-btn').disabled = true;
  $('progress-bar').classList.add('hidden');
  $('work-title').textContent = '';
  $('home-input').value = '';
  renderTemplateChip();
  renderSessionList();
  showView();
  $('home-input').focus();
}

async function loadSession(id) {
  if (state.busy || id === state.sessionId) return;
  await flushSave();
  try {
    const resp = await api(`/api/sessions/${id}`, undefined, 'GET');
    const s = await resp.json();
    Object.assign(state, {
      sessionId: id,
      phase: s.phase || 'idle',
      topic: s.topic || '',
      pages: s.pages || 8,
      templateId: s.templateId || state.templateId,
      outline: s.outline || null,
      slides: Array.isArray(s.slides) ? s.slides : [],
      canvas: s.canvas || null,
      messages: Array.isArray(s.messages) ? s.messages : [],
    });
    if (s.templateId) localStorage.setItem('king-ppt.template', s.templateId);
    messagesEl.innerHTML = '';
    renderMessages();
    slidesEl.innerHTML = '';
    state.slides.forEach((sl) => sl && renderSlide(sl));
    if (state.outline) renderOutline(state.outline);
    else $('outline-box').classList.add('hidden');
    const hasSlides = state.slides.filter(Boolean).length > 0;
    if (state.phase === 'slides') {
      $('outline-box').classList.add('collapsed');
      $('export-btn').disabled = !hasSlides;
      $('empty-tip').style.display = 'none';
    } else {
      $('export-btn').disabled = true;
      $('empty-tip').style.display = hasSlides ? 'none' : '';
    }
    $('work-title').textContent = state.outline ? `《${state.outline.title}》` : state.topic;
    renderTemplateChip();
    renderSessionList();
    showView();
  } catch (err) {
    toast(`会话加载失败：${err.message}`, 'error');
  }
}

async function deleteSession(id) {
  try {
    await api(`/api/sessions/${id}`, undefined, 'DELETE');
  } catch { /* 忽略 */ }
  if (id === state.sessionId) {
    newSession();
  } else {
    loadSessions();
  }
}

window.addEventListener('beforeunload', () => {
  if (!state.sessionId || !saveTimer) return;
  try {
    fetch(`/api/sessions/${state.sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionPayload()),
      keepalive: true, // 允许请求在页面卸载后继续
    });
  } catch { /* 尽力而为 */ }
});

$('gen-slides-btn').addEventListener('click', doSlides);
$('regen-outline-btn').addEventListener('click', () => {
  if (state.topic && !state.busy) doOutline(state.topic, Number($('pages').value) || 8);
});
$('outline-header').addEventListener('click', () => {
  $('outline-box').classList.toggle('collapsed');
});

$('export-btn').addEventListener('click', async () => {
  try {
    const resp = await api('/api/export', { slides: state.slides, title: state.outline?.title, templateId: state.templateId });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.outline?.title || 'slides'}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已开始下载 PPTX', 'ok');
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
});

// ================= 模型设置 =================
const settingsDialog = $('settings-dialog');
$('settings-btn').addEventListener('click', openSettings);
$('model-chip').addEventListener('click', openSettings);
$('home-model-chip').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => settingsDialog.close());

const SETTINGS_NAV = [
  { key: 'services', label: '模型服务', icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>' },
  { key: 'defaults', label: '默认模型', icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>' },
];

const EYE_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const CHAT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const IMG_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
const CAP_META = { chat: '文本', vision: '视觉', image: '生图' };
const X_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

// 与后端 maskKey 一致：前 4 位 + **** + 后 4 位，过短全掩
function maskKeyText(s) {
  s = String(s || '');
  return s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****';
}

// URL 修正提示条：实际跑通的地址与填写不一致时（如忘加 /v1），给出「一键更新」
function showUrlSuggest(barEl, instId, suggested) {
  if (!barEl || !suggested) return;
  barEl.innerHTML = `
    <span class="url-suggest-msg">实际可用地址为 <code>${esc(suggested)}</code>（已自动补全路径）</span>
    <button class="btn btn-sm btn-primary" data-role="apply">一键更新</button>
    <button class="url-suggest-close" title="忽略">${X_ICON}</button>`;
  barEl.classList.remove('hidden');
  barEl.querySelector('[data-role="apply"]').addEventListener('click', async () => {
    try {
      await api(`/api/instances/${instId}`, { baseURL: suggested }, 'PUT');
      await reloadProviders();
      renderServicesView();
      refreshModelChip();
      toast('服务地址已更新', 'ok');
    } catch (err) {
      toast(`更新失败：${err.message}`, 'error');
    }
  });
  barEl.querySelector('.url-suggest-close').addEventListener('click', () => barEl.classList.add('hidden'));
}

// ---------- 应用内对话框（替代原生 prompt/confirm；挂进设置弹窗内部，保持在 top layer） ----------
// opts: { title, body, okText, cancelText, danger, input:{placeholder,value} }
// 返回 Promise：输入框模式 resolve(文本) / 取消 resolve(null)；确认模式 resolve(true/false)
function appDialog({ title, body, okText = '确定', cancelText = '取消', danger = false, input = null }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.innerHTML = `
      <div class="picker app-dialog">
        <div class="picker-head"><span>${esc(title)}</span></div>
        <div class="app-dialog-body">
          ${body ? `<div class="app-dialog-msg">${body}</div>` : ''}
          ${input ? `<input class="app-dialog-input" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" spellcheck="false" />` : ''}
        </div>
        <div class="picker-foot">
          <span class="spacer"></span>
          <button class="btn btn-sm" data-role="cancel">${esc(cancelText)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-role="ok">${esc(okText)}</button>
        </div>
      </div>`;
    settingsDialog.appendChild(overlay);
    const inputEl = overlay.querySelector('.app-dialog-input');
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(val);
    };
    const submit = () => {
      if (!input) return done(true);
      const v = inputEl.value.trim();
      if (!v) { // 空名称：红闪提示，不关闭
        inputEl.classList.remove('flash');
        void inputEl.offsetWidth;
        inputEl.classList.add('flash');
        inputEl.focus();
        return;
      }
      done(v);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(input ? null : false); });
    overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => done(input ? null : false));
    overlay.querySelector('[data-role="ok"]').addEventListener('click', submit);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(input ? null : false);
      if (e.key === 'Enter' && input) submit();
    });
    if (inputEl) { inputEl.focus(); inputEl.select(); }
    else overlay.querySelector('[data-role="ok"]').focus();
  });
}

// 供应商头像（品牌色 + 缩写）
function avatar(tpl, name) {
  const color = tpl?.color || '#64748b';
  const short = tpl?.short || (name || '?').slice(0, 1);
  return `<span class="avatar" style="background:${color}">${esc(short)}</span>`;
}

function tplOf(inst) {
  return state.providersData.templates.find((t) => t.id === inst.preset) || null;
}

function statusOf(inst) {
  if (!inst.enabled) return { cls: 'off', text: '已停用' };
  if (inst.hasKey || inst.noKey) return { cls: 'ok', text: '可用' };
  return { cls: 'warn', text: '缺少 Key' };
}

async function openSettings() {
  settingsDialog.showModal();
  $('settings-body').innerHTML = '<div class="muted" style="padding:24px 0;text-align:center">加载中…</div>';
  try {
    await reloadProviders();
    renderSettings();
  } catch (err) {
    $('settings-body').innerHTML = `<div class="muted" style="padding:24px 0;text-align:center">加载失败：${esc(err.message)}</div>`;
  }
}

async function reloadProviders() {
  const resp = await fetch('/api/providers');
  state.providersData = await resp.json();
}

function renderSettings() {
  const data = state.providersData;
  if (!data) return;
  const view = state.settingsView || 'services';

  const nav = $('settings-nav-items');
  nav.innerHTML = '';
  for (const item of SETTINGS_NAV) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-item${item.key === view ? ' active' : ''}`;
    const configured = item.key === 'defaults' ? Boolean(data.active.chat) : data.instances.length > 0;
    btn.innerHTML = `${item.icon}<span>${item.label}</span><span class="nav-state${configured ? ' configured' : ''}"></span>`;
    btn.addEventListener('click', () => { state.settingsView = item.key; renderSettings(); });
    nav.appendChild(btn);
  }

  $('settings-title').textContent = SETTINGS_NAV.find((n) => n.key === view)?.label || '模型设置';
  if (view === 'services') renderServicesView();
  else renderDefaultsView();
}

async function createInstance(tplId) {
  try {
    let name;
    if (tplId === 'custom') {
      name = await appDialog({
        title: '添加自定义供应商',
        body: '适用于中转站、公司内部网关等 OpenAI 兼容接口的服务',
        okText: '创建',
        input: { placeholder: '供应商名称，如：中转站A、公司内部网关' },
      });
      if (name === null) return;
    }
    const resp = await api('/api/instances', { preset: tplId, name });
    const { id } = await resp.json();
    state.selectedInstanceId = id; // 新建后展开抽屉，引导填 Key
    await reloadProviders();
    renderSettings();
    toast(tplId === 'custom' ? '已创建，请填写服务地址与 API Key' : '供应商已添加，请填写 API Key', 'ok');
  } catch (err) {
    toast(`添加失败：${err.message}`, 'error');
  }
}

// ---------- 视图：模型服务（抽屉式：供应商卡片纵向排列，点击展开模型配置） ----------
function renderServicesView() {
  const { instances } = state.providersData;
  if (instances.length === 0) return renderServicesEmpty();

  // undefined=首次打开默认展开第一个；null=用户全部收起；指向已删实例时回退到第一个
  if (state.selectedInstanceId === undefined) {
    state.selectedInstanceId = instances[0].id;
  } else if (state.selectedInstanceId && !instances.some((i) => i.id === state.selectedInstanceId)) {
    state.selectedInstanceId = instances[0].id;
  }

  const body = $('settings-body');
  body.innerHTML = `
    <div class="svc-topbar">
      <span class="muted" style="font-size:12.5px">点击供应商卡片展开模型配置。状态：绿=可用，黄=缺 Key，灰=停用。</span>
      <button class="btn btn-primary btn-sm" data-role="add-toggle">＋ 添加供应商</button>
    </div>
    <div class="svc-add-menu hidden" data-role="add-menu"></div>
    <div class="acc-list">
      ${instances.map((i) => {
        const st = statusOf(i);
        const open = i.id === state.selectedInstanceId;
        return `
        <div class="acc-item${open ? ' open' : ''}">
          <div class="acc-head" data-inst="${i.id}" role="button" tabindex="0">
            ${avatar(tplOf(i), i.name)}
            <span class="acc-head-main">
              <span class="acc-name">${esc(i.name)}</span>
              <span class="acc-sub"><span class="acc-status ${st.cls}">● ${st.text}</span> · ${i.models.length} 个模型${i.models.some((m) => m.caps.includes('vision')) ? ' · 含多模态' : ''}</span>
            </span>
            ${open ? `<span class="acc-head-actions">
              <label class="switch-wrap" title="启用/停用该供应商"><input type="checkbox" data-role="h-enabled" ${i.enabled ? 'checked' : ''} /><span class="switch"></span></label>
              <button class="btn btn-sm btn-danger-ghost" data-role="h-delete">删除</button>
              <button class="btn btn-sm" data-role="h-test">测试连接</button>
            </span>` : ''}
            <span class="acc-chevron">${CHEVRON_ICON}</span>
          </div>
          ${open ? '<div class="acc-body" data-role="detail"></div>' : ''}
        </div>`;
      }).join('')}
    </div>`;

  wireAddMenu(body);
  body.querySelectorAll('[data-inst]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 手风琴：点已展开的收起，点其他的切换展开
      const id = btn.dataset.inst;
      state.selectedInstanceId = id === state.selectedInstanceId ? null : id;
      renderServicesView();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.target !== btn) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
    });
  });
  renderInstanceDetail();
}

// 空状态：插画 + 推荐供应商卡片
function renderServicesEmpty() {
  const { templates } = state.providersData;
  const recommended = templates.filter((t) => ['openai', 'siliconflow', 'deepseek', 'ollama'].includes(t.id));
  const body = $('settings-body');
  body.innerHTML = `
    <div class="svc-empty-hero">
      <div class="svc-empty-art">🗄️</div>
      <div class="svc-empty-title">还没有添加任何模型供应商</div>
      <div class="svc-empty-sub">添加官方服务或中转站，即可为幻灯片生成配置可用模型</div>
      <button class="btn btn-primary" data-role="add-toggle">＋ 添加供应商</button>
    </div>
    <div class="svc-add-menu hidden" data-role="add-menu"></div>
    <div class="svc-rec-title">推荐供应商</div>
    <div class="svc-rec-grid">
      ${recommended.map((t) => `
        <div class="svc-rec-card">
          ${avatar(t)}
          <div class="svc-rec-name">${esc(t.name)}</div>
          <div class="svc-rec-tagline">${esc(t.tagline)}</div>
          <span class="svc-rec-tag">${esc(t.tag)}</span>
          <button class="btn btn-sm svc-rec-add" data-tpl="${t.id}">＋ 添加</button>
        </div>`).join('')}
    </div>`;
  wireAddMenu(body);
  body.querySelectorAll('.svc-rec-add').forEach((btn) => {
    btn.addEventListener('click', () => createInstance(btn.dataset.tpl));
  });
}

// 通用下拉开合：点按钮切换，点外部或选择后自动关闭
function wireDropdown(toggle, menu) {
  const close = () => {
    menu.classList.add('hidden');
    document.removeEventListener('click', close);
  };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.classList.contains('hidden');
    close();
    if (willOpen) {
      menu.classList.remove('hidden');
      document.addEventListener('click', close);
    }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  return close;
}

// 添加供应商下拉菜单（空状态与非空共用）
function wireAddMenu(body) {
  const { templates } = state.providersData;
  const menu = body.querySelector('[data-role="add-menu"]');
  const toggle = body.querySelector('[data-role="add-toggle"]');
  menu.innerHTML = templates.map((t) => `
    <button class="svc-add-item" data-tpl="${t.id}">
      ${avatar(t)}
      <span class="svc-add-main">
        <span class="svc-add-name">${esc(t.name)}</span>
        <span class="svc-add-sub">${esc(t.tagline)}${t.id !== 'custom' && t.noKey ? ' · 无需 Key' : ''}</span>
      </span>
    </button>`).join('');
  const close = wireDropdown(toggle, menu);
  menu.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', () => { close(); createInstance(btn.dataset.tpl); });
  });
}

// ---------- 实例详情（抽屉内联编辑，失焦自动保存） ----------
function renderInstanceDetail() {
  const { instances } = state.providersData;
  const inst = instances.find((i) => i.id === state.selectedInstanceId);
  const detail = document.querySelector('[data-role="detail"]');
  if (!inst || !detail) return;
  // 官方预设渠道：名称与服务地址锁定，自定义供应商可改
  const locked = inst.preset !== 'custom';
  const lockAttr = locked ? 'disabled title="官方渠道，不可更改"' : '';

  detail.innerHTML = `
    <div class="test-error hidden" data-role="test-error"></div>
    <div class="url-suggest hidden" data-role="url-suggest"></div>
    <div class="field-row">
      <div class="field">
        <label>名称</label>
        <input data-role="name" value="${esc(inst.name)}" ${lockAttr} />
      </div>
      <div class="field">
        <label>服务地址（Base URL）</label>
        <input data-role="baseurl" value="${esc(inst.baseURL)}" placeholder="https://..." ${lockAttr} />
      </div>
      <div class="field">
        <label>API Key <span style="color:var(--ok)">${inst.hasKey ? '✓' : ''}</span>${inst.keyUrl ? ` <a class="key-link" href="${esc(inst.keyUrl)}" target="_blank" rel="noopener">获取 Key →</a>` : ''}</label>
        <div class="key-input-wrap">
          <input data-role="apikey" type="text" autocomplete="off" spellcheck="false" ${inst.noKey ? 'disabled' : ''}
            value="${inst.noKey ? '' : esc(inst.keyPreview || '')}"
            placeholder="${inst.noKey ? '本地服务，无需 Key' : 'sk-...'}" />
          <button class="key-save-btn hidden" data-role="save-key" title="保存新 Key">${CHECK_ICON}</button>
        </div>
      </div>
    </div>
    <div class="models-header">
      <span>模型列表（${inst.models.length} 个）</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-role="sync">拉取模型</button>
      <button class="btn btn-sm" data-role="test-models">测试模型</button>
    </div>
    <div class="models-add">
      <input data-role="new-model" placeholder="输入模型名，如 glm-4-flash，回车添加" />
      <button class="btn btn-sm" data-role="add-model">＋ 添加</button>
    </div>
    <div class="models-table">
      <div class="models-th"><span>模型名称 / 能力（点击开关）</span><span class="models-th-right">状态 · 启用 · 删除</span></div>
      ${inst.models.length === 0 ? '<div class="svc-empty">暂无模型，手动添加或从接口拉取</div>' : ''}
      ${inst.models.map((m) => {
        const ms = !m.enabled
          ? { cls: 'off', text: '● 停用', title: '' }
          : m.lastTest === 'ok'
            ? { cls: 'ok', text: '● 已验证', title: '该模型已通过真实收发测试' }
            : m.lastTest === 'fail'
              ? { cls: 'fail', text: '✕ 验证失败', title: m.lastError || '验证失败' }
              : { cls: 'off', text: '○ 未验证', title: '尚未实测，点右上角「测试模型」验证' };
        return `
        <div class="models-tr${m.enabled ? '' : ' disabled'}" data-model="${esc(m.id)}">
          <span class="model-name">
            <span class="model-id" title="${esc(m.id)}">${esc(m.id)}</span>
            <span class="model-attrs">
              ${['chat', 'vision', 'image'].map((c) => `
                <button class="cap-chip${m.caps.includes(c) ? ' on' : ''}" data-captoggle="${c}" title="点击开关「${CAP_META[c]}」能力">${CAP_META[c]}</button>`).join('')}
              ${m.caps.includes('vision') ? `<span class="model-vision">${EYE_ICON} 识图</span>` : ''}
            </span>
          </span>
          <span class="model-side">
            <span class="model-status ${ms.cls}"${ms.title ? ` title="${esc(ms.title)}"` : ''}>${ms.text}</span>
            <label class="switch-wrap"><input type="checkbox" data-role="model-enabled" ${m.enabled ? 'checked' : ''} /><span class="switch"></span></label>
            <button class="cap-toggle danger" data-remove title="删除模型">${TRASH_ICON}</button>
          </span>
        </div>`;
      }).join('')}
    </div>`;

  wireModelsTable(detail, inst);

  const q = (role) => detail.querySelector(`[data-role="${role}"]`);

  // 失焦自动保存（值有变化才提交；空串在服务端视为「不修改」）
  const persist = async (patch, silent) => {
    try {
      await api(`/api/instances/${inst.id}`, patch, 'PUT');
      await reloadProviders();
      renderServicesView();
      refreshModelChip();
      if (!silent) toast('已保存', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'error');
    }
  };

  q('name').addEventListener('blur', (e) => {
    const v = e.target.value.trim();
    if (v && v !== inst.name) persist({ name: v }, true);
  });
  q('baseurl').addEventListener('blur', (e) => {
    const v = e.target.value.trim();
    if (v !== inst.baseURL) persist({ baseURL: v }, true);
  });
  // API Key 控件：平时显示掩码（首尾特征可识别，中间保密）；
  // 聚焦进入编辑态，粘贴立即掩码回显；点 ✓ 才保存，失焦丢弃并恢复掩码
  const keyInput = q('apikey');
  const keySaveBtn = q('save-key');
  const savedMask = inst.keyPreview || '';
  const origPlaceholder = keyInput.placeholder;
  const resetKeyField = () => {
    keyInput.dataset.real = '';
    keyInput.value = savedMask;
    keyInput.placeholder = origPlaceholder;
    keySaveBtn.classList.add('hidden');
  };
  keyInput.addEventListener('focus', () => {
    if (!keyInput.dataset.real) {
      keyInput.value = '';
      keyInput.placeholder = '粘贴新 Key，点右侧 ✓ 保存';
    }
  });
  keyInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (!text) return;
    keyInput.dataset.real = text;
    keyInput.value = maskKeyText(text); // 粘贴后立即以掩码显示
    keySaveBtn.classList.remove('hidden');
  });
  keyInput.addEventListener('input', () => {
    keyInput.dataset.real = keyInput.value.trim();
    keySaveBtn.classList.toggle('hidden', !keyInput.dataset.real);
  });
  keyInput.addEventListener('blur', resetKeyField);
  // 缺 Key / Key 无效时：输入框红色高亮闪烁两下
  const flashKeyField = () => {
    keyInput.classList.remove('flash');
    void keyInput.offsetWidth; // 重启动画
    keyInput.classList.add('flash');
    keyInput.addEventListener('animationend', () => keyInput.classList.remove('flash'), { once: true });
    keyInput.focus();
  };
  // mousedown 阻止默认行为，避免点 ✓ 时先触发 blur 清空输入
  keySaveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  keySaveBtn.addEventListener('click', () => {
    // 直接保存，是否有效由用户点「测试连接」自行验证
    const v = (keyInput.dataset.real || '').trim();
    if (v) persist({ apiKey: v });
  });

  // 标题栏操作：启用开关 / 删除 / 测试连接（点击不能触发展开收起）
  const item = detail.closest('.acc-item');
  // 头栏 DOM 由 renderServicesView 生成，而本函数会随模型操作重复执行：
  // 先克隆替换操作区节点（cloneNode 不带监听器），再重新绑定，避免监听器叠加/闭包过期
  const actions = item.querySelector('.acc-head-actions');
  actions.replaceWith(actions.cloneNode(true));
  const h = (role) => item.querySelector(`[data-role="${role}"]`);
  item.querySelector('.acc-head-actions').addEventListener('click', (e) => e.stopPropagation());

  h('h-enabled').addEventListener('change', (e) => persist({ enabled: e.target.checked }, true));

  h('h-delete').addEventListener('click', async () => {
    const yes = await appDialog({
      title: '删除供应商',
      body: `确定删除「${esc(inst.name)}」吗？其模型与默认绑定会一并移除，此操作不可恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!yes) return;
    try {
      await api(`/api/instances/${inst.id}`, undefined, 'DELETE');
      state.selectedInstanceId = null;
      await reloadProviders();
      renderServicesView();
      refreshModelChip();
      toast('已删除', 'ok');
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
    }
  });

  // 测试连接：按钮变身表达状态；失败详情就地显示在抽屉顶部错误条
  const testBtn = h('h-test');
  const errBar = q('test-error');
  const showTestError = (msg) => {
    errBar.innerHTML = `<span class="test-error-msg">${esc(msg)}</span><button class="test-error-close" title="关闭">${X_ICON}</button>`;
    errBar.classList.remove('hidden');
    errBar.querySelector('.test-error-close').addEventListener('click', () => errBar.classList.add('hidden'));
  };
  // 在指定按钮上显示结果态，delay 后退回默认
  const morphBtn = (btn, cls, text, delay) => {
    if (!btn) return;
    clearTimeout(btn._revert);
    btn.disabled = true;
    btn.classList.remove('loading', 'test-ok', 'test-err');
    btn.classList.add(cls);
    btn.textContent = text;
    btn._revert = setTimeout(() => {
      btn.classList.remove(cls);
      btn.textContent = '测试连接';
      btn.disabled = false;
    }, delay);
  };

  testBtn.addEventListener('click', async () => {
    errBar.classList.add('hidden'); // 清掉上次的错误条
    const candidate = (keyInput.dataset.real || '').trim();
    // 没填 Key（也没有已保存的）→ 红闪 Key 输入框提示，不发请求
    if (!candidate && !inst.hasKey && !inst.noKey) {
      flashKeyField();
      return;
    }
    testBtn.disabled = true;
    testBtn.classList.add('loading');
    testBtn.textContent = '测试中…';
    try {
      // 名称/地址/启用态先保存；有待保存的新 Key 时作为候选参与测试，通了才落盘
      const baseURL = q('baseurl').value.trim();
      await api(`/api/instances/${inst.id}`, {
        name: q('name').value.trim(),
        baseURL,
        enabled: h('h-enabled').checked,
      }, 'PUT');
      const testResp = await api(`/api/instances/${inst.id}/test`, candidate ? { apiKey: candidate, baseURL } : { baseURL });
      const testData = await testResp.json();
      if (candidate) await api(`/api/instances/${inst.id}`, { apiKey: candidate }, 'PUT');
      await reloadProviders();
      renderServicesView();
      refreshModelChip();
      // 重渲染后在新的按钮上显示成功态
      morphBtn(document.querySelector('.acc-item.open [data-role="h-test"]'), 'test-ok', '✓ 已连接', 1600);
      // 跑通的是补全路径的候选地址 → 提示一键更新
      showUrlSuggest(document.querySelector('[data-role="detail"] [data-role="url-suggest"]'), inst.id, testData.suggestedBaseURL);
    } catch (err) {
      morphBtn(testBtn, 'test-err', '✕ 连接失败', 2000);
      showTestError(err.message);
      flashKeyField();
    }
  });
}

// 查看模式模型表格
function wireModelsTable(detail, inst) {
  const q = (role) => detail.querySelector(`[data-role="${role}"]`);

  q('sync').addEventListener('click', () => openModelPicker(inst));

  // 测试模型：弹出多选框，勾选后逐个真实收发验证
  const testModelsBtn = q('test-models');
  testModelsBtn.addEventListener('click', () => {
    if (inst.models.length === 0) { toast('暂无模型可测试', 'error'); return; }
    openModelTestPicker(inst);
  });

  const doAdd = async () => {
    const input = q('new-model');
    const id = input.value.trim();
    if (!id) return;
    try {
      await api(`/api/instances/${inst.id}/models`, { id, caps: ['chat'] });
      await reloadProviders();
      renderInstanceDetail();
    } catch (err) {
      toast(`添加失败：${err.message}`, 'error');
    }
  };
  q('add-model').addEventListener('click', doAdd);
  q('new-model').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
  });

  detail.querySelectorAll('.models-tr[data-model]').forEach((row) => {
    const modelId = row.dataset.model;
    const model = inst.models.find((m) => m.id === modelId);

    row.querySelectorAll('[data-captoggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cap = btn.dataset.captoggle;
        const caps = model.caps.includes(cap)
          ? model.caps.filter((c) => c !== cap)
          : [...model.caps, cap];
        if (caps.length === 0) { toast('模型至少保留一种能力', 'error'); return; }
        try {
          await api(`/api/instances/${inst.id}/models`, { id: modelId, caps });
          await reloadProviders();
          renderInstanceDetail();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    row.querySelector('[data-role="model-enabled"]').addEventListener('change', async (e) => {
      try {
        await api(`/api/instances/${inst.id}/models`, { id: modelId, enabled: e.target.checked });
        await reloadProviders();
        renderInstanceDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    row.querySelector('[data-remove]').addEventListener('click', async () => {
      try {
        await api(`/api/instances/${inst.id}/models`, { model: modelId }, 'DELETE');
        await reloadProviders();
        renderInstanceDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// ---------- 从接口拉取：多选弹窗（只有选中的才会加入模型列表） ----------
async function openModelPicker(inst) {
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head">
        <span>从「${esc(inst.name)}」拉取模型</span>
        <span class="picker-count muted"></span>
      </div>
      <input class="picker-search" placeholder="搜索模型名…" />
      <div class="picker-list"><div class="svc-empty">正在拉取模型列表…</div></div>
      <div class="picker-foot">
        <button class="btn btn-sm" data-role="all">全选</button>
        <button class="btn btn-sm" data-role="none">清空</button>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-role="cancel">取消</button>
        <button class="btn btn-sm btn-primary" data-role="ok" disabled>添加所选</button>
      </div>
    </div>`;
  settingsDialog.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const listEl = overlay.querySelector('.picker-list');
  const searchEl = overlay.querySelector('.picker-search');
  const countEl = overlay.querySelector('.picker-count');
  const okBtn = overlay.querySelector('[data-role="ok"]');
  const selected = new Set();
  let allIds = [];
  let existing = new Set();

  function refreshFoot() {
    countEl.textContent = selected.size ? `已选 ${selected.size} 个` : '';
    okBtn.disabled = selected.size === 0;
  }

  function renderList() {
    const kw = searchEl.value.trim().toLowerCase();
    const shown = allIds.filter((id) => !kw || id.toLowerCase().includes(kw));
    if (shown.length === 0) {
      listEl.innerHTML = '<div class="svc-empty">没有匹配的模型</div>';
      return;
    }
    listEl.innerHTML = shown.map((id) => {
      const added = existing.has(id);
      return `
        <label class="picker-row${added ? ' added' : ''}">
          <input type="checkbox" data-id="${esc(id)}" ${selected.has(id) ? 'checked' : ''} ${added ? 'disabled' : ''} />
          <span class="picker-row-id">${esc(id)}</span>
          ${added ? '<span class="picker-added">已添加</span>' : ''}
        </label>`;
    }).join('');
    listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.dataset.id);
        else selected.delete(cb.dataset.id);
        refreshFoot();
      });
    });
  }

  overlay.querySelector('[data-role="all"]').addEventListener('click', () => {
    const kw = searchEl.value.trim().toLowerCase();
    allIds.filter((id) => !existing.has(id) && (!kw || id.toLowerCase().includes(kw)))
      .forEach((id) => selected.add(id));
    renderList();
    refreshFoot();
  });
  overlay.querySelector('[data-role="none"]').addEventListener('click', () => {
    selected.clear();
    renderList();
    refreshFoot();
  });
  overlay.querySelector('[data-role="cancel"]').addEventListener('click', close);
  searchEl.addEventListener('input', renderList);

  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    okBtn.textContent = '添加中…';
    try {
      for (const id of selected) {
        await api(`/api/instances/${inst.id}/models`, { id, caps: ['chat'] });
      }
      await reloadProviders();
      close();
      renderServicesView();
      toast(`已添加 ${selected.size} 个模型（默认标记为文本能力，可在列表中开关多模态/生图）`, 'ok', 4500);
    } catch (err) {
      toast(`添加失败：${err.message}`, 'error');
      okBtn.disabled = false;
      okBtn.textContent = '添加所选';
    }
  });

  try {
    const resp = await api(`/api/instances/${inst.id}/remote-models`);
    const data = await resp.json();
    allIds = data.ids;
    existing = new Set(data.existing);
    // 拉取时若跑通的是补全路径的候选地址 → 抽屉里提示一键更新
    showUrlSuggest(document.querySelector('[data-role="detail"] [data-role="url-suggest"]'), inst.id, data.suggestedBaseURL);
    if (allIds.length === 0) {
      listEl.innerHTML = '<div class="svc-empty">接口未返回任何模型</div>';
      return;
    }
    renderList();
    if (allIds.every((id) => existing.has(id))) {
      countEl.textContent = '远端模型已全部在列表中';
    }
  } catch (err) {
    listEl.innerHTML = `<div class="svc-empty">拉取失败：${esc(err.message)}</div>`;
  }
}

// ---------- 测试模型：多选弹窗（勾选要实测的模型，逐个真实收发，结果就地显示） ----------
function openModelTestPicker(inst) {
  const testable = (m) => m.enabled !== false && (m.caps.includes('chat') || m.caps.includes('vision'));
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head">
        <span>测试「${esc(inst.name)}」的模型</span>
        <span class="picker-count muted"></span>
      </div>
      <div class="picker-list">
        ${inst.models.map((m) => {
          const ok = testable(m);
          const hint = ok ? '' : (m.enabled === false ? '已停用' : '生图模型不参与实测');
          return `
          <label class="picker-row${ok ? '' : ' added'}">
            <input type="checkbox" data-id="${esc(m.id)}" ${ok ? 'checked' : 'disabled'} />
            <span class="picker-row-id">${esc(m.id)}</span>
            ${hint ? `<span class="picker-added">${hint}</span>` : ''}
            <span class="picker-test-status" data-status="${esc(m.id)}"></span>
          </label>`;
        }).join('')}
      </div>
      <div class="picker-foot">
        <button class="btn btn-sm" data-role="all">全选</button>
        <button class="btn btn-sm" data-role="none">清空</button>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-role="cancel">取消</button>
        <button class="btn btn-sm btn-primary" data-role="ok">开始测试</button>
      </div>
    </div>`;
  settingsDialog.appendChild(overlay);
  let running = false;
  const close = () => { if (!running) overlay.remove(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const countEl = overlay.querySelector('.picker-count');
  const okBtn = overlay.querySelector('[data-role="ok"]');
  const cancelBtn = overlay.querySelector('[data-role="cancel"]');
  const allBtn = overlay.querySelector('[data-role="all"]');
  const noneBtn = overlay.querySelector('[data-role="none"]');
  const boxes = [...overlay.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
  const selected = new Set(boxes.map((cb) => cb.dataset.id));

  const refreshFoot = () => {
    countEl.textContent = selected.size ? `已选 ${selected.size} 个` : '';
    okBtn.disabled = selected.size === 0;
  };
  boxes.forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) selected.add(cb.dataset.id);
    else selected.delete(cb.dataset.id);
    refreshFoot();
  }));
  allBtn.addEventListener('click', () => {
    boxes.forEach((cb) => { cb.checked = true; selected.add(cb.dataset.id); });
    refreshFoot();
  });
  noneBtn.addEventListener('click', () => {
    boxes.forEach((cb) => { cb.checked = false; });
    selected.clear();
    refreshFoot();
  });
  cancelBtn.addEventListener('click', close);
  refreshFoot();

  okBtn.addEventListener('click', async () => {
    running = true;
    okBtn.disabled = true;
    allBtn.disabled = noneBtn.disabled = true;
    boxes.forEach((cb) => (cb.disabled = true));
    const results = [];
    let i = 0;
    for (const id of selected) {
      i++;
      countEl.textContent = `正在测试 ${i}/${selected.size}…`;
      const st = overlay.querySelector(`[data-status="${CSS.escape(id)}"]`);
      st.className = 'picker-test-status ptest-run';
      st.textContent = '⟳ 测试中…';
      try {
        const resp = await api(`/api/instances/${inst.id}/test-model`, { model: id });
        const r = await resp.json();
        results.push(r);
        st.className = `picker-test-status ${r.ok ? 'ptest-ok' : 'ptest-fail'}`;
        st.textContent = r.ok ? '✓ 通过' : '✕ 失败';
        if (!r.ok) st.title = r.error || '验证失败';
      } catch (err) {
        results.push({ ok: false, model: id, error: err.message });
        st.className = 'picker-test-status ptest-fail';
        st.textContent = '✕ 失败';
        st.title = err.message;
      }
    }
    running = false;
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    countEl.textContent = `${okCount} 通过 / ${failCount} 失败`;
    // 恢复多选与按钮，用户可重新勾选后再测一轮
    boxes.forEach((cb) => (cb.disabled = false));
    allBtn.disabled = noneBtn.disabled = false;
    okBtn.disabled = selected.size === 0;
    cancelBtn.textContent = '完成';
    await reloadProviders();
    renderInstanceDetail();
    const suggested = results.find((r) => r.suggestedBaseURL)?.suggestedBaseURL;
    showUrlSuggest(document.querySelector('[data-role="detail"] [data-role="url-suggest"]'), inst.id, suggested);
  });
}

// ---------- 视图：默认模型 ----------
function renderDefaultsView() {
  const { instances, active } = state.providersData;
  const body = $('settings-body');
  const groups = [
    { cap: 'chat', label: '文本与多模态', badge: '推荐', desc: '生成大纲、幻灯片与修改指令；具备识图能力的模型可同时理解图片', filter: (m) => m.caps.includes('chat') },
    { cap: 'image', label: '图像生成', badge: null, desc: '为幻灯片生成配图', filter: (m) => m.caps.includes('image') },
  ];

  body.innerHTML = groups.map(({ cap, label, badge, desc, filter }) => {
    const options = [];
    for (const inst of instances.filter((i) => i.enabled)) {
      for (const m of inst.models.filter((x) => x.enabled && filter(x))) {
        options.push({ instance: inst.id, instanceName: inst.name, model: m.id, vision: m.caps.includes('vision'), lastTest: m.lastTest || null });
      }
    }
    const current = active[cap];
    const currentOpt = options.find((o) => o.instance === current?.instance && o.model === current?.model);

    return `
      <div class="def-card" data-cap="${cap}">
        <div class="def-card-head">
          <span class="def-card-icon">${cap === 'chat' ? CHAT_ICON : IMG_ICON}</span>
          <span class="def-card-title">${label}</span>
          ${badge ? `<span class="def-card-badge">${badge}</span>` : ''}
          <div class="def-card-desc">${desc}</div>
        </div>
        ${options.length === 0 ? `
          <div class="def-empty">
            <div class="def-empty-icon">📦</div>
            <div class="def-empty-title">暂无可用模型</div>
            <div class="def-empty-sub">请先添加模型服务供应商</div>
            <button class="btn btn-primary btn-sm" data-goto-services>＋ 去添加供应商</button>
          </div>` : `
          <div class="def-select" data-cap="${cap}">
            <button class="def-select-btn" data-role="def-toggle">
              ${currentOpt ? `
                <span class="def-check">${CHECK_ICON}</span>
                <span class="def-current">
                  <span class="def-current-name">${esc(currentOpt.instanceName)} · ${esc(currentOpt.model)}</span>
                  <span class="def-current-sub">${currentOpt.vision ? `${EYE_ICON} 支持视觉（识图）` : '当前默认 · 状态正常'}</span>
                </span>` : `
                <span class="def-placeholder">请选择模型</span>`}
              <span class="def-chevron">${CHEVRON_ICON}</span>
            </button>
            <div class="def-menu hidden" data-role="def-menu">
              ${options.map((o) => `
                <button class="def-option${currentOpt && o.instance === currentOpt.instance && o.model === currentOpt.model ? ' active' : ''}"
                  data-instance="${o.instance}" data-model="${esc(o.model)}" data-lasttest="${o.lastTest || ''}">
                  <span class="def-option-name">${esc(o.instanceName)} · ${esc(o.model)}</span>
                  ${o.lastTest === 'ok' ? '<span class="def-verified" title="已通过真实收发测试">●</span>' : ''}
                  ${o.vision ? `<span class="vision-badge" title="支持多模态（识图）">${EYE_ICON}</span>` : ''}
                </button>`).join('')}
            </div>
          </div>`}
      </div>`;
  }).join('');

  body.querySelectorAll('[data-goto-services]').forEach((btn) => {
    btn.addEventListener('click', () => { state.settingsView = 'services'; renderSettings(); });
  });

  body.querySelectorAll('.def-select').forEach((wrap) => {
    const cap = wrap.dataset.cap;
    const toggle = wrap.querySelector('[data-role="def-toggle"]');
    const menu = wrap.querySelector('[data-role="def-menu"]');
    const close = wireDropdown(toggle, menu);
    menu.querySelectorAll('.def-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        close();
        const instId = btn.dataset.instance;
        const modelId = btn.dataset.model;
        try {
          // 生图调用即扣费不实测；已验证过的模型直接绑定，其余先实测再绑定
          if (cap !== 'image' && btn.dataset.lasttest !== 'ok') {
            toggle.disabled = true;
            toggle.innerHTML = `<span class="def-placeholder">正在验证模型…</span><span class="def-chevron">${CHEVRON_ICON}</span>`;
            const resp = await api(`/api/instances/${instId}/test-model`, { model: modelId });
            const res = await resp.json();
            if (!res.ok) {
              await reloadProviders(); // 失败标记已落库，回写状态
              renderDefaultsView();
              toast(`模型验证失败：${res.error}`, 'error', 5000);
              return;
            }
            if (res.suggestedBaseURL) {
              toast(`验证通过。实际可用地址为 ${res.suggestedBaseURL}，可到「模型服务」一键更新`, 'ok', 6000);
            }
          }
          await api('/api/active', { capability: cap, instance: instId, model: modelId });
          await reloadProviders();
          refreshModelChip();
          renderDefaultsView();
          // 成功动效：卡片绿色脉冲扩散 + ✓ 弹出
          const card = document.querySelector(`.def-card[data-cap="${cap}"]`);
          if (card) card.classList.add('def-success');
          toast('默认模型已更新', 'ok');
        } catch (err) {
          toast(`保存失败：${err.message}`, 'error');
          renderDefaultsView();
        }
      });
    });
  });
}

async function refreshModelChip() {
  try {
    const resp = await fetch('/api/providers');
    const data = await resp.json();
    const a = data.active.chat;
    document.querySelectorAll('.model-chip').forEach((chip) => {
      const dot = chip.querySelector('.chip-dot');
      const info = chip.querySelector('.model-info');
      if (dot) dot.className = `chip-dot${a ? ' ok' : ''}`;
      if (info) info.textContent = a ? `${a.instanceName} · ${a.model}` : '未配置模型';
    });
  } catch {
    document.querySelectorAll('.model-chip .model-info').forEach((el) => { el.textContent = '配置加载失败'; });
  }
}
refreshModelChip();
loadTemplates();
loadSessions();
showView();

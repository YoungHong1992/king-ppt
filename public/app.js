// ---------- 状态 ----------
const state = {
  outline: null,
  slides: [],        // 已生成的页（含 index）
  phase: 'idle',     // idle | outline | slides
  topic: '',
  title: '',         // 演示文稿标题（Agent 推 deck 时带来）
  pages: 8,
  busy: false,
  templateId: localStorage.getItem('king-ppt.template') || 'classic-blue',
  templates: [],     // /api/templates 列表缓存
  canvas: null,      // 当前模板画布（SSE deck / slide 事件更新）
  sessionId: null,   // 当前会话（后端持久化）
  sessions: [],      // /api/sessions 列表缓存
  messages: [],      // 结构化对话记录（持久化 & 恢复用）
  category: '全部',  // 首页模板分类
  deckVersion: 0,    // 中继 deck 版本（丢弃过期 SSE 回放）
};

// 常用图标（toast 等公共组件依赖，置顶以先于使用定义）
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

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
function toastHost() {
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

// 左侧面板：模板选择器（全程可用，供人类挑方案）+ 由当前幻灯片派生的页面导航。
// 新模型下大纲由 Agent 侧掌握，此面板只呈现「已生成的页」并支持点击定位。
function renderDeckPanel() {
  const box = $('outline-box');
  const slides = state.slides.filter(Boolean);
  // 有幻灯片，或已进入工作视图时展示；纯 idle 隐藏
  if (slides.length === 0 && state.phase === 'idle') {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('outline-tpl').classList.toggle('hidden', false); // 模板选择条全程可用
  updateOutlineHint();
  const list = $('outline-list');
  list.innerHTML = '';
  if (state.topic || slides.length) {
    const titleDiv = document.createElement('div');
    titleDiv.className = 'outline-title';
    titleDiv.textContent = `《${(state.title || state.topic || '演示文稿')}》`;
    list.appendChild(titleDiv);
  }
  state.slides.forEach((s, i) => {
    if (!s) return;
    const item = document.createElement('div');
    const clickable = Boolean(state.slides[i]);
    item.className = `outline-item${clickable ? ' clickable' : ''}`;
    const label = s.title || s.quote || `第 ${i + 1} 页`;
    item.innerHTML = `<span class="no">${i + 1}</span><span>${esc(label)}</span>`;
    if (clickable) {
      item.title = '点击定位到该页';
      item.addEventListener('click', () => scrollToSlide(i));
    }
    list.appendChild(item);
  });
  renderOutlineTplPicker();
}

// ---------- 与用户 Agent 协作 ----------
function updateProgress(done, total) {
  const bar = $('progress-bar');
  bar.classList.remove('hidden');
  $('progress-fill').style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
}

// 控制反转：浏览器不再自己调 LLM，而是把人类请求入队给用户的 Agent。
// Agent 通过 GET /api/agent/next 长轮询取走 → 用自身推理生成 → POST /api/agent/deck|slide
// → 服务器 resolve+校验 → 经 /api/stream(SSE) 把成品推回浏览器渲染。
async function sendAction(action, payload = {}, note) {
  try {
    await api('/api/agent/action', { action, payload });
    if (note) addMessage(note, 'agent');
  } catch (err) {
    toast(`发送失败：${err.message}`, 'error');
    addMessage(`发送失败：${err.message}`, 'agent', true);
  }
}

// SSE：接收 Agent 推来的整册 / 单页，实时渲染预览
let evtSource = null;
function connectStream() {
  if (evtSource) return;
  evtSource = new EventSource('/api/stream');
  evtSource.addEventListener('deck', (e) => {
    const data = JSON.parse(e.data);
    if (data.version && data.version < state.deckVersion) return; // 丢弃过期回放
    state.deckVersion = data.version || state.deckVersion;
    if (data.canvas) state.canvas = data.canvas;
    if (typeof data.title === 'string') state.title = data.title;
    if (data.templateId && data.templateId !== state.templateId) {
      state.templateId = data.templateId;
      renderTemplateChip();
    }
    if (!Array.isArray(data.slides) || data.slides.length === 0) return;
    applyIncomingDeck(data.slides);
  });
  evtSource.addEventListener('slide', (e) => {
    const data = JSON.parse(e.data);
    if (data.version && data.version < state.deckVersion) return;
    state.deckVersion = data.version || state.deckVersion;
    if (data.canvas) state.canvas = data.canvas;
    applyIncomingSlide(data.index, data.slide);
  });
  evtSource.onerror = () => { /* 浏览器自动按 retry 重连，无需处理 */ };
}

// 整册回流：替换 state.slides 并整体重绘（Agent 生成/重写整册）
function applyIncomingDeck(slides) {
  state.slides = slides;
  state.phase = 'slides';
  showView();
  $('empty-tip').style.display = 'none';
  slidesEl.innerHTML = '';
  state.slides.forEach((s) => s && renderSlide(s));
  $('export-btn').disabled = state.slides.filter(Boolean).length === 0;
  if (state.title) $('work-title').textContent = `《${state.title}》`;
  updateProgress(state.slides.filter(Boolean).length, state.slides.length || 1);
  renderDeckPanel();
  scheduleSave();
}

// 单页回流：写入并重绘该页（Agent 逐页流式）；不打断人类正在编辑的那张卡片
function applyIncomingSlide(index, slide) {
  if (!(index >= 0) || !slide) return;
  const card = slidesEl.querySelector(`.slide-card[data-index="${index}"]`);
  if (card && card.contains(document.activeElement)) return; // 正在就地编辑，跳过回放
  state.slides[index] = slide;
  if (state.phase !== 'slides') { state.phase = 'slides'; showView(); }
  $('empty-tip').style.display = 'none';
  renderSlide(slide);
  $('export-btn').disabled = state.slides.filter(Boolean).length === 0;
  renderDeckPanel();
  scheduleSave();
}

// 发起生成：把主题/页数发给 Agent（取代旧的 /api/outline + /api/slides 两步 LLM 流程）
async function doOutline(topic, pages) {
  state.topic = topic;
  state.pages = pages;
  $('work-title').textContent = topic;
  await sendAction('generate', { topic, pages, templateId: state.templateId },
    `已把主题发给 Agent：《${topic}》（${pages} 页）。Agent 正在生成，幻灯片会逐页出现在右侧。`);
}

// 「确认大纲，生成幻灯片」：请求 Agent 重新生成整册（大纲步骤已并入 Agent 侧）
async function doSlides() {
  if (state.busy) return;
  await sendAction('generate', { topic: state.topic, pages: state.pages, templateId: state.templateId },
    '已请求 Agent 生成幻灯片。');
}

// 局部修改：把自然语言指令发给 Agent
async function doRevise(instruction) {
  await sendAction('revise', { instruction, templateId: state.templateId },
    `已把修改指令发给 Agent：${instruction}`);
}

// ---------- 预览渲染 ----------
// 就地编辑提交：把 DOM 上的文字写回 slide JSON（导出/会话保存都以它为准），并同步给 Agent
function applySlideEdit(slide, edit, value) {
  const { field, index, key } = edit;
  if (field === 'table') {
    slide.headers = value.headers;
    slide.rows = value.rows;
  } else if (index !== undefined && key !== undefined) {
    if (Array.isArray(slide[field]) && slide[field][index]) slide[field][index][key] = value;
  } else if (Array.isArray(value)) {
    slide[field] = value;
  } else {
    slide[field] = value;
  }
  scheduleSave();
  // 把就地编辑后的整页发回 Agent（去掉本地衍生字段，只传内容）；让 Agent 知道人类改了什么
  if (slide.index >= 0) {
    const { scene, warnings, ...content } = slide;
    sendAction('edit', { index: slide.index, slide: content, templateId: state.templateId });
  }
}

// 单页工具条：换版式（本地重排）/ 重新生成（重写该页内容）
async function switchVariant(i) {
  const s = state.slides[i];
  if (!s || s.type === 'free') return;
  try {
    s._variant = (typeof s._variant === 'number' ? s._variant + 1 : 1);
    const resp = await api('/api/reresolve', {
      slides: [s], templateId: state.templateId, title: state.title, total: state.slides.filter(Boolean).length,
    });
    const data = await resp.json();
    s.scene = data.scenes[0];
    s.warnings = data.warningsList[0] || [];
    if (data.canvas) state.canvas = data.canvas;
    renderSlide(s);
    scheduleSave();
  } catch (err) {
    toast(`换版式失败：${err.message}`, 'error');
  }
}

// 请求 Agent 重写该页内容（取代旧的 /api/slide/regen）
async function regenSlide(i) {
  const s = state.slides[i];
  if (!s || state.busy) return;
  const feedback = (s.warnings || []).filter((w) => w.level !== 'info').map((w) => `- ${w.message}`).join('\n');
  await sendAction('regen', { index: i, templateId: state.templateId, feedback: feedback || undefined },
    `已请求 Agent 重写第 ${i + 1} 页。`);
  toast(`已请求重写第 ${i + 1} 页`, 'ok');
}

function buildSlideToolbar(s) {
  const bar = document.createElement('div');
  bar.className = 'slide-toolbar';
  if (s.type !== 'free') {
    const btnVariant = document.createElement('button');
    btnVariant.type = 'button';
    btnVariant.className = 'slide-tool-btn';
    btnVariant.textContent = '换版式';
    btnVariant.title = '切换该页的版式（不重新生成内容）';
    btnVariant.addEventListener('click', () => switchVariant(s.index));
    bar.appendChild(btnVariant);
  }
  const btnRegen = document.createElement('button');
  btnRegen.type = 'button';
  btnRegen.className = 'slide-tool-btn slide-regen';
  btnRegen.textContent = '重新生成';
  btnRegen.title = '让 AI 重写这一页的内容';
  btnRegen.addEventListener('click', () => regenSlide(s.index));
  bar.appendChild(btnRegen);
  return bar;
}

function buildWarnBadge(warnings) {
  const badge = document.createElement('div');
  badge.className = 'slide-warn';
  const errs = warnings.filter((w) => w.level === 'error').length;
  badge.textContent = `⚠ ${warnings.length}`;
  badge.title = warnings.map((w) => `[${w.level === 'error' ? '错误' : '提示'}] ${w.message}`).join('\n');
  if (errs > 0) badge.classList.add('has-error');
  return badge;
}

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
  // free 自由排版页：svg（新）矢量预览 / html（旧会话）iframe，均不走场景图
  if (s.type === 'free' && (s.svg || s.html)) {
    card.innerHTML = num;
    const frame = s.svg ? SvgFrame.build(s.svg) : HtmlFrame.build(s.html);
    if (frame) card.appendChild(frame);
    if (state.phase === 'slides') card.appendChild(buildSlideToolbar(s));
    return;
  }
  // Scene Graph 驱动渲染（新数据）；无 scene 的旧数据走下方手写渲染兜底
  if (s.scene) {
    card.innerHTML = num;
    const slideEl = document.createElement('div');
    slideEl.className = 'slide';
    const editable = state.phase === 'slides';
    DomPainter.paint(s.scene, slideEl, {
      canvas: state.canvas || undefined,
      templateId: state.templateId,
      ...(editable ? { onEdit: (edit, value) => {
        applySlideEdit(s, edit, value);
        // bullets/table 条目增删后重画该页，保持视图与数据一致
        if (edit.field === 'table' || Array.isArray(value)) renderSlide(s);
      } } : {}),
    });
    card.appendChild(slideEl);
    if (Array.isArray(s.warnings) && s.warnings.length > 0) card.appendChild(buildWarnBadge(s.warnings));
    if (state.phase === 'slides') card.appendChild(buildSlideToolbar(s));
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
  // 已有幻灯片：用新模板整本重排（内容不变，只重算场景图）；
  // free 页 SVG/HTML 是按旧模板风格画的，保持原样
  const hasSlides = state.slides.filter(Boolean).length > 0;
  if (hasSlides) {
    try {
      const resp = await api('/api/reresolve', { slides: state.slides, templateId: id, title: state.title });
      const data = await resp.json();
      (data.scenes || []).forEach((scene, i) => {
        if (state.slides[i]) {
          state.slides[i].scene = scene;
          state.slides[i].warnings = (data.warningsList || [])[i] || [];
        }
      });
      state.canvas = data.canvas || state.canvas;
    } catch (err) {
      toast(`换模板重排失败：${err.message}`, 'error');
    }
  }
  state.slides.forEach((s) => s && renderSlide(s));
  scheduleSave();
  // 告知 Agent 人类换了模板（Agent 后续生成/重写会用新模板的 spec）
  sendAction('template-pick', { templateId: id });
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
    title: state.title || state.topic || '新会话',
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
    slides: [], phase: 'idle', topic: '', pages: 8, title: '',
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
      title: s.title || '',
      slides: Array.isArray(s.slides) ? s.slides : [],
      canvas: s.canvas || null,
      messages: Array.isArray(s.messages) ? s.messages : [],
    });
    if (s.templateId) localStorage.setItem('king-ppt.template', s.templateId);
    messagesEl.innerHTML = '';
    renderMessages();
    slidesEl.innerHTML = '';
    state.slides.forEach((sl) => sl && renderSlide(sl));
    const hasSlides = state.slides.filter(Boolean).length > 0;
    renderDeckPanel();
    if (hasSlides) {
      $('outline-box').classList.add('collapsed');
      $('export-btn').disabled = false;
      $('empty-tip').style.display = 'none';
    } else {
      $('export-btn').disabled = true;
      $('empty-tip').style.display = '';
    }
    $('work-title').textContent = state.title ? `《${state.title}》` : state.topic;
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
    const resp = await api('/api/export', { slides: state.slides, title: state.title, templateId: state.templateId });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.title || 'slides'}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已开始下载 PPTX', 'ok');
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
});

loadTemplates();
loadSessions();
connectStream(); // 订阅 Agent 推送的 deck/slide
showView();

// ---------- 状态 ----------
const state = {
  outline: null,
  slides: [],        // 已生成的页（含 index）
  phase: 'idle',     // idle | outline | slides
  topic: '',
};

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const slidesEl = $('slides');
const inputEl = $('input');

// ---------- API ----------
async function api(path, body) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${resp.status})`);
  }
  return resp;
}

// ---------- 消息 ----------
function addMessage(text, who = 'user') {
  const div = document.createElement('div');
  div.className = `msg msg-${who}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function setLoading(div, text) { div.textContent = text; div.classList.add('loading'); }
function clearLoading(div, text) { div.textContent = text; div.classList.remove('loading'); }

// ---------- 大纲 ----------
function renderOutline(outline) {
  $('outline-box').classList.remove('hidden');
  const list = $('outline-list');
  list.innerHTML = '';
  const titleDiv = document.createElement('div');
  titleDiv.className = 'outline-title';
  titleDiv.textContent = `《${outline.title}》`;
  list.appendChild(titleDiv);
  outline.pages.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'outline-item';
    item.textContent = `${i + 1}. ${p.heading} — ${p.intent}`;
    list.appendChild(item);
  });
}

async function doOutline(topic, pages) {
  state.topic = topic;
  const msg = addMessage('正在生成大纲…', 'agent');
  setLoading(msg, '正在生成大纲…');
  try {
    const resp = await api('/api/outline', { topic, pages });
    const outline = await resp.json();
    state.outline = outline;
    state.phase = 'outline';
    clearLoading(msg, `大纲已生成：《${outline.title}》，共 ${outline.pages.length} 页。确认后点击「生成幻灯片」。`);
    renderOutline(outline);
  } catch (err) {
    clearLoading(msg, `大纲生成失败：${err.message}`);
  }
}

// ---------- 幻灯片（SSE 逐页） ----------
async function doSlides() {
  if (!state.outline) return;
  state.slides = [];
  slidesEl.innerHTML = '';
  $('empty-tip').style.display = 'none';
  const msg = addMessage('正在逐页生成幻灯片…', 'agent');
  setLoading(msg, '正在逐页生成幻灯片…');

  const resp = await fetch('/api/slides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outline: state.outline }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    clearLoading(msg, `生成失败：${data.error || resp.status}`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = 0;
  const total = state.outline.pages.length;

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
      if (event === 'slide') {
        state.slides[data.index] = data;
        renderSlide(data);
        done++;
        setLoading(msg, `正在逐页生成幻灯片… (${done}/${total})`);
      } else if (event === 'slideError') {
        addMessage(`第 ${data.index + 1} 页生成失败：${data.error}`, 'agent');
      } else if (event === 'done') {
        clearLoading(msg, `全部 ${total} 页生成完成。可以继续输入修改指令，或点击右上角导出。`);
        state.phase = 'slides';
        $('export-btn').disabled = false;
      } else if (event === 'fatal') {
        clearLoading(msg, `生成中断：${data.error}`);
      }
    }
  }
}

// ---------- 局部修改 ----------
async function doRevise(instruction) {
  const msg = addMessage('正在修改…', 'agent');
  setLoading(msg, '正在修改…');
  try {
    const resp = await api('/api/revise', { slides: state.slides, instruction });
    const data = await resp.json();
    state.slides = data.slides;
    slidesEl.innerHTML = '';
    state.slides.forEach((s) => s && renderSlide(s));
    clearLoading(msg, '修改完成。');
  } catch (err) {
    clearLoading(msg, `修改失败：${err.message}`);
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
  }
  card.innerHTML = num + inner;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 事件 ----------
$('input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  addMessage(text, 'user');
  if (state.phase === 'slides') {
    doRevise(text);
  } else {
    doOutline(text, Number($('pages').value) || 8);
  }
});

$('gen-slides-btn').addEventListener('click', doSlides);
$('regen-outline-btn').addEventListener('click', () => {
  if (state.topic) doOutline(state.topic, Number($('pages').value) || 8);
});

$('export-btn').addEventListener('click', async () => {
  try {
    const resp = await api('/api/export', { slides: state.slides, title: state.outline?.title });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.outline?.title || 'slides'}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    addMessage(`导出失败：${err.message}`, 'agent');
  }
});

// API Key 弹窗
$('key-btn').addEventListener('click', () => $('key-dialog').showModal());
$('key-cancel').addEventListener('click', () => $('key-dialog').close());
$('key-save').addEventListener('click', async () => {
  const key = $('key-input').value.trim();
  if (key) await api('/api/config', { apiKey: key }).catch(() => {});
  $('key-dialog').close();
  refreshConfig();
});

async function refreshConfig() {
  const resp = await fetch('/api/config');
  const cfg = await resp.json();
  $('model-info').textContent = `${cfg.model}`;
  $('key-btn').textContent = cfg.hasKey ? 'API Key ✓' : '设置 API Key';
}
refreshConfig();

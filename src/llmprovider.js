// LLM Provider 抽象层：多供应商实例 × 多模型，按「能力」路由
// 能力: chat(文本对话) / vision(多模态识图) / image(生图) / video(生视频,预留) / music(生音乐,预留)
//
// 配置 schema（~/.king-ppt/config.json）：
// {
//   instances: {
//     [id]: { id, preset, name, adapter, baseURL, apiKey, enabled,
//             models: [{ id, caps: ['chat','vision','image'] }] }
//   },
//   active: { [capability]: { instance: id, model: modelId } }
// }
const crypto = require('crypto');
const store = require('./config');

const CAPABILITIES = ['chat', 'vision', 'image', 'video', 'music'];
const CAPABILITY_LABELS = { chat: '文本对话', vision: '多模态识图', image: '图像生成', video: '视频生成', music: '音乐生成' };

// ---------- 供应商模板（一键添加用；自定义中转站走 custom） ----------
// adapter: 'openai' = OpenAI 兼容端点；'gemini' = Google 原生 API
// short/color: 列表头像；tagline/tag: 推荐卡片展示
// 注意：模板不再预置模型（models 恒为空），模型由用户手动添加或从接口拉取后多选
const PROVIDER_TEMPLATES = [
  {
    id: 'openai', name: 'OpenAI', adapter: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: [],
    keyUrl: 'https://platform.openai.com/api-keys',
    short: 'O', color: '#10a37f', tagline: '官方稳定', tag: '官方稳定',
  },
  {
    id: 'siliconflow', name: '硅基流动', adapter: 'openai',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: [],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    short: '硅', color: '#6d28d9', tagline: '国内直连便宜', tag: '国内直连便宜',
  },
  {
    id: 'kimi', name: 'Kimi（月之暗面）', adapter: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    short: 'K', color: '#0f0f1a', tagline: '长文本强', tag: '长文本',
  },
  {
    id: 'deepseek', name: 'DeepSeek', adapter: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    models: [],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    short: 'D', color: '#4d6bfe', tagline: '高性价比', tag: '高性价比',
  },
  {
    id: 'zhipu', name: '智谱 GLM', adapter: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    short: '智', color: '#3b5bfd', tagline: '免费额度多', tag: '免费额度',
  },
  {
    id: 'qwen', name: '通义千问（阿里云）', adapter: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    keyUrl: 'https://bailian.console.aliyun.com/#/api-key',
    short: '通', color: '#7c3aed', tagline: '全家桶', tag: '文本/识图',
  },
  {
    id: 'doubao', name: '豆包（火山方舟）', adapter: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    short: '豆', color: '#3251e6', tagline: '字节出品', tag: '字节出品',
  },
  {
    // 国内站 api.minimaxi.com；国际站为 api.minimax.io，两边 API Key 不通用
    id: 'minimax', name: 'MiniMax', adapter: 'openai',
    baseURL: 'https://api.minimaxi.com/v1',
    models: [],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    short: 'M', color: '#ff3b30', tagline: 'M 系列旗舰', tag: '文本/识图',
  },
  {
    id: 'gemini', name: 'Google Gemini', adapter: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: [],
    keyUrl: 'https://aistudio.google.com/apikey',
    short: 'G', color: '#1a73e8', tagline: '免费额度大', tag: '需网络环境',
  },
  {
    id: 'ollama', name: '本地 Ollama', adapter: 'openai',
    baseURL: 'http://localhost:11434/v1',
    models: [],
    noKey: true,
    short: 'Ol', color: '#111827', tagline: '隐私本地', tag: '隐私本地',
  },
  {
    id: 'custom', name: '自定义 / 中转站', adapter: 'openai',
    baseURL: '',
    models: [],
    short: '＋', color: '#64748b', tagline: '任意 OpenAI 兼容端点', tag: '中转/私有',
  },
];

// 旧版模板预置模型（仅用于一次性清理既有实例中的默认模型）
const LEGACY_DEFAULT_MODELS = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-image-1'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2-VL-72B-Instruct', 'black-forest-labs/FLUX.1-dev'],
  kimi: ['kimi-k2-0905-preview', 'moonshot-v1-8k-vision-preview'],
  deepseek: ['deepseek-chat'],
  zhipu: ['glm-4-flash', 'glm-4v-flash'],
  qwen: ['qwen-plus', 'qwen-vl-plus', 'wanx2.1-t2i-turbo'],
  doubao: ['doubao-1-5-pro-32k-250115', 'doubao-1-5-vision-pro-32k-250115'],
  gemini: ['gemini-2.0-flash'],
  ollama: ['qwen3:8b', 'llava:13b'],
};

function getTemplate(id) {
  return PROVIDER_TEMPLATES.find((t) => t.id === id) || null;
}

// ---------- 错误 ----------
function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------- 兼容旧版「页面临时填 key」 ----------
let legacyRuntimeKey = null;
function setLegacyApiKey(key) { legacyRuntimeKey = key || null; }

// ---------- 状态与迁移 ----------
function getState() {
  const cfg = store.getConfig();
  if (!cfg.instances) migrate(cfg);
  cfg.instances = cfg.instances || {};
  cfg.active = cfg.active || {};
  if (!cfg.noDefaultModelsCleaned) cleanLegacyDefaultModels(cfg);
  return cfg;
}

// 一次性清理：移除既有实例中来自旧版模板预置的默认模型（用户手动添加/拉取的保留），
// 同时清理指向被删模型的默认绑定
function cleanLegacyDefaultModels(cfg) {
  for (const inst of Object.values(cfg.instances)) {
    const legacy = inst.preset && LEGACY_DEFAULT_MODELS[inst.preset];
    if (legacy) inst.models = inst.models.filter((m) => !legacy.includes(m.id));
  }
  for (const [cap, b] of Object.entries(cfg.active)) {
    const inst = cfg.instances[b.instance];
    if (inst && !inst.models.some((m) => m.id === b.model)) delete cfg.active[cap];
  }
  cfg.noDefaultModelsCleaned = true;
  store.saveConfig(cfg);
}

// 旧 schema（providers: {presetId: {apiKey, baseURL, models:{cap:model}}}）→ 实例 schema
function migrate(cfg) {
  const instances = {};
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    const tpl = getTemplate(pid);
    if (!tpl && !p.baseURL) continue;
    const id = `inst_${pid}`;
    const models = (tpl ? tpl.models : []).map((m) => ({ id: m.id, caps: [...m.caps] }));
    // 应用旧配置里的模型名覆盖
    if (tpl && p.models) {
      for (const [cap, modelId] of Object.entries(p.models)) {
        if (!modelId) continue;
        const existing = models.find((m) => m.id === modelId);
        if (existing) {
          if (!existing.caps.includes(cap)) existing.caps.push(cap);
        } else {
          models.push({ id: modelId, caps: [cap] });
        }
      }
    }
    instances[id] = {
      id,
      preset: tpl ? pid : null,
      name: tpl ? tpl.name : '自定义供应商',
      adapter: tpl ? tpl.adapter : 'openai',
      baseURL: p.baseURL || (tpl ? tpl.baseURL : ''),
      apiKey: p.apiKey || '',
      enabled: true,
      models,
    };
  }
  const active = {};
  for (const [cap, b] of Object.entries(cfg.active || {})) {
    const instId = `inst_${b.provider}`;
    if (instances[instId]) active[cap] = { instance: instId, model: b.model };
  }
  cfg.instances = instances;
  cfg.active = active;
  delete cfg.providers;
  store.saveConfig(cfg);
}

// ---------- 实例 CRUD ----------
function createInstance({ preset, name, baseURL, apiKey } = {}) {
  const state = getState();
  const tpl = preset ? getTemplate(preset) : null;
  if (preset && !tpl) throw fail(`未知的供应商模板: ${preset}`, 'NO_MODEL_CONFIG');
  if (!tpl && !name) throw fail('自定义供应商需要填写名称', 'NO_MODEL_CONFIG');
  const id = `inst_${crypto.randomBytes(4).toString('hex')}`;
  state.instances[id] = {
    id,
    preset: tpl ? tpl.id : null,
    name: name || tpl.name,
    adapter: tpl ? tpl.adapter : 'openai',
    baseURL: (baseURL ?? tpl?.baseURL ?? '').replace(/\/$/, ''),
    apiKey: apiKey || '',
    enabled: true,
    models: tpl ? tpl.models.map((m) => ({ ...m, caps: [...m.caps] })) : [],
  };
  store.saveConfig(state);
  return state.instances[id];
}

function updateInstance(id, patch = {}) {
  const state = getState();
  const inst = state.instances[id];
  if (!inst) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  // 空字符串视为「不修改」，null 视为「清除」
  for (const key of ['name', 'apiKey', 'enabled']) {
    if (patch[key] !== undefined && patch[key] !== '') inst[key] = patch[key];
  }
  if (patch.baseURL !== undefined && patch.baseURL !== '') {
    inst.baseURL = String(patch.baseURL).replace(/\/$/, '');
  }
  store.saveConfig(state);
  return inst;
}

function deleteInstance(id) {
  const state = getState();
  if (!state.instances[id]) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  delete state.instances[id];
  for (const [cap, b] of Object.entries(state.active)) {
    if (b.instance === id) delete state.active[cap];
  }
  store.saveConfig(state);
}

function addModel(instanceId, modelId, caps = ['chat'], enabled = undefined) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  if (!modelId || !modelId.trim()) throw fail('模型名不能为空', 'NO_MODEL_CONFIG');
  const id = modelId.trim();
  const existing = inst.models.find((m) => m.id === id);
  if (existing) {
    if (Array.isArray(caps) && caps.length) {
      const cleanCaps = [...new Set(caps)].filter((c) => CAPABILITIES.includes(c));
      if (cleanCaps.length === 0) throw fail('无效的能力标记', 'NO_MODEL_CONFIG');
      existing.caps = cleanCaps; // upsert：精确覆盖能力标记
    }
    if (enabled !== undefined) existing.enabled = Boolean(enabled);
  } else {
    if (!Array.isArray(caps) || caps.length === 0) throw fail('模型至少保留一种能力', 'NO_MODEL_CONFIG');
    const cleanCaps = [...new Set(caps)].filter((c) => CAPABILITIES.includes(c));
    if (cleanCaps.length === 0) throw fail('无效的能力标记', 'NO_MODEL_CONFIG');
    inst.models.push({ id, caps: cleanCaps, enabled: enabled !== false });
  }
  store.saveConfig(state);
  return inst.models;
}

function removeModel(instanceId, modelId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  inst.models = inst.models.filter((m) => m.id !== modelId);
  for (const [cap, b] of Object.entries(state.active)) {
    if (b.instance === instanceId && b.model === modelId) delete state.active[cap];
  }
  store.saveConfig(state);
  return inst.models;
}

// 从远端 /models 拉取模型列表（只读，不写库；由前端弹窗让用户多选后再逐个添加）
async function peekRemoteModels(instanceId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const { value: ids, suggestedBaseURL } = await fetchRemoteModelIds(inst);
  return { ids, existing: inst.models.map((m) => m.id), suggestedBaseURL };
}

async function fetchRemoteModelIds(inst) {
  const { baseURL, apiKey } = instAuth(inst);
  const fetchAt = async (candidate) => {
    if (inst.adapter === 'gemini') {
      const resp = await fetch(`${candidate}/models`, { headers: { 'x-goog-api-key': apiKey } });
      if (!resp.ok) {
        const err = fail(`拉取模型列表失败 (${resp.status})`, 'LLM_HTTP');
        err.httpStatus = resp.status;
        throw err;
      }
      const data = await resp.json();
      return (data.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    }
    const resp = await fetch(`${candidate}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!resp.ok) {
      const err = fail(`拉取模型列表失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    const data = await resp.json();
    return (data.data || []).map((m) => m.id).filter(Boolean);
  };
  return probeCandidates(baseURL, fetchAt); // { value: ids, resolvedBaseURL, suggestedBaseURL }
}

// ---------- 能力激活绑定 ----------
function setActiveBinding(capability, instanceId, model) {
  if (!CAPABILITIES.includes(capability)) throw fail(`未知的能力: ${capability}`, 'NO_MODEL_CONFIG');
  const state = getState();
  if (!state.instances[instanceId]) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  if (!model) throw fail('模型名不能为空', 'NO_MODEL_CONFIG');
  state.active[capability] = { instance: instanceId, model };
  store.saveConfig(state);
  return state.active;
}

// ---------- 解析某能力的生效配置 ----------
function instAuth(inst) {
  const tpl = inst.preset ? getTemplate(inst.preset) : null;
  // 只用实例自己存的 Key（openai 预设额外支持环境变量），不回退全局运行时 Key，
  // 否则 A 供应商的 Key 会被误当成 B 供应商的 Key 使用
  const apiKey = inst.apiKey
    || (inst.preset === 'openai' ? process.env.OPENAI_API_KEY : null);
  return { baseURL: (inst.baseURL || '').replace(/\/$/, ''), apiKey, noKey: Boolean(tpl?.noKey) };
}

function resolve(capability) {
  const state = getState();
  let binding = state.active[capability];
  if (!binding && capability === 'vision') binding = state.active.chat;

  if (!binding && capability === 'chat') {
    // 环境变量兜底（向后兼容旧版用法）
    const apiKey = legacyRuntimeKey || process.env.OPENAI_API_KEY || null;
    if (!apiKey) {
      throw fail('尚未配置模型：请打开右上角「模型设置」添加供应商并选择默认模型', 'NO_API_KEY');
    }
    return {
      instance: { name: 'OpenAI' },
      adapter: 'openai',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey,
    };
  }
  if (!binding) {
    throw fail(`尚未为「${CAPABILITY_LABELS[capability]}」能力选择默认模型，请打开右上角「模型设置」`, 'NO_MODEL_CONFIG');
  }
  const inst = state.instances[binding.instance];
  if (!inst) throw fail('默认模型指向的供应商已被删除，请重新选择', 'NO_MODEL_CONFIG');
  if (inst.enabled === false) throw fail(`供应商「${inst.name}」已停用，请在模型设置中启用`, 'NO_MODEL_CONFIG');
  const { baseURL, apiKey, noKey } = instAuth(inst);
  if (!baseURL) throw fail(`供应商「${inst.name}」缺少服务地址（baseURL）`, 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) {
    throw fail(`未配置「${inst.name}」的 API Key：请打开右上角「模型设置」填写`, 'NO_API_KEY');
  }
  return { instance: inst, adapter: inst.adapter, model: binding.model, baseURL, apiKey };
}

// ---------- HTTP 工具 ----------
async function postJSON(url, { key, body, headers = {} }) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = fail(`模型请求失败 (${resp.status}): ${text.slice(0, 300)}`, 'LLM_HTTP');
    err.httpStatus = resp.status;
    throw err;
  }
  return resp.json();
}

// ---------- Base URL 归一化与候选探测（防呆：忘加 /v1） ----------
// 去首尾空白与尾斜杠，剥掉误粘贴的 /chat/completions、/models 后缀
function normalizeBaseURL(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '');
}

// 仅当路径为空（或 /）时追加 +/v1 候选；路径已有 /v\d+ 或其他段则不探测，避免搞错智谱 /api/paas/v4 这类地址
function baseURLCandidates(raw) {
  const u = normalizeBaseURL(raw);
  if (!u) return [];
  let pathname = '';
  try { pathname = new URL(u).pathname; } catch { return [u]; }
  if (!pathname || pathname === '/') return [u, `${u}/v1`];
  return [u];
}

// 依次用候选 baseURL 执行 fn(candidate)，404 时尝试下一个候选，其余错误直接抛出
// 返回 { value, resolvedBaseURL, suggestedBaseURL }（suggestedBaseURL = 实际跑通的地址与用户填写不一致时给出）
async function probeCandidates(rawBase, fn) {
  const candidates = baseURLCandidates(rawBase);
  const raw = String(rawBase || '').trim().replace(/\/+$/, '');
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const value = await fn(candidate);
      return {
        value,
        resolvedBaseURL: candidate,
        suggestedBaseURL: candidate !== raw ? candidate : null,
      };
    } catch (err) {
      lastErr = err;
      const isLast = candidate === candidates[candidates.length - 1];
      // 404 = 路径不存在，值得试下一个；401/403 = 路径在只是 Key 错；网络错误 = 换地址也没用
      if (err.httpStatus === 404 && !isLast) continue;
      throw err;
    }
  }
  throw lastErr;
}

// ---------- 适配器：OpenAI 兼容 ----------
const openaiAdapter = {
  async chat(ctx, messages, { temperature = 0.7, json = false, maxTokens } = {}) {
    const body = { model: ctx.model, messages, temperature };
    if (json) body.response_format = { type: 'json_object' };
    if (maxTokens) body.max_tokens = maxTokens;
    const data = await postJSON(`${ctx.baseURL}/chat/completions`, { key: ctx.apiKey, body });
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw fail('模型返回内容为空', 'LLM_EMPTY');
    return content;
  },

  async generateImage(ctx, prompt, { size = '1024x1024' } = {}) {
    const data = await postJSON(`${ctx.baseURL}/images/generations`, {
      key: ctx.apiKey,
      body: { model: ctx.model, prompt, n: 1, size },
    });
    const item = data.data?.[0];
    if (!item) throw fail('图像生成返回为空', 'LLM_EMPTY');
    return { url: item.url || null, b64: item.b64_json || null };
  },

  async test(ctx) {
    const resp = await fetch(`${ctx.baseURL}/models`, {
      headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    });
    if (!resp.ok) {
      const err = fail(`连接测试失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    return true;
  },
};

// ---------- 适配器：Google Gemini 原生 ----------
function toGeminiContents(messages) {
  let system = '';
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n' : '') + m.content; continue; }
    const parts = Array.isArray(m.content)
      ? m.content.map((p) => p.type === 'image_url'
        ? { inline_data: { mime_type: 'image/png', data: String(p.image_url?.url || '').split(',')[1] || '' } }
        : { text: p.text || '' })
      : [{ text: String(m.content) }];
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return { system, contents };
}

const geminiAdapter = {
  async chat(ctx, messages, { temperature = 0.7, json = false, maxTokens } = {}) {
    const { system, contents } = toGeminiContents(messages);
    const body = { contents, generationConfig: { temperature } };
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
    if (system) body.system_instruction = { parts: [{ text: system }] };
    if (json) body.generationConfig.response_mime_type = 'application/json';
    const url = `${ctx.baseURL}/models/${ctx.model}:generateContent`;
    const data = await postJSON(url, { key: null, headers: { 'x-goog-api-key': ctx.apiKey }, body });
    const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!content) throw fail('模型返回内容为空', 'LLM_EMPTY');
    return content;
  },

  async test(ctx) {
    const resp = await fetch(`${ctx.baseURL}/models`, { headers: { 'x-goog-api-key': ctx.apiKey } });
    if (!resp.ok) {
      const err = fail(`连接测试失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    return true;
  },
};

const ADAPTERS = { openai: openaiAdapter, gemini: geminiAdapter };

// ---------- 统一调用入口 ----------
// messages 支持 OpenAI 多模态格式：content 可为 [{type:'text'},{type:'image_url',image_url:{url}}]
async function chat(capability, messages, opts = {}) {
  const ctx = resolve(capability === 'vision' ? 'vision' : 'chat');
  return ADAPTERS[ctx.adapter].chat(ctx, messages, opts);
}

async function generateImage(prompt, opts = {}) {
  const ctx = resolve('image');
  const adapter = ADAPTERS[ctx.adapter];
  if (!adapter.generateImage) {
    throw fail(`供应商「${ctx.instance.name}」暂不支持图像生成`, 'CAPABILITY_NOT_SUPPORTED');
  }
  return adapter.generateImage(ctx, prompt, opts);
}

// ---------- 异步任务抽象（视频 / 音乐生成，预留） ----------
// 任务式生成的通用轮询器：submit 返回任务句柄，poll 查询状态，extract 取结果
async function runTask({ submit, poll, isDone, extract, intervalMs = 5000, timeoutMs = 10 * 60 * 1000 }) {
  const handle = await submit();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const status = await poll(handle);
    if (isDone(status)) return extract(status);
  }
  throw fail('生成任务超时', 'TASK_TIMEOUT');
}

async function generateVideo(prompt, opts = {}) {
  const ctx = resolve('video');
  const adapter = ADAPTERS[ctx.adapter];
  if (!adapter.generateVideo) {
    throw fail(
      `供应商「${ctx.instance.name}」的视频生成尚未实装。` +
      `可在 src/llmprovider.js 的适配器中实现 generateVideo(ctx, prompt, opts)，` +
      `异步任务可复用 runTask({submit, poll, isDone, extract}) 轮询器`,
      'CAPABILITY_NOT_SUPPORTED'
    );
  }
  return adapter.generateVideo(ctx, prompt, opts);
}

async function generateMusic(prompt, opts = {}) {
  const ctx = resolve('music');
  const adapter = ADAPTERS[ctx.adapter];
  if (!adapter.generateMusic) {
    throw fail(
      `供应商「${ctx.instance.name}」的音乐生成尚未实装。` +
      `可在 src/llmprovider.js 的适配器中实现 generateMusic(ctx, prompt, opts)，` +
      `异步任务可复用 runTask({submit, poll, isDone, extract}) 轮询器`,
      'CAPABILITY_NOT_SUPPORTED'
    );
  }
  return adapter.generateMusic(ctx, prompt, opts);
}

// ---------- 给前端的安全视图（不回传 key 明文） ----------
// 缩略掩码：前 4 位 + **** + 后 4 位；过短则全掩
function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  return s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****';
}

function listInstances() {
  const state = getState();
  return Object.values(state.instances).map((inst) => {
    const tpl = inst.preset ? getTemplate(inst.preset) : null;
    const { apiKey, noKey } = instAuth(inst);
    return {
      id: inst.id,
      preset: inst.preset,
      name: inst.name,
      baseURL: inst.baseURL,
      enabled: inst.enabled !== false,
      hasKey: Boolean(apiKey),
      keyPreview: maskKey(apiKey),
      noKey,
      keyUrl: tpl?.keyUrl || null,
      models: inst.models.map((m) => ({
        id: m.id, caps: m.caps, enabled: m.enabled !== false,
        lastTest: m.lastTest || null, lastError: m.lastError || null,
      })),
    };
  });
}

function listActive() {
  const state = getState();
  const active = {};
  for (const cap of CAPABILITIES) {
    const b = state.active[cap] || (cap === 'vision' ? state.active.chat : null);
    const inst = b && state.instances[b.instance];
    active[cap] = b && inst
      ? { instance: inst.id, instanceName: inst.name, model: b.model }
      : cap === 'chat' && !b
        ? (process.env.OPENAI_API_KEY
          ? { instance: null, instanceName: 'OpenAI（环境变量）', model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }
          : null)
        : null;
  }
  return active;
}

// override: 可选的候选 baseURL/apiKey，只用于测试，不写入配置
// 返回 { ok, resolvedBaseURL, suggestedBaseURL }：跑通的是补 /v1 的候选时给出 suggestedBaseURL
async function testInstance(id, override = {}) {
  const state = getState();
  const inst = state.instances[id];
  if (!inst) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  const auth = instAuth(inst);
  const rawBase = override.baseURL || auth.baseURL;
  const apiKey = override.apiKey || auth.apiKey;
  const { noKey } = auth;
  if (!rawBase) throw fail('请先填写服务地址（baseURL）', 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) throw fail('请先填写 API Key', 'NO_API_KEY');
  const { resolvedBaseURL, suggestedBaseURL } = await probeCandidates(
    rawBase,
    (candidate) => ADAPTERS[inst.adapter].test({ baseURL: candidate, apiKey }),
  );
  return { ok: true, resolvedBaseURL, suggestedBaseURL };
}

// ---------- 单模型实测（真实发一条短消息，通过则给模型打上已验证标记） ----------
async function testModel(instanceId, modelId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const model = inst.models.find((m) => m.id === modelId);
  if (!model) throw fail(`模型不存在: ${modelId}`, 'NO_MODEL_CONFIG');
  const { baseURL, apiKey, noKey } = instAuth(inst);
  if (!baseURL) throw fail('请先填写服务地址（baseURL）', 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) throw fail('请先填写 API Key', 'NO_API_KEY');

  const mark = (ok, error) => {
    model.lastTest = ok ? 'ok' : 'fail';
    model.testedAt = Date.now();
    model.lastError = ok ? undefined : error;
    store.saveConfig(state);
  };

  try {
    const { resolvedBaseURL, suggestedBaseURL } = await probeCandidates(
      baseURL,
      (candidate) => ADAPTERS[inst.adapter].chat(
        { baseURL: candidate, apiKey, model: modelId },
        [{ role: 'user', content: '你好，这是一条连通性测试消息，请回复「您好」。' }],
        { temperature: 0 }, // 不限 max_tokens，让模型（含推理模型）自然完成回复
      ).catch((err) => {
        // HTTP 200 但正文为空的极端情况：端点确实返回了结构完整的响应，算通过
        if (err.code === 'LLM_EMPTY') return null;
        throw err;
      }),
    );
    mark(true);
    return { ok: true, model: modelId, resolvedBaseURL, suggestedBaseURL };
  } catch (err) {
    mark(false, err.message);
    return { ok: false, model: modelId, error: err.message };
  }
}

// 批量实测该供应商下所有启用的 chat/vision 模型（生图模型调用即扣费，不测）
async function testModels(instanceId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const targets = inst.models.filter((m) => m.enabled !== false
    && (m.caps.includes('chat') || m.caps.includes('vision')));
  const results = [];
  for (const m of targets) results.push(await testModel(instanceId, m.id));
  return { results };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_LABELS,
  chat,
  generateImage,
  generateVideo,
  generateMusic,
  runTask,
  // 模板与实例
  PROVIDER_TEMPLATES,
  getTemplate,
  listInstances,
  listActive,
  createInstance,
  updateInstance,
  deleteInstance,
  addModel,
  removeModel,
  peekRemoteModels,
  testModel,
  testModels,
  setActiveBinding,
  testInstance,
  setLegacyApiKey,
};

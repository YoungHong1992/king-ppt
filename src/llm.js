// 单一 OpenAI 兼容 LLM 客户端。移植自已退役的 llmprovider.js 的 OpenAI 适配器 + baseURL 防呆探测。
// 只保留文本 chat + 连接测试；多供应商 / 多能力 / Gemini 适配器 / 多实例 schema 一律不复活。
const config = require('./config');

const REQUEST_TIMEOUT_MS = 120000; // 出站请求硬超时：上游僵死时快速失败，及时释放 generate-outline 的 inflight 锁

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Bearer 鉴权的 POST；非 2xx 抛错并带 httpStatus（供 probeCandidates 判 404 换候选）。带硬超时。
async function postJSON(url, { key, body, headers = {} }) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('模型请求超时', 'LLM_TIMEOUT');
    throw fail(`模型连接失败：${e.message}`, 'LLM_HTTP');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = fail(`模型请求失败 (${resp.status}): ${text.slice(0, 300)}`, 'LLM_HTTP');
    err.httpStatus = resp.status;
    throw err;
  }
  return resp.json();
}

// 去首尾空白与尾斜杠，剥掉误粘贴的 /chat/completions、/models 后缀
function normalizeBaseURL(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '');
}

// 仅当路径为空（或 /）时追加 +/v1 候选；已有 /v\d+ 或其他段则不探测（避免搞错智谱 /api/paas/v4 这类地址）
function baseURLCandidates(raw) {
  const u = normalizeBaseURL(raw);
  if (!u) return [];
  let pathname = '';
  try { pathname = new URL(u).pathname; } catch { return [u]; }
  if (!pathname || pathname === '/') return [u, `${u}/v1`];
  return [u];
}

// 依次用候选 baseURL 执行 fn(candidate)，404 时试下一个，其余错误直接抛。
// 返回 { value, resolvedBaseURL, suggestedBaseURL }（suggestedBaseURL = 跑通地址与用户填写不一致时给出）
async function probeCandidates(rawBase, fn) {
  const candidates = baseURLCandidates(rawBase);
  const raw = String(rawBase || '').trim().replace(/\/+$/, '');
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const value = await fn(candidate);
      return { value, resolvedBaseURL: candidate, suggestedBaseURL: candidate !== raw ? candidate : null };
    } catch (err) {
      lastErr = err;
      const isLast = candidate === candidates[candidates.length - 1];
      if (err.httpStatus === 404 && !isLast) continue; // 404=路径不存在,值得换候选；401/403/网络错=换地址没用
      throw err;
    }
  }
  throw lastErr;
}

// 文本对话：解析生效配置 → 经 probeCandidates 自愈缺失的 /v1 → 返回 choices[0].message.content
async function chat(messages, { temperature = 0.7, json = false, maxTokens } = {}) {
  const { baseURL, apiKey, model } = config.resolve();
  if (!apiKey) throw fail('尚未配置 API Key：请打开右上角设置填写', 'NO_API_KEY');
  const { value } = await probeCandidates(baseURL, async (candidate) => {
    const body = { model, messages, temperature };
    if (json) body.response_format = { type: 'json_object' };
    if (maxTokens) body.max_tokens = maxTokens;
    const data = await postJSON(`${candidate}/chat/completions`, { key: apiKey, body });
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw fail('模型返回内容为空', 'LLM_EMPTY');
    return content;
  });
  return value;
}

// 连接测试：GET {baseURL}/models（经候选探测）。body 传入的 baseURL/apiKey 优先于已存配置，供「存库前先测」。
// 返回 { ok, resolvedBaseURL, suggestedBaseURL }
async function test({ baseURL, apiKey } = {}) {
  const eff = config.resolve();
  const rawBase = (baseURL && String(baseURL).trim()) || eff.baseURL;
  const key = (apiKey && String(apiKey).trim()) || eff.apiKey;
  if (!rawBase) throw fail('请先填写服务地址（baseURL）', 'NO_MODEL_CONFIG');
  if (!key) throw fail('请先填写 API Key', 'NO_API_KEY');
  const { resolvedBaseURL, suggestedBaseURL } = await probeCandidates(rawBase, async (candidate) => {
    let resp;
    try {
      resp = await fetch(`${candidate}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('连接测试超时', 'LLM_TIMEOUT');
      throw fail(`连接失败：${e.message}`, 'LLM_HTTP');
    }
    if (!resp.ok) {
      const err = fail(`连接测试失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    return true;
  });
  return { ok: true, resolvedBaseURL, suggestedBaseURL };
}

// 从模型输出容错提取 JSON（移植自旧 llm.js；M2 结构化输出备用）
function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('模型输出中未找到 JSON');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error('模型输出的 JSON 不完整');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// 从模型输出剥出 SVG（剥围栏/前言，截 <svg…</svg>）。normalize() 要求字符串以 <svg 起头。M2 用。
function extractSvg(text) {
  const s = String(text || '').replace(/```(?:svg|xml|html)?/gi, '');
  const start = s.search(/<svg[\s>]/i);
  if (start === -1) return '';
  const end = s.lastIndexOf('</svg>');
  if (end === -1 || end < start) return '';
  return s.slice(start, end + 6);
}

module.exports = { chat, test, postJSON, normalizeBaseURL, baseURLCandidates, probeCandidates, extractJson, extractSvg };

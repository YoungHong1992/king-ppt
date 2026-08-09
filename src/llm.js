// OpenAI 兼容的 chat 客户端（Node 18+ 内置 fetch）

const BASE_URL = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

let runtimeKey = null; // 允许前端在页面里临时填写 key
function setApiKey(key) { runtimeKey = key || null; }
function getApiKey() { return runtimeKey || process.env.OPENAI_API_KEY || null; }

async function chat(messages, { temperature = 0.7, json = false } = {}) {
  const key = getApiKey();
  if (!key) {
    const err = new Error('未配置 API Key：请设置环境变量 OPENAI_API_KEY，或在页面右上角填写');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const body = { model: MODEL(), messages, temperature };
  if (json) body.response_format = { type: 'json_object' };

  const resp = await fetch(`${BASE_URL()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`LLM 请求失败 (${resp.status}): ${text.slice(0, 300)}`);
    err.code = 'LLM_HTTP';
    throw err;
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回内容为空');
  return content;
}

// 从模型输出中容错提取 JSON 对象/数组
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('模型输出中未找到 JSON');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error('模型输出的 JSON 不完整');
  return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = { chat, extractJson, setApiKey, getApiKey, BASE_URL, MODEL };

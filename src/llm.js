// 薄封装：保持旧接口不变（agent.js 无需改动），内部走 llmprovider 多供应商层
const provider = require('./llmprovider');

const BASE_URL = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 旧版「页面临时填 key」入口，转发给 provider 层
let legacyKey = null;
function setApiKey(key) { legacyKey = key || null; provider.setLegacyApiKey(key); }
function getApiKey() { return legacyKey || process.env.OPENAI_API_KEY || null; }

// 文本对话（chat 能力）
function chat(messages, opts = {}) {
  return provider.chat('chat', messages, opts);
}

// 多模态识图（vision 能力）：messages 的 content 支持
// [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
function chatVision(messages, opts = {}) {
  return provider.chat('vision', messages, opts);
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

module.exports = { chat, chatVision, extractJson, setApiKey, getApiKey, BASE_URL, MODEL };

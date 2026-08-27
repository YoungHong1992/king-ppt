// 薄封装：保持旧接口不变（generate-outline.js 无需改动），内部走 llmprovider 多供应商层。
// 多供应商解析、适配器、baseURL 探测、连接/模型实测全在 llmprovider.js。
const provider = require('./llmprovider');

// 文本对话（chat 能力）
function chat(messages, opts = {}) {
  return provider.chat('chat', messages, opts);
}

// 多模态识图（vision 能力）：messages 的 content 支持
// [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
function chatVision(messages, opts = {}) {
  return provider.chat('vision', messages, opts);
}

// 图像生成：统一暴露给出片管线，返回供应商的 url 或 base64 结果。
function generateImage(prompt, opts = {}) {
  return provider.generateImage(prompt, opts);
}

// 从模型输出容错提取 JSON 对象/数组（M2 结构化输出备用）
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

module.exports = { chat, chatVision, generateImage, extractJson, extractSvg };

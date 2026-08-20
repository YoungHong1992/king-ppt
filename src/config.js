// 单一 OpenAI 兼容 provider 的配置存储。落 KING_PPT_HOME/config.json（.gitignore 已排除 .king-ppt/）。
// 含 API Key，绝不入库外泄：publicView 只回 hasKey + 掩码，永不回传明文。
// schema 收敛为一层扁平 { baseURL, apiKey, model }（当年 11 家多实例 schema 一律不复活）。
const fs = require('fs');
const path = require('path');
const { CONFIG_FILE } = require('./paths');

// env 回退（向后兼容 OPENAI_* 惯例；config 优先于 env）
const ENV_BASE = () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const ENV_KEY = () => process.env.OPENAI_API_KEY || '';
const ENV_MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

let cache = null;

function getConfig() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }
  catch { cache = {}; }
  return cache;
}

// 浅合并 { baseURL, apiKey, model }。
// 空字符串 apiKey 视为「保留原值」——让浏览器能只改 baseURL/model 而不必重发 key。
function saveConfig(patch = {}) {
  const cfg = { ...getConfig() };
  if (patch.baseURL !== undefined) cfg.baseURL = String(patch.baseURL || '').trim().replace(/\/+$/, '');
  if (patch.model !== undefined) cfg.model = String(patch.model || '').trim();
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') cfg.apiKey = patch.apiKey.trim();
  cache = cfg;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 生效配置：config 覆盖 env 回退。供 llm.js 解析实际请求参数。
function resolve() {
  const cfg = getConfig();
  return {
    baseURL: (cfg.baseURL || ENV_BASE()).replace(/\/+$/, ''),
    apiKey: cfg.apiKey || ENV_KEY(),
    model: cfg.model || ENV_MODEL(),
  };
}

// 是否已具备生成能力（config 或 env 里有 key）。前端据此判定 server-gen 模式。
function hasProvider() {
  return Boolean(getConfig().apiKey || ENV_KEY());
}

// 缩略掩码：前 4 + **** + 后 4；过短则全掩。绝不回传明文 key。
function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  return s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****';
}

// 前端安全视图：有 key 时回显生效的 baseURL/model（不含明文 key），便于设置面板展示当前状态。
function publicView() {
  const cfg = getConfig();
  const envKey = ENV_KEY();
  const key = cfg.apiKey || envKey;
  const source = cfg.apiKey ? 'config' : (envKey ? 'env' : null);
  const eff = resolve();
  return {
    baseURL: key ? eff.baseURL : (cfg.baseURL || ''),
    model: key ? eff.model : (cfg.model || ''),
    hasKey: Boolean(key),
    keyPreview: maskKey(key),
    source, // 'config' | 'env' | null，告诉前端 key 来源
  };
}

module.exports = { getConfig, saveConfig, resolve, hasProvider, maskKey, publicView };

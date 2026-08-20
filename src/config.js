// 持久化配置存储：KING_PPT_HOME/config.json（通用 JSON 整存整取，schema 由 llmprovider 管理）。
// 注意：包含 API Key，绝不入库外泄——llmprovider.listInstances 只回 keyPreview 掩码，永不回传明文。
// .gitignore 已排除 .king-ppt/ 与 **/config.json，防明文 key 入库。
const fs = require('fs');
const path = require('path');
const { CONFIG_FILE } = require('./paths');

let cache = null;

// 返回整个可变配置对象（llmprovider 直接在其上增删 instances/active 后 saveConfig 整存）
function getConfig() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

// 整存整取：把 cfg 全量写盘（不做字段挑选/浅合并，schema 完全交给调用方）
function saveConfig(cfg = cache) {
  cache = cfg;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { getConfig, saveConfig, CONFIG_FILE };

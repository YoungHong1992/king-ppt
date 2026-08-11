// 持久化配置存储：~/.king-ppt/config.json（通用 JSON 读写，schema 由 llmprovider 管理）
// 注意：包含 API Key，绝不入库、不回传明文给前端（只回 hasKey）
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.king-ppt');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let cache = null;

function getConfig() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function saveConfig(cfg = cache) {
  cache = cfg;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { getConfig, saveConfig, CONFIG_FILE };

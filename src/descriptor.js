// 模板描述符加载与枚举：项目 templates/（预设）+ ~/.king-ppt/templates/（用户上传）
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRESET_DIR = path.join(__dirname, '..', 'templates');
const USER_DIR = path.join(os.homedir(), '.king-ppt', 'templates');
const SUPPORTED_SCHEMA_MAJOR = 1; // schemaVersion "1.x" 均兼容
const DEFAULT_TEMPLATE = 'classic-blue';

const cache = new Map();

function templateDir(id) {
  const preset = path.join(PRESET_DIR, id);
  if (fs.existsSync(path.join(preset, 'template.json'))) return preset;
  const user = path.join(USER_DIR, id);
  if (fs.existsSync(path.join(user, 'template.json'))) return user;
  return null;
}

function scanDir(dir, source) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'template.json');
    if (!fs.existsSync(file)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        id: e.name,
        name: (d.meta && d.meta.name) || e.name,
        source,
        preview: path.join(dir, e.name, (d.meta && d.meta.preview) || 'preview.png'),
        hasPreview: fs.existsSync(path.join(dir, e.name, (d.meta && d.meta.preview) || 'preview.png')),
      });
    } catch { /* 跳过损坏的模板 */ }
  }
  return out;
}

function listDescriptors() {
  return [...scanDir(PRESET_DIR, 'preset'), ...scanDir(USER_DIR, 'uploaded')];
}

function loadDescriptor(id = DEFAULT_TEMPLATE) {
  if (cache.has(id)) return cache.get(id);
  const dir = templateDir(id);
  if (!dir) {
    if (id !== DEFAULT_TEMPLATE) return loadDescriptor(DEFAULT_TEMPLATE);
    throw new Error(`默认模板 ${DEFAULT_TEMPLATE} 不存在`);
  }
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8'));
  const major = Number(String(d.schemaVersion || '1.0').split('.')[0]);
  if (major > SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(`模板 ${id} 的 schemaVersion=${d.schemaVersion} 过新，当前仅支持 ${SUPPORTED_SCHEMA_MAJOR}.x`);
  }
  d._dir = dir;          // 模板目录（assets 相对路径基于此解析）
  d._id = id;
  cache.set(id, d);
  return d;
}

// 供测试或模板更新后使用
function clearCache() {
  cache.clear();
}

module.exports = { loadDescriptor, listDescriptors, clearCache, DEFAULT_TEMPLATE, PRESET_DIR, USER_DIR };

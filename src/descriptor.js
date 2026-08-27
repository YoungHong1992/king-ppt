// 模板描述符加载与枚举：只认用户上传的模板（KING_PPT_HOME/templates/）。
// 工程不内置任何画廊模板，也没有默认模板兜底——未指定/找不到模板时直接抛清晰错误，
// 由上层（路由/前端）提示"请先上传模板"。提取上传件的结构脚手架见 src/base-descriptor.js。
const fs = require('fs');
const path = require('path');
const { TEMPLATES_DIR } = require('./paths');
const { loadTemplateProfile } = require('./template-profile');

const USER_DIR = TEMPLATES_DIR;
const SUPPORTED_SCHEMA_MAJOR = 1; // schemaVersion "1.x" 均兼容

const cache = new Map();
const themeCache = new Map();

const DEFAULT_SCALE = {
  display: 96, sectionNo: 120, sectionTitle: 64,
  pageTitle: 44, eyebrow: 22, body: 26, caption: 20, footer: 16,
};

function notFound(id) {
  const e = new Error(id ? `模板「${id}」不存在，请先上传模板` : '未指定模板，请先上传并选择一个模板');
  e.code = 'TEMPLATE_NOT_FOUND';
  return e;
}

// 定位模板目录（仅用户上传目录）。找不到返回 null。
function templateDir(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const dir = path.join(USER_DIR, id);
  if (fs.existsSync(path.join(dir, 'theme.json')) || fs.existsSync(path.join(dir, 'template.json'))) return dir;
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
    const themeFile = path.join(dir, e.name, 'theme.json');
    const tplFile = path.join(dir, e.name, 'template.json');
    // SVG-as-IR：优先 theme.json（新主题包）；无则回退旧 template.json（上传模板）
    if (fs.existsSync(themeFile)) {
      try {
        const t = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
        out.push({ id: e.name, name: t.name || e.name, source, palette: paletteHexOf(t) });
        continue;
      } catch { /* 损坏则尝试 template.json */ }
    }
    if (!fs.existsSync(tplFile)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
      out.push({ id: e.name, name: (d.meta && d.meta.name) || e.name, source, palette: d.palette || {} });
    } catch { /* 跳过损坏的模板 */ }
  }
  return out;
}

// theme.json 的 color 令牌（#RRGGBB）→ 画廊色板需要的裸 hex 映射
function paletteHexOf(theme) {
  const c = (theme.tokens && theme.tokens.color) || {};
  const strip = (v) => (typeof v === 'string' ? v.replace(/^#/, '') : v);
  const out = {};
  for (const [k, v] of Object.entries(c)) out[k] = strip(v);
  return out;
}

function listDescriptors() {
  return scanDir(USER_DIR, 'uploaded');
}

function loadDescriptor(id) {
  if (id && cache.has(id)) return cache.get(id);
  const dir = templateDir(id);
  if (!dir) throw notFound(id);
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

// 供测试或模板更新/删除后使用
function clearCache() {
  cache.clear();
  themeCache.clear();
}

// 删除一份上传模板：移除 USER_DIR/<id> 整个目录，并清缓存。
function deleteTemplate(id) {
  const dir = templateDir(id);
  if (!dir) throw notFound(id);
  const resolved = path.resolve(dir);
  // 安全：必须落在 USER_DIR 之内，杜绝路径穿越
  if (resolved !== path.resolve(USER_DIR) && !resolved.startsWith(path.resolve(USER_DIR) + path.sep)) {
    throw new Error('非法的模板路径');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  clearCache();
  return true;
}

// ---------- 主题令牌（SVG-as-IR 创作契约的数据源） ----------

// 从旧 template.json 合成主题令牌（上传模板尚无 theme.json 时的回退）
function themeFromDescriptor(d) {
  const p = d.palette || {};
  const hex = (v, dft) => (v ? `#${String(v).replace(/^#/, '')}` : dft);
  const fonts = (d.typography && d.typography.fonts) || {};
  const face = (f, dft) => {
    const list = [f && f.ea, f && f.latin].filter(Boolean);
    return list.length ? `'${[...new Set(list)].join("', '")}', sans-serif` : dft;
  };
  const sc = (d.typography && d.typography.scale) || {};
  const color = {};
  for (const [k, v] of Object.entries(p)) color[k] = hex(v);
  return {
    id: d._id,
    name: (d.meta && d.meta.name) || d._id,
    canvas: { vbWidth: 1280, vbHeight: 720 },
    tokens: {
      color: { bg: '#FFFFFF', text: '#333333', ...color },
      font: { title: face(fonts.title, "'Microsoft YaHei', sans-serif"), body: face(fonts.body, "'Microsoft YaHei', sans-serif") },
      scale: { ...DEFAULT_SCALE, ...sc },
      geometry: { cornerRadius: 8, hairline: 2, margin: 80 },
    },
    tone: '简洁专业，大量留白，对齐严谨',
    layouts: ['cover', 'section', 'content', 'closing'],
  };
}

// 加载主题令牌：theme.json 优先；无则从 template.json 合成。找不到模板则抛错。
function loadTheme(id) {
  if (id && themeCache.has(id)) return themeCache.get(id);
  const dir = templateDir(id);
  if (!dir) throw notFound(id);
  const themeFile = path.join(dir, 'theme.json');
  let theme;
  if (fs.existsSync(themeFile)) {
    theme = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
    theme.id = id;
    theme.tokens = theme.tokens || {};
    theme.tokens.scale = { ...DEFAULT_SCALE, ...(theme.tokens.scale || {}) };
    theme._dir = dir;
  } else {
    theme = themeFromDescriptor(loadDescriptor(id));
    theme._dir = dir;
  }
  themeCache.set(id, theme);
  return theme;
}

// 主题的 layouts/*.svg 原型页（若存在）；返回 { name, svg }[]
function loadThemeLayouts(id) {
  const theme = loadTheme(id);
  const dir = path.join(theme._dir, 'layouts');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files.sort()) {
    if (!f.endsWith('.svg')) continue;
    try { out.push({ name: f.replace(/\.svg$/, ''), svg: fs.readFileSync(path.join(dir, f), 'utf8') }); } catch { /* 跳过 */ }
  }
  return out;
}

function loadProfile(id) {
  const dir = templateDir(id);
  return dir ? loadTemplateProfile(dir) : null;
}

module.exports = { loadDescriptor, listDescriptors, clearCache, deleteTemplate, loadTheme, loadThemeLayouts, loadProfile, USER_DIR };

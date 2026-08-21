// 模板描述符加载与枚举：项目 templates/（预设）+ KING_PPT_HOME/templates/（用户上传）
const fs = require('fs');
const path = require('path');
const { TEMPLATES_DIR } = require('./paths');
const { loadTemplateProfile } = require('./template-profile');

const PRESET_DIR = path.join(__dirname, '..', 'templates');
const USER_DIR = TEMPLATES_DIR;
const SUPPORTED_SCHEMA_MAJOR = 1; // schemaVersion "1.x" 均兼容
// 参考样本同源的纸感主题作为默认选择，其他模板仍可在画廊中切换。
const DEFAULT_TEMPLATE = 'warm-retro';

const cache = new Map();

function templateDir(id) {
  const preset = path.join(PRESET_DIR, id);
  if (fs.existsSync(path.join(preset, 'theme.json')) || fs.existsSync(path.join(preset, 'template.json'))) return preset;
  const user = path.join(USER_DIR, id);
  if (fs.existsSync(path.join(user, 'theme.json')) || fs.existsSync(path.join(user, 'template.json'))) return user;
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
    // SVG-as-IR：优先 theme.json（新主题包）；无则回退旧 template.json（上传模板 / 未迁移预设）
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
  themeCache.clear();
}

// ---------- 主题令牌（SVG-as-IR 创作契约的数据源） ----------
const themeCache = new Map();
const DEFAULT_SCALE = {
  display: 96, sectionNo: 120, sectionTitle: 64,
  pageTitle: 44, eyebrow: 22, body: 26, caption: 20, footer: 16,
};

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

// 加载主题令牌：theme.json 优先；无则从 template.json 合成。永远返回可用主题。
function loadTheme(id = DEFAULT_TEMPLATE) {
  if (themeCache.has(id)) return themeCache.get(id);
  const dir = templateDir(id);
  if (!dir) {
    if (id !== DEFAULT_TEMPLATE) return loadTheme(DEFAULT_TEMPLATE);
    throw new Error(`默认主题 ${DEFAULT_TEMPLATE} 不存在`);
  }
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
function loadThemeLayouts(id = DEFAULT_TEMPLATE) {
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

function loadProfile(id = DEFAULT_TEMPLATE) {
  const dir = templateDir(id);
  return dir ? loadTemplateProfile(dir) : null;
}

module.exports = { loadDescriptor, listDescriptors, clearCache, loadTheme, loadThemeLayouts, loadProfile, DEFAULT_TEMPLATE, PRESET_DIR, USER_DIR };

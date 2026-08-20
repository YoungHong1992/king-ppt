// 阶段0 素材存储：<KING_PPT_HOME>/materials/<原文件名>
// 与 assets.js 不同——素材要保留原文件名与扩展名，供 Agent 用自己的文件工具按类型读取
// （pdf/docx/md/txt/图片…）。浏览器拖拽上传走此模块；放进项目目录的素材由 Agent 直读，不经这里。
const fs = require('fs');
const path = require('path');
const { MATERIALS_DIR } = require('./paths');

function ensureDir() {
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
}

// 文件名白名单清洗：取 basename、只留 字母/数字/中文/点/短横/下划线/空格，其余替换为 _
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-一-龥 ]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : 'material';
}

// 重名不覆盖：foo.pdf → foo_1.pdf → foo_2.pdf …
function uniquePath(name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 0;
  while (fs.existsSync(path.join(MATERIALS_DIR, candidate))) {
    candidate = `${stem}_${++n}${ext}`;
  }
  return candidate;
}

// 写入 base64 素材，返回 { name, path, bytes }。path 为绝对路径，供 Agent 直读。
function saveMaterial(name, base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (buf.length === 0) throw new Error('素材数据为空');
  ensureDir();
  const finalName = uniquePath(safeName(name));
  const full = path.join(MATERIALS_DIR, finalName);
  if (!full.startsWith(MATERIALS_DIR)) throw new Error('非法的素材路径'); // 目录穿越防护
  fs.writeFileSync(full, buf);
  return { name: finalName, path: full, bytes: buf.length };
}

// 读取已上传的文本类素材内容，拼成一段供 LLM 参考（server-gen 模式用）。
// 只读文本类扩展名（md/txt/csv/json 等）；二进制（pdf/docx/图片）暂不解析，仅列名。
// 返回 { text, used:[names], skipped:[names] }；总量截断到 maxChars 防 prompt 过长。
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.log', '.rtf']);
function readMaterialsText(maxChars = 12000) {
  let names = [];
  try { names = fs.readdirSync(MATERIALS_DIR); } catch { return { text: '', used: [], skipped: [] }; }
  const used = [];
  const skipped = [];
  const chunks = [];
  let total = 0;
  for (const name of names.sort()) {
    const full = path.join(MATERIALS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (!TEXT_EXT.has(path.extname(name).toLowerCase())) { skipped.push(name); continue; }
    if (total >= maxChars) { skipped.push(name); continue; }
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { skipped.push(name); continue; }
    const slice = content.slice(0, maxChars - total);
    total += slice.length;
    chunks.push(`【素材：${name}】\n${slice}`);
    used.push(name);
  }
  return { text: chunks.join('\n\n'), used, skipped };
}

module.exports = { MATERIALS_DIR, saveMaterial, safeName, readMaterialsText };

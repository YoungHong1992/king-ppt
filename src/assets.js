// 生成配图的本地存储：~/.king-ppt/assets/<文件名>
// 幻灯片 JSON 里 slide.image = { file, path, url }；path 供 pptx 导出（绝对路径），
// url 供前端预览（/api/assets/<file>）。文件名用内容哈希，同提示词重生成自然去重。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ASSETS_DIR } = require('./paths');
const NAME_RE = /^img_[a-f0-9]{16}\.(png|jpe?g|webp)$/;

function ensureDir() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// 写入 base64 图片，返回 slide.image 载荷
function saveImageBase64(b64, ext = 'png') {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('图片数据为空');
  const file = `img_${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  ensureDir();
  fs.writeFileSync(path.join(ASSETS_DIR, file), buf);
  return { file, path: path.join(ASSETS_DIR, file), url: `/api/assets/${file}` };
}

// 写入二进制图片（同上）
function saveImageBuffer(buf, ext = 'png') {
  return saveImageBase64(buf.toString('base64'), ext);
}

// 从 URL 下载到本地（图像生成接口返回 url 时）；失败抛错由调用方兜底
async function saveImageFromUrl(url, fetchImpl = fetch) {
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`图片下载失败 (${resp.status})`);
  const ct = String(resp.headers.get('content-type') || '');
  const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg'
    : ct.includes('webp') ? 'webp' : 'png';
  const buf = Buffer.from(await resp.arrayBuffer());
  return saveImageBuffer(buf, ext);
}

function resolveAsset(file) {
  if (!NAME_RE.test(file)) {
    const err = new Error('非法的资源文件名');
    err.code = 'BAD_ASSET_NAME';
    throw err;
  }
  const full = path.join(ASSETS_DIR, file);
  if (!full.startsWith(ASSETS_DIR) || !fs.existsSync(full)) {
    const err = new Error('资源不存在');
    err.code = 'ASSET_NOT_FOUND';
    throw err;
  }
  return full;
}

module.exports = { ASSETS_DIR, saveImageBase64, saveImageBuffer, saveImageFromUrl, resolveAsset };

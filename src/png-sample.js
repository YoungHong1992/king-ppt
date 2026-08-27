// 烘焙期页面底色指纹的像素采样器。零新增依赖：PNG 解码只覆盖 Chrome 截图
// 的固定输出子集（8-bit、非隔行、truecolor±alpha），解压用 Node 内建 zlib。
//
// 为什么需要真实像素：选择样板页的几何信号都会说谎——透明 padding 大图的
// bbox 能冒充满幅插画骗过章节检测，图标素材表的小文本又多到逃过稀疏阈值。
// 渲染出来的颜色不会骗人：底色指是"这页长什么样"的最强信号。

const zlib = require('zlib');

// 解码为 {w,h,ch,data}（逐像素 RGBA/RGB）。不支持的格式直接抛错，由调用方退回几何规则。
function decode(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a png');
  let off = 8;
  const idat = [];
  let w = 0, h = 0, ch = 0, bitDepth = 0, interlace = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; ch = { 2: 3, 6: 4 }[data[9]]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || !ch || bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported png: ${JSON.stringify({ w, h, bitDepth, ch, interlace })}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[p++];
      const a = x >= ch ? out[row + x - ch] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= ch && y > 0 ? out[row - stride + x - ch] : 0;
      let v;
      if (filter === 0) v = rb;
      else if (filter === 1) v = rb + a;
      else if (filter === 2) v = rb + b;
      else if (filter === 3) v = rb + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[row + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const pxAt = (img, x, y) => {
  const i = (y * img.w + x) * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};


// 矩形四边向内缩 inset 像素的"环带"平均色——代表页面的背景/镶边，而不是中央内容。
function ringColor(img, { x, y, w, h }, inset = 10) {
  let r = 0, g = 0, bl = 0, n = 0;
  const eat = (px, py) => {
    const cx = Math.min(img.w - 1, Math.max(0, px));
    const cy = Math.min(img.h - 1, Math.max(0, py));
    const [pr, pg, pb] = pxAt(img, cx, cy);
    r += pr; g += pg; bl += pb; n++;
  };
  const L = x + inset, R = x + w - 1 - inset, T = y + inset, B = y + h - 1 - inset;
  const stepX = Math.max(1, Math.floor(w / 64)), stepY = Math.max(1, Math.floor(h / 40));
  for (let px = x + inset; px <= R; px += stepX) { eat(px, T); eat(px, B); }
  for (let py = y + inset; py <= B; py += stepY) { eat(L, py); eat(R, py); }
  if (!n) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
}

// 把一张按网格平铺的整图切成格子，返回每格的环带平均色 [r,g,b]
function sampleCells(pngBuf, cols, rows) {
  const img = decode(pngBuf);
  const cw = Math.floor(img.w / cols), chh = Math.floor(img.h / rows);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(ringColor(img, { x: c * cw, y: r * chh, w: cw, h: chh }, Math.round(Math.min(cw, chh) * 0.06)));
    }
  }
  return cells;
}

const dist = (a, b) => (!a || !b ? Infinity : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));

module.exports = { decode, pxAt, ringColor, sampleCells, dist };

// SVG（free 自由排版页载荷）→ Resolved Scene Graph
// 学 PPT Master 的思路：LLM 画 SVG，确定性转换器编译为原生 pptx 对象。
// 支持 rect/circle/ellipse/line/text/polygon(近似)/g(translate)；
// 不支持的元素（滤镜/渐变/图片）在生成端已被 prompt 禁止，这里忽略即可。
const { XMLParser } = require('fast-xml-parser');
const { normalize } = require('../public/svg-frame.js');
const { textWidthIn } = require('./validate');

const DEFAULT_VB = { w: 1280, h: 720 };

const num = (v, d = 0) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

// "#1F4E79" / "1F4E79" / "rgb(...)" → "1F4E79"（pptxgenjs 色值）；无效返回 null
function color6(v) {
  if (!v || v === 'none' || v === 'transparent') return null;
  const s = String(v).trim();
  let hex = s.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (m) {
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return { color: (r + g + b).toUpperCase(), opacity: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return null;
}

function attrsOf(node) {
  return (node && node[':@']) || {};
}

const SHAPE_TAGS = ['g', 'rect', 'circle', 'ellipse', 'line', 'text', 'polygon', 'polyline'];

// preserveOrder 树的层间结构：父节点 = { <tag>: [子节点...], ':@': {属性} }。
// 递归收集某层指定标签的元素；<g> 只支持 translate，叠加到子元素坐标上
function flatten(children, tag, tx, ty, out) {
  for (const child of children) {
    if (!(tag in child)) continue;
    if (tag === 'g') {
      const a = attrsOf(child);
      const tr = String(a['@_transform'] || '');
      const m = tr.match(/translate\s*\(\s*([-\d.]+)\s*[ ,]\s*([-\d.]+)/i) || tr.match(/translate\s*\(\s*([-\d.]+)/i);
      const gx = tx + (m ? Number(m[1]) : 0);
      const gy = ty + (m ? Number(m[2] || 0) : 0);
      const gc = child['g'] || [];
      for (const t of SHAPE_TAGS) flatten(gc, t, gx, gy, out);
    } else {
      // preserveOrder 下元素形如 { <tag>: [ { '#text': '内容' }, ... ], ':@': {属性} }
      const inner = child[tag] || [];
      out.push({
        tag,
        attrs: attrsOf(child),
        text: inner.filter((n) => n['#text'] !== undefined).map((n) => n['#text']).join(''),
        tx, ty,
      });
    }
  }
}

// polygon/polyline → 就近预设形状（3 点=三角，4 点对角线互相平分=菱形），其余退化到外接矩形
function polygonShape(points) {
  const pts = String(points || '').trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  if (pts.length < 6) return 'rect';
  const n = pts.length / 2;
  if (n === 3) return 'triangle';
  if (n === 4) {
    // 对角线中点重合 → 菱形（含正方形/矩形旋转 45° 的常见装饰形态）
    const isDiamond = pts[0] + pts[4] === pts[2] + pts[6] && pts[1] + pts[5] === pts[3] + pts[7];
    return isDiamond ? 'diamond' : 'rect';
  }
  return 'rect';
}

// text 元素 → 场景 text 对象：SVG 的 x/y 是基线锚点，转成包围盒 + 对齐
function textObject(el, k) {
  const a = el.attrs;
  const fsPx = num(a['@_font-size'], 20);
  const fontSize = Math.max(6, fsPx * k * 72);
  const anchor = String(a['@_text-anchor'] || 'start');
  let text = el.text.trim();
  if (!text) return null;
  const wIn = Math.min(textWidthIn(text, fontSize) + 0.1, 1e6);
  const hIn = (fontSize * 1.35) / 72;
  const xIn = (el.tx + num(a['@_x'])) * k;
  const yIn = (el.ty + num(a['@_y'])) * k;
  const boxX = anchor === 'middle' ? xIn - wIn / 2 : anchor === 'end' ? xIn - wIn : xIn;
  const boxY = yIn - (fsPx * 0.82) * k; // 基线 → 盒顶（近似 ascent 0.82em）
  const fill = color6(a['@_fill'] || a['@_color']);
  const c = fill && typeof fill === 'object' ? fill.color : fill;
  const op = fill && typeof fill === 'object' && fill.opacity !== undefined ? fill.opacity : num(a['@_fill-opacity'], 1);
  return {
    kind: 'text',
    x: boxX, y: boxY, w: wIn, h: hIn,
    text,
    fontSize: Math.round(fontSize * 10) / 10,
    bold: String(a['@_font-weight'] || '').match(/bold|[6-9]00/i) !== null,
    color: c || '333333',
    align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
    valign: 'middle',
    ...(op < 1 ? { transparency: Math.round((1 - op) * 100) } : {}),
  };
}

// SVG 字符串 → 场景图（背景白；形状/文本对象，坐标英寸）
function svgToScene(svgString, canvas) {
  const normalized = normalize(svgString);
  if (!normalized) throw new Error('SVG 格式不正确');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: true,
  });
  const tree = parser.parse(normalized);
  const root = tree.find((n) => n.svg);
  if (!root) throw new Error('SVG 缺少根元素');

  const ra = attrsOf(root);
  const vb = String(ra['@_viewBox'] || '').trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : DEFAULT_VB.w;
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : DEFAULT_VB.h;
  const k = canvas.width / vbW; // px → inch（预览与导出等比）

  const els = [];
  const rootChildren = root['svg'] || [];
  for (const t of SHAPE_TAGS) flatten(rootChildren, t, 0, 0, els);

  const objects = [];
  for (const el of els) {
    const a = el.attrs;
    const stroke = color6(a['@_stroke']);
    const strokeWidth = num(a['@_stroke-width'], 0) * k;
    const line = stroke && strokeWidth > 0
      ? { color: stroke && typeof stroke === 'object' ? stroke.color : stroke, width: strokeWidth * 72 }
      : undefined;
    const fillRaw = color6(a['@_fill']);
    const fill = fillRaw === null ? undefined : typeof fillRaw === 'object' ? fillRaw.color : fillRaw;
    const fillOp = fillRaw && typeof fillRaw === 'object' && fillRaw.opacity !== undefined
      ? fillRaw.opacity : num(a['@_fill-opacity'], 1);
    // SVG 默认 fill 黑色：未写 fill 的装饰色块按黑色处理
    const effFill = a['@_fill'] === undefined && el.tag !== 'line' && el.tag !== 'text' ? '000000' : fill;
    const base = {
      ...(effFill ? { fill: effFill } : {}),
      ...(fillOp < 1 ? { transparency: Math.round((1 - fillOp) * 100) } : {}),
      ...(line ? { line } : {}),
    };

    if (el.tag === 'rect') {
      const rx = num(a['@_rx'], 0);
      objects.push({
        kind: 'shape', shape: rx > 0 ? 'roundRect' : 'rect',
        x: (el.tx + num(a['@_x'])) * k, y: (el.ty + num(a['@_y'])) * k,
        w: num(a['@_width']) * k, h: num(a['@_height']) * k,
        ...(rx > 0 ? { rectRadius: rx * k } : {}),
        ...base,
      });
    } else if (el.tag === 'circle') {
      const r = num(a['@_r']) * k;
      objects.push({
        kind: 'shape', shape: 'ellipse',
        x: (el.tx + num(a['@_cx'])) * k - r, y: (el.ty + num(a['@_cy'])) * k - r,
        w: r * 2, h: r * 2, ...base,
      });
    } else if (el.tag === 'ellipse') {
      const rx = num(a['@_rx']) * k;
      const ry = num(a['@_ry']) * k;
      objects.push({
        kind: 'shape', shape: 'ellipse',
        x: (el.tx + num(a['@_cx'])) * k - rx, y: (el.ty + num(a['@_cy'])) * k - ry,
        w: rx * 2, h: ry * 2, ...base,
      });
    } else if (el.tag === 'line') {
      const x1 = el.tx + num(a['@_x1']);
      const y1 = el.ty + num(a['@_y1']);
      const x2 = el.tx + num(a['@_x2']);
      const y2 = el.ty + num(a['@_y2']);
      objects.push({
        kind: 'shape', shape: 'line',
        x: Math.min(x1, x2) * k, y: Math.min(y1, y2) * k,
        w: Math.abs(x2 - x1) * k, h: Math.abs(y2 - y1) * k,
        line: {
          color: (stroke && (typeof stroke === 'object' && stroke !== null ? stroke.color : stroke)) || '333333',
          width: Math.max(0.5, (strokeWidth || 2 / vbW * canvas.width) * 72),
        },
        ...(x2 < x1 ? { flipH: true } : {}),
        ...(y2 < y1 ? { flipV: true } : {}),
      });
    } else if (el.tag === 'polygon' || el.tag === 'polyline') {
      const pts = String(a['@_points'] || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (pts.length >= 4) {
        const xs = pts.filter((_, i) => i % 2 === 0);
        const ys = pts.filter((_, i) => i % 2 === 1);
        objects.push({
          kind: 'shape', shape: polygonShape(a['@_points']),
          x: (el.tx + Math.min(...xs)) * k, y: (el.ty + Math.min(...ys)) * k,
          w: (Math.max(...xs) - Math.min(...xs)) * k,
          h: (Math.max(...ys) - Math.min(...ys)) * k,
          ...base,
        });
      }
    } else if (el.tag === 'text') {
      const obj = textObject(el, k);
      if (obj) objects.push(obj);
    }
  }

  return { background: { color: 'FFFFFF' }, objects };
}

module.exports = { svgToScene };

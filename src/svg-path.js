// SVG <path d="..."> → 绝对坐标的 pptxgenjs 路径算子（供 svg-to-pptx 编译 custGeom）。
// 支持 M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z；圆弧 A 转成三次贝塞尔逼近（保证预览==导出）。
// 输出算子为「SVG 用户坐标系的绝对值」，由调用方算包围盒后再相对化 + 换算英寸。

// 把 d 拆成 { cmd, nums[] } 序列
function tokenizePath(d) {
  const tokens = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m;
  while ((m = re.exec(String(d || ''))) !== null) {
    const nums = (m[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
    tokens.push({ cmd: m[1], nums });
  }
  return tokens;
}

// SVG 椭圆弧 → 三次贝塞尔段（endpoint 参数化 → center 参数化，见 SVG 规范 F.6）
function arcToBeziers(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [{ x1, y1, x2, y2, x: x2, y: y2 }]; // 退化为直线（用重合控制点）
  rx = Math.abs(rx); ry = Math.abs(ry);
  const rad = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  let rxs = rx * rx, rys = ry * ry;
  const x1ps = x1p * x1p, y1ps = y1p * y1p;
  const lam = x1ps / rxs + y1ps / rys;
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry; }
  const sign = laf !== sf ? 1 : -1;
  let num = rxs * rys - rxs * y1ps - rys * x1ps;
  num = num < 0 ? 0 : num;
  const co = sign * Math.sqrt(num / (rxs * y1ps + rys * x1ps));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dtheta = ang(ux, uy, vx, vy);
  if (!sf && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sf && dtheta < 0) dtheta += 2 * Math.PI;
  const nSeg = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / nSeg;
  const t = (8 / 3) * Math.sin(delta / 4) * Math.sin(delta / 4) / Math.sin(delta / 2);
  const segs = [];
  let th = theta1;
  const map = (px, py) => ({ x: cos * rx * px - sin * ry * py + cx, y: sin * rx * px + cos * ry * py + cy });
  for (let i = 0; i < nSeg; i++) {
    const cosT1 = Math.cos(th), sinT1 = Math.sin(th);
    const th2 = th + delta;
    const cosT2 = Math.cos(th2), sinT2 = Math.sin(th2);
    const cp1 = map(cosT1 - t * sinT1, sinT1 + t * cosT1);
    const cp2 = map(cosT2 + t * sinT2, sinT2 - t * cosT2);
    const end = map(cosT2, sinT2);
    segs.push({ x1: cp1.x, y1: cp1.y, x2: cp2.x, y2: cp2.y, x: end.x, y: end.y });
    th = th2;
  }
  return segs;
}

// d → 绝对坐标算子数组：{x,y,moveTo?} | {x,y,curve:{type:'cubic',x1,y1,x2,y2}} | {x,y,curve:{type:'quadratic',x1,y1}} | {close:true}
function pathToAbsOps(d) {
  const toks = tokenizePath(d);
  const ops = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCubic = null; // 上一段三次控制点（S 反射用）
  let lastQuad = null;  // 上一段二次控制点（T 反射用）

  for (const { cmd, nums } of toks) {
    const rel = cmd >= 'a'; // 小写 = 相对
    const C = cmd.toUpperCase();

    if (C === 'Z') {
      ops.push({ close: true });
      cx = sx; cy = sy; lastCubic = lastQuad = null;
      continue;
    }
    // 每类命令的步长：一次消费多组参数（如 "L x y x y" = 两条线）
    const step = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[C];
    if (!step) continue;
    for (let i = 0; i + step <= nums.length; i += step) {
      const n = nums.slice(i, i + step);
      if (C === 'M') {
        cx = rel ? cx + n[0] : n[0];
        cy = rel ? cy + n[1] : n[1];
        // 一个 M 后的后续坐标对视为 L；首对是 moveTo 并设子路径起点
        if (i === 0) { sx = cx; sy = cy; ops.push({ x: cx, y: cy, moveTo: true }); }
        else ops.push({ x: cx, y: cy });
        lastCubic = lastQuad = null;
      } else if (C === 'L') {
        cx = rel ? cx + n[0] : n[0];
        cy = rel ? cy + n[1] : n[1];
        ops.push({ x: cx, y: cy });
        lastCubic = lastQuad = null;
      } else if (C === 'H') {
        cx = rel ? cx + n[0] : n[0];
        ops.push({ x: cx, y: cy });
        lastCubic = lastQuad = null;
      } else if (C === 'V') {
        cy = rel ? cy + n[0] : n[0];
        ops.push({ x: cx, y: cy });
        lastCubic = lastQuad = null;
      } else if (C === 'C') {
        const x1 = rel ? cx + n[0] : n[0], y1 = rel ? cy + n[1] : n[1];
        const x2 = rel ? cx + n[2] : n[2], y2 = rel ? cy + n[3] : n[3];
        const x = rel ? cx + n[4] : n[4], y = rel ? cy + n[5] : n[5];
        ops.push({ x, y, curve: { type: 'cubic', x1, y1, x2, y2 } });
        lastCubic = { x: x2, y: y2 }; lastQuad = null; cx = x; cy = y;
      } else if (C === 'S') {
        const rx = lastCubic ? 2 * cx - lastCubic.x : cx;
        const ry = lastCubic ? 2 * cy - lastCubic.y : cy;
        const x2 = rel ? cx + n[0] : n[0], y2 = rel ? cy + n[1] : n[1];
        const x = rel ? cx + n[2] : n[2], y = rel ? cy + n[3] : n[3];
        ops.push({ x, y, curve: { type: 'cubic', x1: rx, y1: ry, x2, y2 } });
        lastCubic = { x: x2, y: y2 }; lastQuad = null; cx = x; cy = y;
      } else if (C === 'Q') {
        const x1 = rel ? cx + n[0] : n[0], y1 = rel ? cy + n[1] : n[1];
        const x = rel ? cx + n[2] : n[2], y = rel ? cy + n[3] : n[3];
        ops.push({ x, y, curve: { type: 'quadratic', x1, y1 } });
        lastQuad = { x: x1, y: y1 }; lastCubic = null; cx = x; cy = y;
      } else if (C === 'T') {
        const x1 = lastQuad ? 2 * cx - lastQuad.x : cx;
        const y1 = lastQuad ? 2 * cy - lastQuad.y : cy;
        const x = rel ? cx + n[0] : n[0], y = rel ? cy + n[1] : n[1];
        ops.push({ x, y, curve: { type: 'quadratic', x1, y1 } });
        lastQuad = { x: x1, y: y1 }; lastCubic = null; cx = x; cy = y;
      } else if (C === 'A') {
        const x = rel ? cx + n[5] : n[5], y = rel ? cy + n[6] : n[6];
        const beziers = arcToBeziers(cx, cy, n[0], n[1], n[2], n[3] ? 1 : 0, n[4] ? 1 : 0, x, y);
        for (const b of beziers) ops.push({ x: b.x, y: b.y, curve: { type: 'cubic', x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 } });
        lastCubic = lastQuad = null; cx = x; cy = y;
      }
    }
  }
  return ops;
}

// 收集算子里所有锚点 + 控制点，供包围盒计算（贝塞尔曲线在其控制点凸包内，故此为安全外包围盒）
function opsBounds(ops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const seen = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const op of ops) {
    if (op.close) continue;
    seen(op.x, op.y);
    if (op.curve) {
      seen(op.curve.x1, op.curve.y1);
      if (op.curve.x2 !== undefined) seen(op.curve.x2, op.curve.y2);
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

module.exports = { tokenizePath, pathToAbsOps, arcToBeziers, opsBounds };

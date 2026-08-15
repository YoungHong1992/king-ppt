// ================= Scene Graph → DOM 画家 =================
// 与 src/pptx-painter.js 平行的「画家」：不做任何设计决策，只把
// Layout Resolver 输出的 Resolved Scene Graph 画进 DOM。
// 坐标单位英寸，画布由 opts.canvas 提供（16:9）；容器需为相对定位的 16:9 盒子，
// 且开启 container-type: size（见 style.css 的 .slide），字号等用 cqh 随容器缩放。
window.DomPainter = (() => {
  const DEFAULT_CANVAS = { width: 13.33, height: 7.5 };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // "RRGGBB" + transparency(0-100) → rgba()；transparency 缺省/0 时用 #  hex
  function cssColor(hex, transparency) {
    if (!hex) return null;
    const h = String(hex).replace('#', '');
    if (transparency === undefined || transparency === null || transparency <= 0) return `#${h}`;
    const a = Math.max(0, Math.min(1, 1 - transparency / 100));
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // 场景里的 image.src 是服务器本地绝对路径，浏览器无法直接加载：
  // 取 assets/ 之后的文件名，改走模板素材路由
  function imgUrl(src, templateId) {
    const m = String(src || '').split(/[/\\]assets[/\\]/);
    if (m.length < 2 || !templateId) return null;
    const file = m[1].split(/[/\\]/).pop();
    return `/api/templates/${encodeURIComponent(templateId)}/assets/${encodeURIComponent(file)}`;
  }

  function paint(scene, container, opts = {}) {
    const canvas = opts.canvas || DEFAULT_CANVAS;
    const templateId = opts.templateId;
    const onEdit = typeof opts.onEdit === 'function' ? opts.onEdit : null;
    const W = canvas.width;
    const H = canvas.height;
    // 单位换算：英寸 → 容器百分比；pt → cqh（1in = 72pt，容器高 = H 英寸）
    const xPct = (v) => `${(v / W) * 100}%`;
    const yPct = (v) => `${(v / H) * 100}%`;
    const ptCqh = (pt) => `${((pt / 72) / H) * 100}cqh`;
    const inCqh = (inch) => `${(inch / H) * 100}cqh`;
    const box = (o) => `left:${xPct(o.x)};top:${yPct(o.y)};width:${xPct(o.w)};height:${yPct(o.h)};`;
    // 可编辑元素：data-obj 定位到场景对象，bullets/table 再用 data-item/data-cell 定位条目
    const editAttr = (i) => (onEdit ? ` data-obj="${i}"` : '');

    container.classList.add('dp-scene');
    const bg = scene.background && scene.background.color;
    container.style.background = bg ? cssColor(bg) : '';

    container.innerHTML = (scene.objects || []).map((o, i) => {
      if (o.kind === 'text') {
        const justify = { left: 'flex-start', center: 'center', right: 'flex-end' }[o.align] || 'flex-start';
        const alignItems = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[o.valign] || 'flex-start';
        const style = box(o)
          + `font-size:${ptCqh(o.fontSize || 14)};`
          + `color:${cssColor(o.color) || 'inherit'};`
          + `justify-content:${justify};align-items:${alignItems};text-align:${o.align || 'left'};`
          + (o.bold ? 'font-weight:700;' : '')
          + (o.fontFace ? `font-family:'${esc(o.fontFace)}','Microsoft YaHei',sans-serif;` : '')
          + (o.charSpacing ? `letter-spacing:${ptCqh(o.charSpacing)};` : '');
        const editable = onEdit && o._edit;
        return `<div class="dp-text${editable ? ' dp-editable' : ''}" style="${style}"${editAttr(i)}>`
          + `<span ${editable ? 'contenteditable="true" spellcheck="false"' : ''}>${esc(o.text)}</span></div>`;
      }

      if (o.kind === 'shape') {
        const fill = cssColor(o.fill || o.color, o.transparency);
        let style = box(o);
        let extra = '';
        if (o.shape === 'line') {
          // 线条：宽度退化为线粗（pt → cqh 的细背景条）
          const pt = (o.line && o.line.width) || 1;
          style += `height:${ptCqh(pt)};background:${cssColor((o.line && o.line.color) || o.color || o.fill) || '#000'};`;
        } else {
          if (fill) style += `background:${fill};`;
          if (o.line && o.line.color) {
            style += `border:${ptCqh(o.line.width || 1)} solid ${cssColor(o.line.color)};`;
          }
          if (o.shape === 'roundRect') {
            style += `border-radius:${inCqh(o.rectRadius || 0.12)};`;
          } else if (o.shape === 'ellipse') {
            style += 'border-radius:50%;';
          } else if (o.shape === 'parallelogram') {
            // 平行四边形近似：左右斜边各内收 15%
            extra = 'clip-path:polygon(15% 0, 100% 0, 85% 100%, 0 100%);';
          }
        }
        return `<div class="dp-shape" style="${style}${extra}"></div>`;
      }

      if (o.kind === 'bullets') {
        const style = box(o)
          + `font-size:${ptCqh(o.fontSize || 14)};color:${cssColor(o.color) || 'inherit'};`
          + (o.fontFace ? `font-family:'${esc(o.fontFace)}','Microsoft YaHei',sans-serif;` : '');
        const gap = o.paraSpaceAfter ? `margin-bottom:${ptCqh(o.paraSpaceAfter)};` : '';
        const bc = cssColor(o.bulletColor) || 'currentColor';
        const editable = onEdit && o._edit;
        const items = (o.items || []).map((t, j) =>
          `<div class="dp-bullet" style="${gap}"><span class="dp-bullet-mark" style="color:${bc}">▪</span>`
          + `<span class="dp-bullet-text${editable ? ' dp-editable' : ''}"${editable ? ` data-obj="${i}" data-item="${j}" contenteditable="true" spellcheck="false"` : ''}>${esc(t)}</span></div>`
        ).join('');
        return `<div class="dp-bullets" style="${style}">${items}</div>`;
      }

      if (o.kind === 'table') {
        const hd = o.header || {};
        const cell = o.cell || {};
        const border = o.border || {};
        const bd = `border:${ptCqh(border.pt || 1)} solid ${cssColor(border.color) || '#d9e2ec'};`;
        const style = box(o) + (o.fontFace ? `font-family:'${esc(o.fontFace)}','Microsoft YaHei',sans-serif;` : '');
        const editable = onEdit && o._edit;
        const ec = (r, c) => (editable ? ` data-obj="${i}" data-cell="${r}.${c}" contenteditable="true" spellcheck="false"` : '');
        const ths = (o.headers || []).map((h, c) =>
          `<th style="background:${cssColor(hd.fill) || '#333'};color:${cssColor(hd.color) || '#fff'};`
          + `font-size:${ptCqh(hd.fontSize || 13)};${hd.bold ? 'font-weight:700;' : ''}`
          + `text-align:${hd.align || 'center'};height:${yPct(o.rowH || 0.4)};${bd}"${ec(0, c)}>${esc(h)}</th>`
        ).join('');
        const trs = (o.rows || []).map((r, ri) => {
          const bgc = ri % 2 === 0 ? cssColor(cell.plain) : cssColor(cell.zebra);
          const tds = (Array.isArray(r) ? r : [r]).map((c, ci) =>
            `<td style="color:${cssColor(cell.color) || 'inherit'};font-size:${ptCqh(cell.fontSize || 12)};`
            + `height:${yPct(o.rowH || 0.4)};${bgc ? `background:${bgc};` : ''}${bd}"${ec(ri + 1, ci)}>${esc(c)}</td>`
          ).join('');
          return `<tr>${tds}</tr>`;
        }).join('');
        return `<div class="dp-table-wrap" style="${style}"><table class="dp-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
      }

      if (o.kind === 'image') {
        // 生成配图带可直接访问的 url；模板素材走 assets 路由
        const url = o.url || imgUrl(o.src, templateId);
        if (!url) {
          // staging 场景（上传确认面板）的 src 指向服务器临时目录，前端不可达，色块占位
          return `<div class="dp-shape dp-image-stub" style="${box(o)}"></div>`;
        }
        return `<img class="dp-image" style="${box(o)}" src="${esc(url)}" alt="" />`;
      }

      return '';
    }).join('');

    if (onEdit) wireEditable(container, scene, onEdit);
  }

  // 就地编辑提交：blur/Enter 时把 DOM 文本写回 slide 字段（经 app.js 的 onEdit 回调）
  function wireEditable(container, scene, onEdit) {
    const editableEls = container.querySelectorAll('[contenteditable]');
    if (editableEls.length === 0) return;
    for (const el of editableEls) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          el.blur();
        }
      });
      el.addEventListener('blur', () => {
        const o = scene.objects[Number(el.dataset.obj)];
        if (!o || !o._edit) return;
        if (o.kind === 'text') {
          let v = el.textContent.replace(/\s+/g, ' ').trim();
          const p = o._edit.prefix;
          if (p && v.startsWith(p)) v = v.slice(p.length).trim();
          if (v !== o.text) onEdit(o._edit, v);
        } else if (o.kind === 'bullets') {
          const items = [...container.querySelectorAll(`[data-obj="${el.dataset.obj}"].dp-bullet-text`)]
            .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
            .filter((t) => t !== '');
          onEdit(o._edit, items);
        } else if (o.kind === 'table') {
          const cells = [...container.querySelectorAll(`[data-obj="${el.dataset.obj}"][data-cell]`)];
          const headers = cells.filter((n) => n.dataset.cell.startsWith('0.'))
            .sort((a, b) => Number(a.dataset.cell.split('.')[1]) - Number(b.dataset.cell.split('.')[1]))
            .map((n) => n.textContent.trim());
          const maxRow = cells.reduce((m, n) => Math.max(m, Number(n.dataset.cell.split('.')[0])), 0);
          const rows = [];
          for (let r = 1; r <= maxRow; r++) {
            rows.push(cells.filter((n) => n.dataset.cell.startsWith(`${r}.`))
              .sort((a, b) => Number(a.dataset.cell.split('.')[1]) - Number(b.dataset.cell.split('.')[1]))
              .map((n) => n.textContent.trim()));
          }
          onEdit(o._edit, { headers, rows });
        }
      });
    }
  }

  // 独立创建一块 .slide 画布并画入场景（画廊卡片、确认面板样例页用）
  function paintInto(scene, templateId, canvas) {
    const el = document.createElement('div');
    el.className = 'slide';
    paint(scene, el, { canvas, templateId });
    return el;
  }

  return { paint, paintInto };
})();

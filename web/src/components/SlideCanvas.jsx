import React, { useRef, useEffect, useState, useCallback } from 'react';

// 单页画布：把整页 SVG 内联为真实 DOM（矢量预览，随容器等比缩放）。
// 就地编辑：点任意 <text> 弹出一个覆盖其上的输入框(overlay)，回车/失焦把新文字写回该
// <text> 节点再序列化回传。刻意不给 SVG <text> 加 contenteditable——那在各浏览器里
// 极脆(误删/分裂/丢失)，正是「点几下字就没了」的根因。overlay 方案从机制上杜绝该类问题：
//  · 空值保护：绝不把「有内容的文字」改成空，避免文字消失；
//  · 用稳定下标(data-kp-i)重新定位节点，重渲染(SSE 回推)也不会写丢。
export default function SlideCanvas({ svg, index, editable, active, onSelect, onEdit }) {
  const rootRef = useRef(null);
  const hostRef = useRef(null);
  const [edit, setEdit] = useState(null); // { idx, left, top, width, height, fontSize, color, align, value }

  // 读回宿主里的 <svg> 外层 HTML；剥掉编辑期注入的属性，还原纯净 SVG
  const serialize = useCallback(() => {
    const host = hostRef.current;
    const el = host && host.querySelector('svg');
    if (!el) return null;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-kp-i]').forEach((n) => n.removeAttribute('data-kp-i'));
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.removeAttribute('preserveAspectRatio');
    clone.removeAttribute('style');
    let out = clone.outerHTML;
    if (!/xmlns=/.test(out)) out = out.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return out;
  }, []);

  const commitEdit = useCallback(() => {
    setEdit((e) => {
      if (!e) return null;
      const host = hostRef.current;
      const el = host && host.querySelector(`text[data-kp-i="${e.idx}"]`);
      const v = String(e.value == null ? '' : e.value).replace(/\s+$/,'').trim();
      // 空值保护：绝不把有内容的文字清空（那会让字"消失"）；有变化才写回
      if (el && v && el.textContent !== v) {
        el.textContent = v;
        const out = serialize();
        if (out && onEdit) onEdit(index, out);
      }
      return null;
    });
  }, [serialize, onEdit, index]);

  // 内联 SVG + 绑定点击（每次 svg / editable 变化重建）。编辑用 overlay，不动 SVG 本身。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.innerHTML = svg || '';
    const el = host.querySelector('svg');
    if (!el) { host.innerHTML = '<div class="canvas-fail">页面解析失败</div>'; return undefined; }
    el.setAttribute('width', '100%');
    el.setAttribute('height', '100%');
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    el.style.display = 'block';
    if (!editable) return undefined;

    const texts = Array.from(el.querySelectorAll('text'));
    const cleanups = [];
    texts.forEach((t, i) => {
      t.setAttribute('data-kp-i', String(i));
      t.style.cursor = 'text';
      const onClick = (ev) => {
        ev.stopPropagation();
        const rootRect = rootRef.current.getBoundingClientRect();
        const r = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        const anchor = t.getAttribute('text-anchor') || 'start';
        setEdit({
          idx: i,
          left: r.left - rootRect.left,
          top: r.top - rootRect.top,
          width: Math.max(r.width, 48),
          height: Math.max(r.height, 20),
          fontSize: Math.min(parseFloat(cs.fontSize) || 16, 30),
          color: t.getAttribute('fill') || cs.fill || '#111',
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
          value: t.textContent || '',
        });
      };
      t.addEventListener('click', onClick);
      cleanups.push(() => t.removeEventListener('click', onClick));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [svg, editable]);

  return (
    <div
      ref={rootRef}
      className={`slide-canvas${active ? ' active' : ''}`}
      onClick={() => onSelect && onSelect(index)}
    >
      <div className="slide-canvas-frame" ref={hostRef} />
      {edit ? (
        <textarea
          className="slide-edit-input"
          autoFocus
          value={edit.value}
          style={{
            left: `${edit.left}px`, top: `${edit.top}px`,
            width: `${edit.width + 12}px`, minHeight: `${edit.height + 6}px`,
            fontSize: `${edit.fontSize}px`, color: edit.color, textAlign: edit.align,
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEdit((p) => (p ? { ...p, value: e.target.value } : p))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEdit(null); }
          }}
          onBlur={commitEdit}
        />
      ) : null}
    </div>
  );
}

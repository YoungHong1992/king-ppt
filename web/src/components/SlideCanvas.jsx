import React, { useRef, useEffect, useCallback } from 'react';

// 单页画布：把整页 SVG 内联为真实 DOM 节点（矢量预览，随容器等比缩放）。
// 直接操作编辑：编辑态下点击任意 <text> 即可就地改字；失焦时把整棵 <svg> 重新序列化回传，
// 交由服务端 sanitize 后落权威 deck——这正是「预览 == 导出」消费的同一份 SVG。
export default function SlideCanvas({ svg, index, editable, active, onSelect, onEdit }) {
  const hostRef = useRef(null);
  const committingRef = useRef(false);

  // 读回宿主里的 <svg> 外层 HTML；剥掉编辑期注入的属性，还原纯净 SVG
  const serialize = useCallback(() => {
    const host = hostRef.current;
    const el = host && host.querySelector('svg');
    if (!el) return null;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach((n) => {
      n.removeAttribute('contenteditable');
      n.removeAttribute('data-kp-edit');
      n.style.removeProperty('outline');
      n.style.removeProperty('cursor');
      if (!n.getAttribute('style')) n.removeAttribute('style');
    });
    // 归一为标准 xmlns（内联时浏览器可能省略），并去掉预览注入的宽高
    let out = clone.outerHTML;
    if (!/xmlns=/.test(out)) out = out.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return out;
  }, []);

  const commit = useCallback(() => {
    if (committingRef.current) return;
    committingRef.current = true;
    const out = serialize();
    committingRef.current = false;
    if (out && onEdit) onEdit(index, out);
  }, [serialize, onEdit, index]);

  // 内联 SVG + 绑定编辑交互（每次 svg / editable 变化重建）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = svg || '';
    const el = host.querySelector('svg');
    if (!el) { host.innerHTML = '<div class="canvas-fail">页面解析失败</div>'; return; }
    // 撑满容器，等比居中
    el.setAttribute('width', '100%');
    el.setAttribute('height', '100%');
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    el.style.display = 'block';

    if (!editable) return undefined;
    const texts = Array.from(el.querySelectorAll('text'));
    const cleanups = [];
    for (const t of texts) {
      t.style.cursor = 'text';
      const onClick = (e) => {
        e.stopPropagation();
        t.setAttribute('contenteditable', 'true');
        t.setAttribute('data-kp-edit', '1');
        t.style.outline = '1.5px solid #6366f1';
        t.focus();
        // 选中全部文字，便于整体替换
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(t);
        sel.removeAllRanges();
        sel.addRange(range);
      };
      const onBlur = () => {
        t.removeAttribute('contenteditable');
        t.style.removeProperty('outline');
        commit();
      };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); t.blur(); }       // 单行提交（SVG 换行=多个 text）
        if (e.key === 'Escape') { e.preventDefault(); host.innerHTML = ''; host.innerHTML = svg; } // 放弃
      };
      t.addEventListener('click', onClick);
      t.addEventListener('blur', onBlur);
      t.addEventListener('keydown', onKey);
      cleanups.push(() => {
        t.removeEventListener('click', onClick);
        t.removeEventListener('blur', onBlur);
        t.removeEventListener('keydown', onKey);
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [svg, editable, commit]);

  return (
    <div
      className={`slide-canvas${active ? ' active' : ''}`}
      onClick={() => onSelect && onSelect(index)}
    >
      <div className="slide-canvas-frame" ref={hostRef} />
    </div>
  );
}

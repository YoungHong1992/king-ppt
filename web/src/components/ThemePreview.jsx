import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import SlideCanvas from './SlideCanvas.jsx';

const ROLE_LABEL = { cover: '封面', section: '章节', content: '内容', closing: '结束' };

// 模板预览弹层：拉取该主题的创作规格，用只读画布渲染 4 张角色原型页（封面/章节/内容/结束），
// 让用户在「用此模板生成」前直观看到这套主题画出来的样子。确认即按此模板 + 定稿大纲逐页生成。
export default function ThemePreview({ theme, busy, onClose, onConfirm }) {
  const [spec, setSpec] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!theme) return;
    setSpec(null); setErr('');
    api.themeSpec(theme.id).then(setSpec).catch((e) => setErr(e.message));
  }, [theme]);

  if (!theme) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="theme-preview" onClick={(e) => e.stopPropagation()}>
        <div className="theme-preview-head">
          <div className="theme-preview-title">{theme.name || theme.id}</div>
          <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
        </div>
        {err ? (
          <div className="theme-preview-msg err">预览加载失败：{err}</div>
        ) : !spec ? (
          <div className="theme-preview-msg">正在加载预览…</div>
        ) : (
          <div className="theme-preview-grid">
            {(spec.layouts || []).map((l) => (
              <figure className="theme-preview-cell" key={l.role}>
                <div className="theme-preview-canvas">
                  <SlideCanvas svg={l.svg} index={0} editable={false} active={false} onSelect={() => {}} />
                </div>
                <figcaption>{ROLE_LABEL[l.role] || l.role}</figcaption>
              </figure>
            ))}
          </div>
        )}
        <div className="theme-preview-foot">
          <button className="btn" onClick={onClose} disabled={busy}>换一个</button>
          <button className="btn btn-primary" onClick={() => onConfirm(theme.id)} disabled={busy || !spec}>
            用此模板生成
          </button>
        </div>
      </div>
    </div>
  );
}

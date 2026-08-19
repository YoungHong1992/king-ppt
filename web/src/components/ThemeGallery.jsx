import React from 'react';

// 主题画廊：列出可选主题风格（theme.json 驱动，P3 完善原型缩略）。选中即发 theme-pick 动作，
// 服务端落权威 deck 并广播；Agent 长轮询得知后可按新主题令牌重画整册。
export default function ThemeGallery({ themes, activeId, onPick }) {
  return (
    <div className="theme-gallery">
      <div className="theme-gallery-label">主题风格</div>
      <div className="theme-list">
        {themes.map((t) => (
          <button
            key={t.id}
            className={`theme-card${t.id === activeId ? ' active' : ''}`}
            onClick={() => onPick(t.id)}
            title={t.name || t.id}
          >
            <span className="theme-swatch" style={swatchStyle(t)} />
            <span className="theme-name">{t.name || t.id}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// 用主题主色做一个简单色板预览（P3 换成 layouts/*.svg 原型缩略）
function swatchStyle(t) {
  const p = t.palette || {};
  const c = (k, d) => (p[k] ? `#${p[k]}` : d);
  return {
    background: `linear-gradient(135deg, ${c('primary', '#1F4E79')} 0%, ${c('accent', '#2E86C1')} 100%)`,
  };
}

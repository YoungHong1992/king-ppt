import React from 'react';

// 主题画廊（选模板步）：列出可选主题风格（theme.json 驱动）。点卡片 = 打开预览弹层并选中；
// 选中态由 selectedId 高亮。真正的生成在预览弹层里「用此模板生成」时触发。
export default function ThemeGallery({ themes, selectedId, onPreview }) {
  return (
    <div className="theme-gallery">
      <div className="theme-gallery-label">选择模板风格</div>
      <div className="theme-list">
        {themes.map((t) => (
          <button
            key={t.id}
            className={`theme-card${t.id === selectedId ? ' active' : ''}`}
            onClick={() => onPreview(t)}
            title={`预览「${t.name || t.id}」`}
          >
            <span className="theme-swatch" style={swatchStyle(t)} />
            <span className="theme-name">{t.name || t.id}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// 用主题主色做一个简单色板预览
function swatchStyle(t) {
  const p = t.palette || {};
  const c = (k, d) => (p[k] ? `#${p[k]}` : d);
  return {
    background: `linear-gradient(135deg, ${c('primary', '#1F4E79')} 0%, ${c('accent', '#2E86C1')} 100%)`,
  };
}

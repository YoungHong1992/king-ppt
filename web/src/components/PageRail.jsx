import React from 'react';

const ROLE_LABEL = { cover: '封面', section: '章节', content: '内容', closing: '结束' };

// 左侧页轨：整册缩略图导航。每张内联渲染该页 SVG（只读、等比）。点击滚动到对应大图。
export default function PageRail({ slides, activeIndex, onSelect }) {
  return (
    <div className="page-rail">
      {slides.map((s, i) => (
        <button
          key={i}
          className={`rail-item${i === activeIndex ? ' active' : ''}`}
          onClick={() => onSelect(i)}
          title={s && s.title ? s.title : `第 ${i + 1} 页`}
        >
          <span className="rail-num">{i + 1}</span>
          <span className="rail-thumb" dangerouslySetInnerHTML={{ __html: (s && s.svg) || '' }} />
          {s && s.role ? <span className="rail-role">{ROLE_LABEL[s.role] || s.role}</span> : null}
        </button>
      ))}
    </div>
  );
}

import React from 'react';

// 待发送批注列表（阶段1 版的 AnnotatePanel）：用户攒的批注在此列出，一次性发给 Agent。
// 发送 → api.action('outline-annotate', {comments})；定稿 → api.action('outline-finalize')。
// 点条目 → 激活（文稿内对应标注高亮）；activeId 决定哪条高亮显示。
export default function OutlineBatchPanel({ comments, busy, hasDoc, activeCommentId, onRemove, onActivate, onSend, onFinalize }) {
  const n = comments.length;
  return (
    <div className="ol-batch">
      <div className="annotate-head">
        <span>批注 · 待发送</span>
        {n > 0 ? <span className="annotate-scope">{n} 条</span> : null}
      </div>

      {n === 0 ? (
        <div className="ol-batch-empty">
          在左侧文档中选中文字即可批注；<br />攒够一批后点「发送批注」交给 Agent。
        </div>
      ) : (
        <div className="ol-batch-list">
          {comments.map((c) => (
            <div
              className={`ol-batch-item${c.id === activeCommentId ? ' active' : ''}`}
              key={c.id}
              onClick={() => onActivate && onActivate(c.id)}
            >
              <button
                className="ol-batch-x"
                title="删除"
                onClick={(e) => { e.stopPropagation(); onRemove(c.id); }}
              >✕</button>
              <div className="ol-batch-quote">“{c.quote.length > 30 ? c.quote.slice(0, 30) + '…' : c.quote}”</div>
              <div className="ol-batch-note">{c.comment}</div>
            </div>
          ))}
        </div>
      )}

      <div className="ol-batch-actions">
        <button className="btn btn-primary" disabled={busy || n === 0} onClick={onSend}>
          发送批注{n > 0 ? ` (${n})` : ''}
        </button>
        <button
          className="btn"
          disabled={busy || !hasDoc}
          title="确认内容无误，冻结为内容基线并进入出片阶段"
          onClick={() => { if (window.confirm('确认定稿？将以当前大纲作为内容基线进入出片阶段。')) onFinalize(); }}
        >
          定稿
        </button>
      </div>
    </div>
  );
}

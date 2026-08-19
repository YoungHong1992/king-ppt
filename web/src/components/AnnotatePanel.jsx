import React, { useState } from 'react';

// 批注面板（人 → Agent 往返）：把「对当前页/整册的自然语言修改意见」入队给用户 Agent。
// 这不是本地编辑——它请求 Agent 重新创作。Agent 长轮询取走后重画该页/整册并回推 SSE。
export default function AnnotatePanel({ activeIndex, hasSlides, busy, onAnnotate, onRegenerate }) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAnnotate(t, activeIndex);
    setText('');
  };

  return (
    <div className="annotate">
      <div className="annotate-head">
        <span>批注 · 交给 Agent</span>
        {hasSlides && activeIndex >= 0 ? <span className="annotate-scope">当前第 {activeIndex + 1} 页</span> : null}
      </div>
      <textarea
        className="annotate-input"
        rows={3}
        value={text}
        placeholder={'对这一页或整册提修改意见，交给 Agent 重画\n例：把这页配色改成更冷静的蓝灰，标题再大一点'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
      />
      <div className="annotate-actions">
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={submit}>
          发送批注
        </button>
        {hasSlides && activeIndex >= 0 ? (
          <button className="btn" disabled={busy} onClick={() => onRegenerate(activeIndex)} title="让 Agent 重画当前页">
            重画本页
          </button>
        ) : null}
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, subscribe } from './api.js';
import PageRail from './components/PageRail.jsx';
import SlideCanvas from './components/SlideCanvas.jsx';
import AnnotatePanel from './components/AnnotatePanel.jsx';
import ThemeGallery from './components/ThemeGallery.jsx';

// 卷王PPT · SVG-as-IR 前端。用户 Agent 是内容源；本页只做「挑主题 / 实时预览 / 就地编辑 / 批注往返 / 导出」。
// deck 权威在服务端中继；本页经 SSE 收 deck/slide 事件驱动渲染，经 /api/agent/action 把人类动作交回 Agent。
export default function App() {
  const [deck, setDeck] = useState({ title: '', themeId: null, slides: [], version: 0 });
  const [themes, setThemes] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [connected, setConnected] = useState(false);
  const canvasRefs = useRef({});
  const deckVersionRef = useRef(0);

  const flash = useCallback((text, type = 'info') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // 初始化：拉主题列表 + 当前 deck 快照（刷新/重连恢复）
  useEffect(() => {
    api.listThemes().then((r) => setThemes(r.templates || [])).catch(() => {});
    api.state().then((st) => {
      if (st && Array.isArray(st.slides)) {
        deckVersionRef.current = st.version || 0;
        setDeck({ title: st.title || '', themeId: st.templateId || null, slides: st.slides, version: st.version || 0 });
      }
    }).catch(() => {});
  }, []);

  // SSE 订阅：整册替换 / 单页写入。丢弃过期版本回放（version 单调）。
  useEffect(() => {
    const unsub = subscribe({
      onDeck: (data) => {
        if (data.version && data.version < deckVersionRef.current) return;
        deckVersionRef.current = data.version || deckVersionRef.current;
        setConnected(true);
        setDeck({
          title: data.title || '',
          themeId: data.templateId || null,
          slides: Array.isArray(data.slides) ? data.slides : [],
          version: data.version || 0,
        });
      },
      onSlide: (data) => {
        if (data.version && data.version < deckVersionRef.current) return;
        deckVersionRef.current = data.version || deckVersionRef.current;
        setConnected(true);
        setDeck((prev) => {
          // 正在就地编辑该页时，跳过 SSE 回放，避免打断输入
          if (canvasRefs.current[data.index]) { /* 就地编辑保护在 SlideCanvas 内处理 */ }
          const slides = prev.slides.slice();
          slides[data.index] = data.slide;
          return { ...prev, slides, version: data.version || prev.version };
        });
      },
      onError: () => setConnected(false),
    });
    return unsub;
  }, []);

  const slides = deck.slides.filter(Boolean);
  const hasSlides = slides.length > 0;

  // 就地编辑：把改后的整页 SVG 交回 Agent（服务端 sanitize 后落权威 deck 并广播）
  const onEdit = useCallback((index, svg) => {
    api.action('edit', { index, slide: { svg }, themeId: deck.themeId })
      .catch((e) => flash(`同步编辑失败：${e.message}`, 'error'));
  }, [deck.themeId, flash]);

  // 批注往返：请求 Agent 按意见重画（当前页或整册）
  const onAnnotate = useCallback((instruction, index) => {
    setBusy(true);
    api.action('annotate', { instruction, index: index >= 0 ? index : undefined, themeId: deck.themeId })
      .then(() => flash('批注已交给 Agent，正在重画…', 'ok'))
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [deck.themeId, flash]);

  const onRegenerate = useCallback((index) => {
    setBusy(true);
    api.action('regen', { index, themeId: deck.themeId })
      .then(() => flash(`已请求 Agent 重画第 ${index + 1} 页`, 'ok'))
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [deck.themeId, flash]);

  const onPickTheme = useCallback((themeId) => {
    api.action('theme-pick', { themeId })
      .then(() => flash('已切换主题，可让 Agent 按新主题重画', 'ok'))
      .catch((e) => flash(`切换失败：${e.message}`, 'error'));
  }, [flash]);

  const onExport = useCallback(async () => {
    if (!hasSlides) return;
    setBusy(true);
    try {
      const blob = await api.export(deck.slides, deck.title, deck.themeId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${deck.title || 'slides'}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      flash('已导出 .pptx', 'ok');
    } catch (e) {
      flash(`导出失败：${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [deck, hasSlides, flash]);

  const scrollToSlide = useCallback((i) => {
    setActiveIndex(i);
    const el = document.getElementById(`slide-${i}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-logo">卷</span><span className="brand-name">卷王PPT</span></div>
        <div className="deck-title">{deck.title ? `《${deck.title}》` : 'SVG 演示文稿'}</div>
        <div className="topbar-right">
          <span className={`conn-dot${connected ? ' on' : ''}`} title={connected ? '已连接中继' : '未连接'} />
          <button className="btn btn-primary" disabled={!hasSlides || busy} onClick={onExport}>导出 PPTX</button>
        </div>
      </header>

      <div className="workarea">
        <aside className="left-rail">
          <ThemeGallery themes={themes} activeId={deck.themeId} onPick={onPickTheme} />
          {hasSlides ? <PageRail slides={deck.slides} activeIndex={activeIndex} onSelect={scrollToSlide} /> : null}
        </aside>

        <main className="stage">
          {!hasSlides ? (
            <div className="empty">
              <div className="empty-art">🎞️</div>
              <div className="empty-title">等待 Agent 生成幻灯片</div>
              <div className="empty-sub">让你的 Agent 推送 SVG 整册，这里会逐页实时预览；点击文字即可就地编辑</div>
            </div>
          ) : (
            deck.slides.map((s, i) => s ? (
              <div className="stage-slide" id={`slide-${i}`} key={i}>
                <SlideCanvas
                  svg={s.svg}
                  index={i}
                  editable
                  active={i === activeIndex}
                  onSelect={setActiveIndex}
                  onEdit={onEdit}
                />
              </div>
            ) : null)
          )}
        </main>

        <aside className="right-panel">
          <AnnotatePanel
            activeIndex={activeIndex}
            hasSlides={hasSlides}
            busy={busy}
            onAnnotate={onAnnotate}
            onRegenerate={onRegenerate}
          />
        </aside>
      </div>

      {toast ? <div className={`toast ${toast.type}`}>{toast.text}</div> : null}
    </div>
  );
}

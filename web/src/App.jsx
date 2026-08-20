import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, subscribe } from './api.js';
import PageRail from './components/PageRail.jsx';
import SlideCanvas from './components/SlideCanvas.jsx';
import AnnotatePanel from './components/AnnotatePanel.jsx';
import ThemeGallery from './components/ThemeGallery.jsx';
import OutlineView from './components/OutlineView.jsx';
import OutlineBatchPanel from './components/OutlineBatchPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { useAppDialog, AppDialogHost } from './components/AppDialog.jsx';

// 卷王PPT · SVG-as-IR 前端。用户 Agent 是内容源；本页做「内容大纲确认（阶段1）+ 挑主题/实时预览/就地编辑/批注往返/导出（阶段2）」。
// deck 与 doc 权威都在服务端中继；本页经 SSE 收 deck/slide/doc 事件驱动渲染，经 /api/agent/action 把人类动作交回 Agent。
export default function App() {
  const [phase, setPhase] = useState('outline'); // 'outline' | 'slides'
  const [deck, setDeck] = useState({ title: '', themeId: null, slides: [], version: 0 });
  const [doc, setDocState] = useState({ markdown: '', title: '', version: 0 });
  const [outlineComments, setOutlineComments] = useState([]);
  const [activeCommentId, setActiveCommentId] = useState(null);
  const [themes, setThemes] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [connected, setConnected] = useState(false);
  const [providers, setProviders] = useState(null); // 多供应商配置视图（templates/instances/active，不含明文 key）
  const [showSettings, setShowSettings] = useState(false);
  const [topic, setTopic] = useState('');       // 阶段1 主题输入（server-gen 模式）
  const canvasRefs = useRef({});
  const deckVersionRef = useRef(0);
  const docVersionRef = useRef(0);
  const autoPhaseRef = useRef(false); // 是否已按内容自动切过一次阶段（之后以用户手动为准）
  const dialog = useAppDialog();      // 全站通用确认/输入弹窗（取代原生 confirm）

  const flash = useCallback((text, type = 'info') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // 初始化：拉主题列表 + 当前 deck / doc 快照（刷新/重连恢复）
  useEffect(() => {
    api.listThemes().then((r) => setThemes(r.templates || [])).catch(() => {});
    api.getProviders().then(setProviders).catch(() => {}); // 绑定了 chat 默认模型 → server-gen 模式
    api.state().then((st) => {
      if (st && Array.isArray(st.slides)) {
        deckVersionRef.current = st.version || 0;
        setDeck({ title: st.title || '', themeId: st.templateId || null, slides: st.slides, version: st.version || 0 });
      }
    }).catch(() => {});
    api.doc().then((d) => {
      if (d && typeof d.markdown === 'string') {
        if (d.version && d.version < docVersionRef.current) return; // 比照 onDoc：不让迟到快照覆盖更新的 SSE
        docVersionRef.current = d.version || 0;
        setDocState({ markdown: d.markdown, title: d.title || '', version: d.version || 0 });
      }
    }).catch(() => {});
  }, []);

  // SSE 订阅：整册替换 / 单页写入 / 大纲替换。丢弃过期版本回放（version 单调）。
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
        // 首次出现幻灯片且尚未手动切换：自动切到出片阶段
        if (!autoPhaseRef.current && Array.isArray(data.slides) && data.slides.filter(Boolean).length > 0) {
          autoPhaseRef.current = true;
          setPhase('slides');
        }
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
      onDoc: (data) => {
        if (data.version && data.version < docVersionRef.current) return;
        const changed = (data.version || 0) !== docVersionRef.current;
        docVersionRef.current = data.version || docVersionRef.current;
        setConnected(true);
        setDocState({ markdown: data.markdown || '', title: data.title || '', version: data.version || 0 });
        // 大纲更新（Agent 改稿重推）：清空本地批注与选中，旧高亮随 key 重挂丢弃
        if (changed) { setOutlineComments([]); setActiveCommentId(null); }
        // 首个非空大纲且尚未手动切换：自动切到内容大纲阶段
        if (!autoPhaseRef.current && data.markdown) {
          autoPhaseRef.current = true;
          setPhase('outline');
        }
      },
      onError: () => setConnected(false),
    });
    return unsub;
  }, []);

  const slides = deck.slides.filter(Boolean);
  const hasSlides = slides.length > 0;
  const hasDoc = !!doc.markdown;
  const serverGen = !!providers?.active?.chat; // 绑定了 chat 默认模型 = 服务端自带生成，批注走 server-gen 改稿

  // 就地编辑：把改后的整页 SVG 交回 Agent（服务端 sanitize 后落权威 deck 并广播）
  const onEdit = useCallback((index, svg) => {
    api.action('edit', { index, slide: { svg }, themeId: deck.themeId })
      .catch((e) => flash(`同步编辑失败：${e.message}`, 'error'));
  }, [deck.themeId, flash]);

  // 批注往返（幻灯片）：请求 Agent 按意见重画（当前页或整册）
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

  // ---------- 阶段1：内容大纲 ----------
  const onAddComment = useCallback((c) => {
    setOutlineComments((prev) => [...prev, c]);
  }, []);

  const onRemoveComment = useCallback((id) => {
    setOutlineComments((prev) => prev.filter((c) => c.id !== id));
    setActiveCommentId((cur) => (cur === id ? null : cur));
  }, []);

  const onActivateComment = useCallback((id) => {
    setActiveCommentId((cur) => (cur === id ? null : id));
  }, []);

  // server-gen 模式：按主题让服务端生成大纲（结果经 SSE 'doc' 回来，无需本地态）
  const onGenerateOutline = useCallback(() => {
    if (!topic.trim()) return;
    setBusy(true);
    api.generateOutline({ topic: topic.trim() })
      .then(() => flash('大纲已生成', 'ok'))
      .catch((e) => flash(`生成失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [topic, flash]);

  const onSendBatch = useCallback(() => {
    if (outlineComments.length === 0) return;
    setBusy(true);
    // server-gen：服务端即时改稿并经 SSE 推回；否则入队交调用方 Agent
    const p = serverGen
      ? api.reviseOutline(outlineComments)
      : api.action('outline-annotate', { comments: outlineComments });
    p.then(() => {
      setOutlineComments([]); setActiveCommentId(null);
      flash(serverGen ? '正在按批注改稿…' : '批注已发送，等待 Agent 修订大纲…', 'ok');
    })
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [outlineComments, serverGen, flash]);

  const onFinalize = useCallback(async () => {
    const ok = await dialog.ask({
      title: '确认定稿？',
      body: '将以当前大纲作为内容基线进入出片阶段。',
      okText: '定稿',
    });
    if (!ok) return;
    setBusy(true);
    api.action('outline-finalize', {})
      .then(() => flash(serverGen ? '已定稿（阶段2 出片即将开放）' : '已定稿，Agent 将据此进入出片阶段', 'ok'))
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [serverGen, flash, dialog.ask]);

  // 拖拽上传参考素材 → base64 → 上传 → 服务端入队 material-added
  const uploadFiles = useCallback((files) => {
    Array.from(files || []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result || '').split(',')[1] || '';
        api.uploadMaterial(file.name, b64)
          .then((r) => flash(serverGen ? `素材已上传：${r.name}，生成大纲时将参考` : `素材已上传：${r.name}，Agent 已收到`, 'ok'))
          .catch((e) => flash(`上传失败：${e.message}`, 'error'));
      };
      reader.readAsDataURL(file);
    });
  }, [serverGen, flash]);

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

  const headerTitle = phase === 'outline'
    ? (doc.title ? `《${doc.title}》· 内容大纲` : '内容大纲')
    : (deck.title ? `《${deck.title}》` : 'SVG 演示文稿');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-logo">卷</span><span className="brand-name">卷王PPT</span></div>
        <div className="seg">
          <button className={`seg-btn${phase === 'outline' ? ' on' : ''}`} onClick={() => setPhase('outline')}>内容大纲</button>
          <button className={`seg-btn${phase === 'slides' ? ' on' : ''}`} onClick={() => setPhase('slides')}>幻灯片</button>
        </div>
        <div className="deck-title">{headerTitle}</div>
        <div className="topbar-right">
          <span className={`conn-dot${connected ? ' on' : ''}`} title={connected ? '已连接中继' : '未连接'} />
          <button className="model-chip" title="模型设置" onClick={() => setShowSettings(true)}>
            <span className={`chip-dot${providers?.active?.chat ? ' ok' : ''}`} />
            <span className="model-info">{providers?.active?.chat ? `${providers.active.chat.instanceName} · ${providers.active.chat.model}` : '未配置模型'}</span>
          </button>
          <button className="icon-btn" title="模型设置" onClick={() => setShowSettings(true)}>⚙</button>
          <button className="btn btn-primary" disabled={!hasSlides || busy} onClick={onExport}>导出 PPTX</button>
        </div>
      </header>

      {phase === 'outline' ? (
        <div className="workarea">
          <aside className="left-rail">
            {serverGen ? (
              <div className="gen-box">
                <label className="field-label">主题</label>
                <textarea
                  className="gen-topic"
                  placeholder="输入演示主题，例如：给大一新生的时间管理分享"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
                <button className="btn btn-primary" disabled={busy || !topic.trim()} onClick={onGenerateOutline}>
                  {hasDoc ? '重新生成大纲' : '生成大纲'}
                </button>
                <div className="rail-divider" />
              </div>
            ) : null}
            <div
              className="mat-drop"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
              onDragLeave={(e) => e.currentTarget.classList.remove('over')}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); uploadFiles(e.dataTransfer.files); }}
            >
              <div className="mat-drop-icon">📎</div>
              <div className="mat-drop-text">拖入参考素材<br />（pdf / docx / md / txt / 图片）</div>
            </div>
          </aside>

          <main className="stage">
            <OutlineView
              markdown={doc.markdown}
              version={doc.version}
              serverGen={serverGen}
              comments={outlineComments}
              activeCommentId={activeCommentId}
              onAddComment={onAddComment}
              onActivateComment={onActivateComment}
            />
          </main>

          <aside className="right-panel">
            <OutlineBatchPanel
              comments={outlineComments}
              busy={busy}
              hasDoc={hasDoc}
              activeCommentId={activeCommentId}
              onRemove={onRemoveComment}
              onActivate={onActivateComment}
              onSend={onSendBatch}
              onFinalize={onFinalize}
            />
          </aside>
        </div>
      ) : (
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
      )}

      {showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onProvidersChange={(d) => setProviders(d)}
          flash={flash}
        />
      ) : null}
      <AppDialogHost dialog={dialog} />
      {toast ? <div className={`toast ${toast.type}`}>{toast.text}</div> : null}
    </div>
  );
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, subscribe } from './api.js';
import PageRail from './components/PageRail.jsx';
import SlideCanvas from './components/SlideCanvas.jsx';
import AnnotatePanel from './components/AnnotatePanel.jsx';
import ThemeGallery from './components/ThemeGallery.jsx';
import ThemePreview from './components/ThemePreview.jsx';
import OutlineView from './components/OutlineView.jsx';
import OutlineBatchPanel from './components/OutlineBatchPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { useAppDialog, AppDialogHost } from './components/AppDialog.jsx';

// 卷王PPT · 独立生成程序（server-gen）。一条线性向导：
//   ① 内容大纲（生成/批注/定稿） → ② 选择模板（预览确认） → ③ 幻灯片（逐页流式生成/就地编辑/单页重画/导出）。
// deck 与 doc 的权威都在服务端；本页经 SSE 收 deck/slide/doc 事件驱动渲染，经 REST 触发生成与编辑。
const STEPS = [
  { key: 'outline', no: 1, label: '内容大纲' },
  { key: 'theme', no: 2, label: '选择模板' },
  { key: 'slides', no: 3, label: '幻灯片' },
];

export default function App() {
  const [step, setStep] = useState('outline'); // 'outline' | 'theme' | 'slides'
  const [deck, setDeck] = useState({ title: '', themeId: null, slides: [], version: 0 });
  const [doc, setDocState] = useState({ markdown: '', title: '', version: 0 });
  const [outlineComments, setOutlineComments] = useState([]);
  const [activeCommentId, setActiveCommentId] = useState(null);
  const [themes, setThemes] = useState([]);
  const [selectedThemeId, setSelectedThemeId] = useState(null); // 选模板步已选中的主题
  const [previewTheme, setPreviewTheme] = useState(null);       // 正在预览的主题对象（null=不显示弹层）
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [connected, setConnected] = useState(false);
  const [providers, setProviders] = useState(null); // 多供应商配置视图（不含明文 key）
  const [showSettings, setShowSettings] = useState(false);
  const [topic, setTopic] = useState('');       // 阶段1 主题输入
  const deckVersionRef = useRef(0);
  const docVersionRef = useRef(0);
  const initedRef = useRef(false); // 是否已按首份快照设过初始步骤（之后以用户操作为准）
  const dialog = useAppDialog();

  const flash = useCallback((text, type = 'info') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // 初始化：拉主题列表 + 供应商配置 + 当前 deck / doc 快照（刷新/重连恢复）
  useEffect(() => {
    api.listThemes().then((r) => setThemes(r.templates || [])).catch(() => {});
    api.getProviders().then(setProviders).catch(() => {});
    api.deck().then((st) => {
      if (st && Array.isArray(st.slides)) {
        deckVersionRef.current = st.version || 0;
        setDeck({ title: st.title || '', themeId: st.templateId || null, slides: st.slides, version: st.version || 0 });
        if (st.templateId) setSelectedThemeId(st.templateId);
        // 恢复初始步骤：已有幻灯片 → 出片步；否则留在大纲步
        if (!initedRef.current && st.slides.filter(Boolean).length > 0) { initedRef.current = true; setStep('slides'); }
      }
    }).catch(() => {});
    api.doc().then((d) => {
      if (d && typeof d.markdown === 'string') {
        if (d.version && d.version < docVersionRef.current) return;
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
        if (data.templateId) setSelectedThemeId(data.templateId);
      },
      onSlide: (data) => {
        if (data.version && data.version < deckVersionRef.current) return;
        deckVersionRef.current = data.version || deckVersionRef.current;
        setConnected(true);
        setDeck((prev) => {
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
        // 大纲更新（改稿重推）：清空本地批注与选中，旧高亮随 key 重挂丢弃
        if (changed) { setOutlineComments([]); setActiveCommentId(null); }
      },
      onError: () => setConnected(false),
    });
    return unsub;
  }, []);

  const slides = deck.slides.filter(Boolean);
  const hasSlides = slides.length > 0;
  const hasDoc = !!doc.markdown;
  const hasModel = !!providers?.active?.chat; // 已绑定文本默认模型才能生成
  const activeThemeId = selectedThemeId || deck.themeId;

  // ---------- 阶段2：出片 ----------
  // 就地编辑：把改后的整页 SVG 交回服务端（sanitize 后落权威 deck 并广播）
  const onEdit = useCallback((index, svg) => {
    api.editSlide(index, svg).catch((e) => flash(`同步编辑失败：${e.message}`, 'error'));
  }, [flash]);

  // 按意见重画当前页
  const onAnnotate = useCallback((instruction, index) => {
    if (!(index >= 0)) { flash('请先选中要修改的页', 'error'); return; }
    setBusy(true);
    api.regenSlide(index, instruction)
      .then(() => flash(`已按意见重画第 ${index + 1} 页`, 'ok'))
      .catch((e) => flash(`重画失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [flash]);

  // 重画当前页（无修改意见）
  const onRegenerate = useCallback((index) => {
    setBusy(true);
    api.regenSlide(index)
      .then(() => flash(`已重画第 ${index + 1} 页`, 'ok'))
      .catch((e) => flash(`重画失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [flash]);

  // 打开模板预览弹层
  const onPreviewTheme = useCallback((theme) => setPreviewTheme(theme), []);

  // 确认用此模板：切到出片步，服务端逐页流式生成（结果经 SSE 实时冒页）
  const onConfirmTheme = useCallback((themeId) => {
    if (!hasModel) { flash('请先在右上角「模型设置」绑定文本模型', 'error'); return; }
    setSelectedThemeId(themeId);
    setPreviewTheme(null);
    setStep('slides');
    setActiveIndex(0);
    setBusy(true);
    flash('正在按模板逐页生成…', 'ok');
    api.generateDeck(themeId)
      .then((r) => flash(r.recovered?.length ? `生成完成，其中 ${r.recovered.length} 页需重画` : '生成完成', 'ok'))
      .catch((e) => flash(`生成失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [hasModel, flash]);

  // ---------- 阶段1：内容大纲 ----------
  const onAddComment = useCallback((c) => setOutlineComments((prev) => [...prev, c]), []);
  const onRemoveComment = useCallback((id) => {
    setOutlineComments((prev) => prev.filter((c) => c.id !== id));
    setActiveCommentId((cur) => (cur === id ? null : cur));
  }, []);
  const onActivateComment = useCallback((id) => setActiveCommentId((cur) => (cur === id ? null : id)), []);

  // 按主题让服务端生成大纲（结果经 SSE 'doc' 回来）
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
    api.reviseOutline(outlineComments)
      .then(() => { setOutlineComments([]); setActiveCommentId(null); flash('正在按批注改稿…', 'ok'); })
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [outlineComments, flash]);

  const onFinalize = useCallback(async () => {
    const ok = await dialog.ask({
      title: '确认定稿？',
      body: '将以当前大纲作为内容基线，进入「选择模板」。',
      okText: '定稿',
    });
    if (!ok) return;
    setStep('theme');
    flash('已定稿，请选择模板', 'ok');
  }, [flash, dialog]);

  // 拖拽上传参考素材 → base64 → 上传 → 服务端存盘（生成时自动参考）
  const uploadFiles = useCallback((files) => {
    Array.from(files || []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result || '').split(',')[1] || '';
        api.uploadMaterial(file.name, b64)
          .then((r) => flash(`素材已上传：${r.name}，生成时将参考`, 'ok'))
          .catch((e) => flash(`上传失败：${e.message}`, 'error'));
      };
      reader.readAsDataURL(file);
    });
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

  // 步骤可达性：大纲随时可回；选模板需已有大纲；幻灯片需已生成
  const canGo = useCallback((key) => {
    if (key === 'outline') return true;
    if (key === 'theme') return hasDoc;
    if (key === 'slides') return hasSlides;
    return false;
  }, [hasDoc, hasSlides]);

  const headerTitle = step === 'outline'
    ? (doc.title ? `《${doc.title}》· 内容大纲` : '内容大纲')
    : step === 'theme'
      ? '选择模板风格'
      : (deck.title ? `《${deck.title}》` : 'SVG 演示文稿');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-logo">卷</span><span className="brand-name">卷王PPT</span></div>
        <div className="stepper">
          {STEPS.map((s) => (
            <button
              key={s.key}
              className={`step${step === s.key ? ' on' : ''}${canGo(s.key) ? '' : ' locked'}`}
              disabled={!canGo(s.key)}
              onClick={() => canGo(s.key) && setStep(s.key)}
            >
              <span className="step-no">{s.no}</span>
              <span className="step-label">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="deck-title">{headerTitle}</div>
        <div className="topbar-right">
          <span className={`conn-dot${connected ? ' on' : ''}`} title={connected ? '已连接' : '未连接'} />
          <button className="model-chip" title="模型设置" onClick={() => setShowSettings(true)}>
            <span className={`chip-dot${hasModel ? ' ok' : ''}`} />
            <span className="model-info">{hasModel ? `${providers.active.chat.instanceName} · ${providers.active.chat.model}` : '未配置模型'}</span>
          </button>
          <button className="icon-btn" title="模型设置" onClick={() => setShowSettings(true)}>⚙</button>
          <button className="btn btn-primary" disabled={!hasSlides || busy} onClick={onExport}>导出 PPTX</button>
        </div>
      </header>

      {step === 'outline' ? (
        <div className="workarea">
          <aside className="left-rail">
            <div className="gen-box">
              <label className="field-label">主题</label>
              <textarea
                className="gen-topic"
                placeholder="输入演示主题，例如：给大一新生的时间管理分享"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
              <button className="btn btn-primary" disabled={busy || !topic.trim() || !hasModel} onClick={onGenerateOutline}>
                {hasDoc ? '重新生成大纲' : '生成大纲'}
              </button>
              {!hasModel ? <div className="rail-tip">请先在右上角「模型设置」绑定文本模型</div> : null}
              <div className="rail-divider" />
            </div>
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
      ) : step === 'theme' ? (
        <div className="workarea">
          <main className="stage stage-theme">
            <div className="theme-pick-head">
              <div className="theme-pick-title">选择一套模板风格</div>
              <div className="theme-pick-sub">点任意模板查看预览效果，确认后按此模板 + 你的大纲逐页生成幻灯片</div>
            </div>
            <div className="theme-pick-grid">
              {themes.map((t) => (
                <button
                  key={t.id}
                  className={`theme-pick-card${t.id === activeThemeId ? ' active' : ''}`}
                  onClick={() => onPreviewTheme(t)}
                  title={`预览「${t.name || t.id}」`}
                >
                  <span className="theme-pick-swatch" style={{ background: `linear-gradient(135deg, #${t.palette?.primary || '1F4E79'} 0%, #${t.palette?.accent || '2E86C1'} 100%)` }} />
                  <span className="theme-pick-name">{t.name || t.id}</span>
                </button>
              ))}
            </div>
          </main>
        </div>
      ) : (
        <div className="workarea">
          <aside className="left-rail">
            <ThemeGallery themes={themes} selectedId={activeThemeId} onPreview={onPreviewTheme} />
            {hasSlides ? <PageRail slides={deck.slides} activeIndex={activeIndex} onSelect={scrollToSlide} /> : null}
          </aside>

          <main className="stage">
            {!hasSlides ? (
              <div className="empty">
                <div className="empty-art">🎞️</div>
                <div className="empty-title">{busy ? '正在按模板逐页生成…' : '还没有幻灯片'}</div>
                <div className="empty-sub">{busy ? '页面会逐张实时出现；生成后点击文字即可就地编辑' : '回到「选择模板」步，挑一套风格开始生成'}</div>
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
                  {s._recovered ? (
                    <div className="slide-recovered">
                      此页未能正确生成，<button className="link-btn" disabled={busy} onClick={() => onRegenerate(i)}>重新生成</button>
                    </div>
                  ) : null}
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

      {previewTheme ? (
        <ThemePreview
          theme={previewTheme}
          busy={busy}
          onClose={() => setPreviewTheme(null)}
          onConfirm={onConfirmTheme}
        />
      ) : null}

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

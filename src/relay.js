// 有状态存储 + 广播总线：在「服务端生成」与「人类浏览器」之间同步演示态。
//  - deck 存储：当前整册（title/templateId/canvas/slides[]/version），单调 version，单页粒度写入。
//  - doc 存储：阶段1 内容大纲镜像（markdown/title/version），与 deck 并列、独立 version。
//  - 事件总线：浏览器通过 SSE 订阅；服务端每次 setDeck/setSlide/setDoc 实时推给浏览器预览。
// Node 单线程 + 路由内同步 read-modify-write 单页 → 逐页流式生成与人类就地编辑并发不丢更新。
function createRelay() {
  const deck = { title: '', templateId: null, canvas: null, slides: [], version: 0 };
  const doc = { markdown: '', title: '', version: 0 };
  const subscribers = new Set(); // SSE 响应对象（浏览器侧）

  // ---------- deck 存储（单页粒度） ----------
  function bump() { deck.version += 1; return deck.version; }

  function getState() {
    return {
      title: deck.title, templateId: deck.templateId, canvas: deck.canvas,
      slides: deck.slides, version: deck.version,
    };
  }

  // 整册替换（如逐页生成前建空册）。slides 已由 server 归一。
  function setDeck({ title, templateId, canvas, slides }) {
    if (title !== undefined) deck.title = title;
    if (templateId !== undefined) deck.templateId = templateId;
    if (canvas !== undefined) deck.canvas = canvas;
    deck.slides = Array.isArray(slides) ? slides : [];
    const version = bump();
    broadcast('deck', { ...getState() });
    return version;
  }

  // 单页写入（逐页生成 / 人类就地编辑）。同步改 slides[index]，不跨 await。
  function setSlide(index, slide, canvas) {
    if (!(index >= 0)) throw new Error('页序号非法');
    if (canvas !== undefined && canvas !== null) deck.canvas = canvas;
    deck.slides[index] = slide;
    const version = bump();
    broadcast('slide', { index, slide, canvas: deck.canvas, version });
    return version;
  }

  // ---------- 内容大纲镜像（阶段1） ----------
  function getDoc() {
    return { markdown: doc.markdown, title: doc.title, version: doc.version };
  }

  function setDoc({ markdown, title }) {
    if (markdown !== undefined) doc.markdown = markdown;
    if (title !== undefined) doc.title = title;
    doc.version += 1;
    broadcast('doc', getDoc());
    return doc.version;
  }

  // ---------- SSE 事件总线（浏览器侧） ----------
  function subscribe(res) {
    subscribers.add(res);
    return () => subscribers.delete(res);
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) {
      try { res.write(frame); } catch { subscribers.delete(res); }
    }
  }

  function pingAll() {
    for (const res of subscribers) {
      try { res.write(': ping\n\n'); } catch { subscribers.delete(res); }
    }
  }

  return {
    getState, setDeck, setSlide,
    getDoc, setDoc,
    subscribe, broadcast, pingAll,
  };
}

module.exports = { createRelay };

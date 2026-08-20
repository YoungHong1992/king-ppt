// 有状态中继：在「用户 Agent」与「人类浏览器」之间架桥。
//  - deck 存储：当前整册（title/templateId/slides[]/version），单调 version，单页粒度写入。
//  - 事件总线：浏览器通过 SSE 订阅，Agent push 的 deck/slide 实时推给浏览器预览。
//  - 动作队列：浏览器把人类动作入队；Agent 长轮询 next 取走（取代旧的自愈 loop）。
// Node 单线程 + 路由内同步 read-modify-write 单页 → Agent push 与人类 edit 并发不丢更新。
function createRelay() {
  const deck = { title: '', templateId: null, canvas: null, slides: [], version: 0 };
  const doc = { markdown: '', title: '', version: 0 }; // 阶段1：内容大纲镜像，与 deck 并列、独立 version
  const subscribers = new Set(); // SSE 响应对象（浏览器侧）
  const queue = [];              // 待 Agent 消费的人类动作
  const waiters = [];            // 阻塞在 next 上的 { resolve, timer }
  let seq = 0;                   // 动作单调序号

  // ---------- deck 存储（单页粒度） ----------
  function bump() { deck.version += 1; return deck.version; }

  function getState() {
    return {
      title: deck.title, templateId: deck.templateId, canvas: deck.canvas,
      slides: deck.slides, version: deck.version,
    };
  }

  // 整册替换（Agent push 整册）。slides 已由 server 归一 + resolve。
  function setDeck({ title, templateId, canvas, slides }) {
    if (title !== undefined) deck.title = title;
    if (templateId !== undefined) deck.templateId = templateId;
    if (canvas !== undefined) deck.canvas = canvas;
    deck.slides = Array.isArray(slides) ? slides : [];
    const version = bump();
    broadcast('deck', { ...getState() });
    return version;
  }

  // 单页写入（Agent push-slide / 人类 edit）。同步改 slides[index]，不跨 await。
  function setSlide(index, slide, canvas) {
    if (!(index >= 0)) throw new Error('页序号非法');
    if (canvas !== undefined && canvas !== null) deck.canvas = canvas;
    deck.slides[index] = slide;
    const version = bump();
    broadcast('slide', { index, slide, canvas: deck.canvas, version });
    return version;
  }

  function setTemplate(templateId) {
    deck.templateId = templateId;
    return bump();
  }

  // ---------- 内容大纲镜像（阶段1） ----------
  // deck 是幻灯片；doc 是 Markdown 内容底稿。二者共用 SSE 总线与动作队列，但各自独立 version。
  function getDoc() {
    return { markdown: doc.markdown, title: doc.title, version: doc.version };
  }

  // Agent 推大纲：改字段 → 自增 doc.version → SSE 广播 'doc' → 返回 version
  function setDoc({ markdown, title }) {
    if (markdown !== undefined) doc.markdown = markdown;
    if (title !== undefined) doc.title = title;
    doc.version += 1;
    broadcast('doc', getDoc());
    return doc.version;
  }

  function reset({ title = '', templateId = null } = {}) {
    deck.title = title;
    deck.templateId = templateId;
    deck.canvas = null;
    deck.slides = [];
    return bump();
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

  // ---------- 动作队列（Agent 长轮询 next） ----------
  // 浏览器把人类动作入队；若 Agent 正阻塞在 next，直接交付，否则排队等取。
  function enqueueAction(action) {
    const item = { ...action, seq: ++seq, version: deck.version };
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    } else {
      queue.push(item);
    }
    return item;
  }

  // Agent 侧：取下一个人类动作。队列有则立即返回；空则阻塞至超时发 heartbeat。
  function waitForAction(timeoutMs = 25000) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve({ action: 'heartbeat', version: deck.version });
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function pendingCount() { return queue.length; }

  return {
    getState, setDeck, setSlide, setTemplate, reset,
    getDoc, setDoc,
    subscribe, broadcast, pingAll,
    enqueueAction, waitForAction, pendingCount,
  };
}

module.exports = { createRelay };

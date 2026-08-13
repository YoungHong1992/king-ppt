// 会话持久化：~/.king-ppt/sessions/<id>.json（每份会话一个文件）
// 一份会话含完整 slides（每个 scene graph 数 KB），分文件让每次保存只写单个会话，
// 避免 SSE 逐页保存时反复重写整库。列表由目录扫描派生，模块级 Map 缓存避免重复解析。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SESSIONS_DIR = path.join(os.homedir(), '.king-ppt', 'sessions');
const ID_RE = /^s_[a-f0-9]{16}$/;

const cache = new Map(); // id → 完整会话对象

function ensureDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function fileOf(id) {
  if (!ID_RE.test(id)) {
    const err = new Error('非法的会话 ID');
    err.code = 'BAD_SESSION_ID';
    throw err;
  }
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function readFileById(id) {
  if (cache.has(id)) return cache.get(id);
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    cache.set(id, data);
    return data;
  } catch {
    return null;
  }
}

function writeFileById(id, data) {
  ensureDir();
  fs.writeFileSync(fileOf(id), JSON.stringify(data, null, 2), 'utf8');
  cache.set(id, data);
}

// 派生轻量 meta（列表用）
function metaOf(s) {
  return {
    id: s.id,
    title: s.title || s.topic || '新会话',
    phase: s.phase || 'idle',
    templateId: s.templateId || null,
    pageCount: Array.isArray(s.slides) ? s.slides.filter(Boolean).length : 0,
    createdAt: s.createdAt || 0,
    updatedAt: s.updatedAt || 0,
  };
}

function listSessions() {
  ensureDir();
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const metas = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const s = readFileById(id);
    if (s) metas.push(metaOf(s));
  }
  metas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return metas;
}

function createSession(initial = {}) {
  const id = `s_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const session = {
    id,
    title: initial.title || initial.topic || '新会话',
    topic: initial.topic || '',
    phase: initial.phase || 'idle',
    templateId: initial.templateId || null,
    pages: initial.pages || 8,
    outline: initial.outline || null,
    slides: Array.isArray(initial.slides) ? initial.slides : [],
    messages: Array.isArray(initial.messages) ? initial.messages : [],
    canvas: initial.canvas || null,
    createdAt: now,
    updatedAt: now,
  };
  writeFileById(id, session);
  return session;
}

function getSession(id) {
  const s = readFileById(id);
  if (!s) {
    const err = new Error('会话不存在');
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }
  return s;
}

// outline / slides / messages 等整体替换（非深合并）；其余字段浅合并
function updateSession(id, patch = {}) {
  const existing = readFileById(id);
  if (!existing) {
    const err = new Error('会话不存在');
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }
  const next = { ...existing, ...patch, id, createdAt: existing.createdAt, updatedAt: Date.now() };
  writeFileById(id, next);
  return next;
}

function deleteSession(id) {
  try {
    fs.unlinkSync(fileOf(id));
  } catch { /* 已不存在，视为成功 */ }
  cache.delete(id);
  return true;
}

module.exports = {
  SESSIONS_DIR,
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
};

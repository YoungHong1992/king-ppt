#!/usr/bin/env node
// 卷王PPT CLI —— 用户 Agent 的 shell-out 接口。
//
// 两类子命令：
//   serve   —— 前台阻塞启动中继服务器 + 开浏览器（Agent 以后台任务方式拉起，保活）。
//   其余    —— 短命 HTTP 客户端，经 KING_PPT_HOME/server.json 定位运行中的服务器。
//
// 约定：成功打印 JSON 到 stdout；失败打印到 stderr 并以非零码退出，便于 Agent 判读。
const fs = require('fs');
const { exec } = require('child_process');
const { start } = require('../src/server');
const { RUNTIME_FILE } = require('../src/paths');

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// --k=v / --k v / --flag 解析；位置参数单独收集
function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opts[a.slice(2)] = argv[++i]; }
      else { opts[a.slice(2)] = true; }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function out(data) {
  process.stdout.write((typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '\n');
}

// 运行中的服务器基址：serve 启动时写 server.json { port, pid }
function baseUrl(opts = {}) {
  if (opts.port) return `http://localhost:${opts.port}`;
  if (process.env.KING_PPT_PORT) return `http://localhost:${process.env.KING_PPT_PORT}`;
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (rt && rt.port) return `http://localhost:${rt.port}`;
  } catch { /* 未启动或运行时文件缺失 */ }
  die('未找到运行中的服务器。请先在后台运行 `king-ppt serve`，或用 --port= 指定端口。');
}

async function req(base, path, { method = 'GET', body, raw = false } = {}) {
  const resp = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch { /* 非 JSON 错误体 */ }
    throw new Error(`${method} ${path} → ${resp.status} ${detail}`);
  }
  return raw ? Buffer.from(await resp.arrayBuffer()) : resp.json();
}

// 读入 JSON：优先位置参数指定的文件，否则读 stdin（支持管道）
function readJsonInput(file) {
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  if (!text.trim()) die('未提供 JSON 输入（给出文件路径，或经 stdin 管道传入）。');
  try { return JSON.parse(text); } catch (e) { die(`JSON 解析失败：${e.message}`); }
}

const COMMANDS = {
  // 前台启动中继服务器 + 开浏览器。Agent 应以后台任务方式运行此命令保活。
  async serve(opts) {
    const port = opts.port ? Number(opts.port) : (Number(process.env.PORT) || 3210);
    const { port: actual } = await start(port);
    const url = `http://localhost:${actual}`;
    out({ status: 'serving', url, port: actual, home: RUNTIME_FILE });
    process.stderr.write(`\n  卷王PPT 已启动: ${url}\n  用户 Agent：GET /api/agent/next 长轮询人类动作；POST /api/agent/deck|slide 推内容。\n\n`);
    if (!opts['no-open']) openBrowser(url);
    // 前台常驻，不 resolve；由后台任务或 `king-ppt stop` 终止
  },

  // 终止运行中的服务器（读 server.json 的 pid）
  async stop() {
    let rt;
    try { rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); }
    catch { return out({ status: 'not-running' }); }
    try { process.kill(rt.pid); }
    catch (e) {
      if (e.code === 'ESRCH') { // 进程已不在：清掉残留运行时文件即可
        try { fs.unlinkSync(RUNTIME_FILE); } catch { /* 已删则忽略 */ }
        return out({ status: 'already-dead', pid: rt.pid });
      }
      return die(`终止失败（pid ${rt.pid}）：${e.message}`);
    }
    out({ status: 'stopped', pid: rt.pid });
  },

  // 模板列表（供人类/Agent 挑方案）
  async templates(opts) {
    out(await req(baseUrl(opts), '/api/templates'));
  },

  // 所选模板的创作规格：字数约束/配色/free-SVG 规范/8 类版式契约文本
  async spec(opts, positional) {
    const id = positional[0];
    if (!id) die('用法：king-ppt spec <templateId>');
    out(await req(baseUrl(opts), `/api/templates/${encodeURIComponent(id)}/spec`));
  },

  // 推整册：{ title, templateId, slides[] } → resolve+校验 → SSE 推浏览器预览
  async push(opts, positional) {
    const deck = readJsonInput(positional[0]);
    out(await req(baseUrl(opts), '/api/agent/deck', { method: 'POST', body: deck }));
  },

  // 推单页（逐页流式）：king-ppt push-slide <index> [file.json]
  async 'push-slide'(opts, positional) {
    const index = Number(positional[0]);
    if (!(index >= 0)) die('用法：king-ppt push-slide <index> [file.json]');
    const slide = readJsonInput(positional[1]);
    const body = slide.slide ? { index, ...slide } : { index, slide };
    out(await req(baseUrl(opts), '/api/agent/slide', { method: 'POST', body }));
  },

  // 长轮询下一个人类动作（阻塞至有动作或 ~25s 心跳）
  async next(opts) {
    const timeout = opts.timeout ? `?timeout=${Number(opts.timeout)}` : '';
    out(await req(baseUrl(opts), `/api/agent/next${timeout}`));
  },

  // 完整 deck 快照（Agent 重启/重连恢复）
  async state(opts) {
    out(await req(baseUrl(opts), '/api/agent/state'));
  },

  // 供图：--data=<base64> | --url=<url> | --file=<本地图片> → slide.image 载荷
  async asset(opts) {
    let body;
    if (opts.file) body = { data: fs.readFileSync(opts.file).toString('base64'), ext: (opts.file.split('.').pop() || 'png').toLowerCase() };
    else if (opts.data) body = { data: opts.data, ext: opts.ext || 'png' };
    else if (opts.url) body = { url: opts.url };
    else die('用法：king-ppt asset (--file=<图片> | --data=<base64> | --url=<url>)');
    out(await req(baseUrl(opts), '/api/assets', { method: 'POST', body }));
  },

  // 导出当前 deck 为 .pptx：king-ppt export <out.pptx>
  async export(opts, positional) {
    const dest = positional[0];
    if (!dest) die('用法：king-ppt export <out.pptx>');
    const base = baseUrl(opts);
    const st = await req(base, '/api/agent/state');
    if (!Array.isArray(st.slides) || st.slides.filter(Boolean).length === 0) die('当前没有可导出的幻灯片，请先 push。');
    const buf = await req(base, '/api/export', {
      method: 'POST', raw: true,
      body: { slides: st.slides, title: st.title, templateId: st.templateId },
    });
    fs.writeFileSync(dest, buf);
    out({ status: 'exported', file: dest, bytes: buf.length, pages: st.slides.filter(Boolean).length });
  },
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { opts, positional } = parseArgs(rest);
  if (!cmd || cmd === 'help' || opts.help) {
    out([
      '卷王PPT CLI —— 用户 Agent 的 PPT 生成接口',
      '',
      '  serve [--port=N] [--no-open]   前台启动中继服务器 + 开浏览器（以后台任务运行）',
      '  stop                           终止运行中的服务器',
      '  templates                      列出模板',
      '  spec <templateId>              某模板的创作规格（字数/配色/free-SVG/版式契约）',
      '  push [deck.json]               推整册（stdin 或文件）→ 浏览器实时预览',
      '  push-slide <index> [s.json]    推单页（逐页流式）',
      '  next [--timeout=ms]            长轮询下一个人类动作（阻塞）',
      '  state                          当前 deck 快照',
      '  asset --file=|--data=|--url=   供图，返回 slide.image 载荷',
      '  export <out.pptx>              导出当前 deck 为 .pptx',
      '',
      '  通用：--port=N 或 KING_PPT_PORT 覆盖服务器定位；KING_PPT_HOME 指定数据根目录',
    ].join('\n'));
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) die(`未知命令：${cmd}（运行 \`king-ppt help\` 查看用法）`);
  try {
    await handler(opts, positional);
  } catch (e) {
    die(`错误：${e.message}`);
  }
}

main();

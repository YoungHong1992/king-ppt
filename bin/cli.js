#!/usr/bin/env node
// 卷王PPT CLI —— 独立程序的运维入口。
//
//   serve  —— 前台阻塞启动服务器 + 开浏览器（可用后台任务方式拉起保活）。
//   stop   —— 终止运行中的服务器（读 server.json 的 pid）。
//   export —— 把当前演示态导出为 .pptx 文件（也可直接在网页里点「导出 PPTX」）。
//
// 内容生成、选模板、编辑全部在浏览器里完成；本 CLI 不再承担内容通道。
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

const COMMANDS = {
  // 前台启动服务器 + 开浏览器。可用后台任务方式运行保活。
  async serve(opts) {
    const port = opts.port ? Number(opts.port) : (Number(process.env.PORT) || 3210);
    const { port: actual } = await start(port);
    const url = `http://localhost:${actual}`;
    out({ status: 'serving', url, port: actual, home: RUNTIME_FILE });
    process.stderr.write(`\n  卷王PPT 已启动: ${url}\n  在浏览器里配置模型 → 生成大纲 → 选模板 → 生成幻灯片 → 导出。\n\n`);
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

  // 导出当前演示态为 .pptx：king-ppt export <out.pptx>
  async export(opts, positional) {
    const dest = positional[0];
    if (!dest) die('用法：king-ppt export <out.pptx>');
    const base = baseUrl(opts);
    const st = await req(base, '/api/deck');
    if (!Array.isArray(st.slides) || st.slides.filter(Boolean).length === 0) die('当前没有可导出的幻灯片，请先在网页里生成。');
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
      '卷王PPT CLI —— 独立 PPT 生成程序',
      '',
      '  serve [--port=N] [--no-open]   前台启动服务器 + 开浏览器（可用后台任务运行）',
      '  stop                           终止运行中的服务器',
      '  export <out.pptx>              导出当前演示态为 .pptx',
      '',
      '  通用：--port=N 或 KING_PPT_PORT 覆盖服务器定位；KING_PPT_HOME 指定数据根目录',
      '',
      '  生成大纲 / 选模板 / 编辑等均在浏览器里完成。',
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

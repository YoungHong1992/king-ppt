// HTML 自由排版页 → PNG：调用本机 Chrome/Edge headless 截图
// sanitize/wrap 与前端预览共用 public/html-frame.js，保证预览 = 导出
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { sanitize, wrap } = require('../public/html-frame.js');

// 跨平台候选：显式环境变量 > 各平台常见安装路径 > PATH 中的命令名
const CHROME_CANDIDATES = [
  process.env.KING_PPT_CHROME,
  ...(process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ]),
].filter(Boolean);

// PATH 中按命令名探测（各平台安装位置千差万别时的兜底）
const PATH_COMMANDS = process.platform === 'win32'
  ? ['chrome', 'msedge']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

function which(cmd) {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('where', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const p = String(out).split(/\r?\n/)[0].trim();
    return p || null;
  } catch {
    return null;
  }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* 忽略路径探测异常 */ }
  }
  for (const cmd of PATH_COMMANDS) {
    const p = which(cmd);
    if (p) return p;
  }
  throw new Error('未找到可用的 Chrome/Edge。自由排版页导出需要本机安装 Chrome/Chromium/Edge，或设置 KING_PPT_CHROME 环境变量指向浏览器可执行文件。');
}

// html → PNG Buffer（2x 缩放，2560×1440，保证投影/打印清晰度）
async function renderToPng(html, { width = 1280, height = 720, scale = 2 } = {}) {
  const chrome = findChrome();
  const id = `king-ppt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = path.join(os.tmpdir(), `${id}.html`);
  const pngPath = path.join(os.tmpdir(), `${id}.png`);
  fs.writeFileSync(htmlPath, wrap(sanitize(html), { width, height }), 'utf8');
  try {
    await new Promise((resolvePromise, reject) => {
      execFile(chrome, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        '--virtual-time-budget=3000',
        `--screenshot=${pngPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ], { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`浏览器截图失败：${(stderr || err.message).slice(0, 200)}`));
        else resolvePromise();
      });
    });
    return fs.readFileSync(pngPath);
  } finally {
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(pngPath, { force: true });
  }
}

module.exports = { renderToPng, findChrome };

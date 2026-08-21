// Minimal, deterministic HTML -> PNG adapter used for template baking.
// It deliberately uses the installed Chrome/Edge binary instead of adding a
// browser dependency to the application bundle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function browserPath() {
  const candidates = [
    process.env.KING_PPT_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function renderToPng(html, { width = 1280, height = 720, scale = 1, transparent = false } = {}) {
  const browser = browserPath();
  if (!browser) throw new Error('未找到 Chrome/Edge，无法烘焙模板背景');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'king-ppt-shot-'));
  const htmlFile = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.html`);
  const pngFile = path.join(dir, 'page.png');
  const markup = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}*{box-sizing:border-box}</style>${html}`;
  fs.writeFileSync(htmlFile, markup, 'utf8');
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    `--window-size=${Math.ceil(width)},${Math.ceil(height)}`,
    `--force-device-scale-factor=${Math.max(1, Number(scale) || 1)}`,
    // Transparent default background lets a CSS-gradient div screenshot keep its
    // alpha channel — used to bake smooth gradient overlay masks.
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--screenshot=${pngFile}`, `file:///${htmlFile.replace(/\\/g, '/')}`,
  ];
  const result = spawnSync(browser, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  try {
    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(pngFile)) {
      throw new Error(`浏览器截图失败: ${String(result.stderr || result.stdout || '').slice(0, 300)}`);
    }
    return fs.readFileSync(pngFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { renderToPng, browserPath };

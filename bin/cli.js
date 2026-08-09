#!/usr/bin/env node
const { exec } = require('child_process');
const { start } = require('../src/server');

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : (Number(process.env.PORT) || 3210);

start(port).then(({ port: actualPort }) => {
  const url = `http://localhost:${actualPort}`;
  console.log(`\n  卷王PPT 已启动: ${url}\n`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('  提示: 未检测到 OPENAI_API_KEY 环境变量，可在页面右上角临时填写。\n');
  }
  openBrowser(url);
});

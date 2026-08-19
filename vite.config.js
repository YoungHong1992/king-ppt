// Vite 构建配置：源码在 web/，产物直接构建进 public/（Express 原样静态托管，服务端零改动）。
// 开发模式 `npm run dev`：Vite 5173 端口热更新，/api 与 /api/stream(SSE) 反代到运行中的中继服务器 3210。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const RELAY = process.env.KING_PPT_PORT ? `http://localhost:${process.env.KING_PPT_PORT}` : 'http://localhost:3210';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true, // 构建时清空 public/（旧 vanilla 前端由此被彻底替换）
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: RELAY, changeOrigin: true, ws: false },
    },
  },
});

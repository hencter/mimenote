/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri 约定的固定端口：devUrl 与 tauri.conf.json 必须一致。
const DEV_PORT = 1420

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 让 Rust 侧日志与 Vite 日志不互相刷屏
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // src-tauri 的改动由 cargo 负责，避免 Vite 触发无意义的重载
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // WebView2 / WKWebView / WebKitGTK 均可覆盖 Chrome 110 特性
    target: 'chrome110',
    sourcemap: false,
    // 压缩器用 Vite 默认（Vite 8 起为 oxc，esbuild 需单独安装）
    // 单包约 950KB（CodeMirror + React + markdown-it + DOMPurify）：桌面端从本地加载，
    // 无需为网络传输做拆分；M5 若实测冷启动超标再引入分包。
    chunkSizeWarningLimit: 1100,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 公共前置：目前是给 jsdom 补 CodeMirror 需要的 DOM 测量 API（见 tests/setup.ts）。
    // 不补的话，"全部用例通过"的进程仍会因为异步 measure 里的 TypeError 以非零码退出。
    setupFiles: ['tests/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})

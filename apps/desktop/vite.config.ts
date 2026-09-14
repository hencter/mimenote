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
    /**
     * 单个用例的超时（默认 5s 太紧）。
     *
     * 这个仓库有一批用例**挂真编辑器/真预览**（CodeMirror + Live Preview 装饰 + store），
     * 一次要走"装配视图 → 解析语法树 → 建装饰 → 读写 store"：全量套件并行跑（机器上还可能
     * 同时在构建 release 二进制）时，5s 会被这些步骤吃满，表现为
     * `Test timed out in 5000ms` 这种与被测行为完全无关的假红 —— 实测踩过三次
     * （`outline-panel`、`lightbox-gallery`、`editor-live-preview`）。
     *
     * 放宽到 20s 只是**兜底**：真正的判据仍是用例里的断言。语法树解析本身也放宽不了 ——
     * 它按时间预算推进，所以依赖装饰的用例还会显式 `ensureSyntaxTree` 把它逼到完整
     * （见 `live-preview-table.test.tsx` / `editor-live-preview.test.tsx` 的 `decosOf`）。
     */
    testTimeout: 20_000,
    /**
     * 同时跑几个测试文件（默认 = CPU 核数，本机 16）。
     *
     * 为什么要压到 6：这个套件里有一批**挂真编辑器/真预览**的重文件（CodeMirror + Lezer +
     * Live Preview 装饰），16 个文件同时抢 CPU 时它们会互相把对方饿到超时 —— 表现为
     * "全量跑必有一个随机的编辑器用例失败、单独跑必过"。这类假红最贵的地方在于：
     * 它教人忽略红色。压到 6 之后整轮仍然只要一分钟上下（本机实测 40–60s），
     * 换来的是"红色就是真的坏了"。
     */
    maxWorkers: 6,
  },
})

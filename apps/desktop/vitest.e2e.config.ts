/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

/**
 * E2E 专用配置（与单元测试分开，因为要求完全不同）。
 *
 * - `test:e2e:app`：启动真实 release 二进制 + WebView2 CDP（需要先 `tauri build --no-bundle`，仅 Windows）
 * - `test:e2e:ui`：系统 Edge + `dist/` 构建产物 + 内存 Mock Vault（跨平台，适合 CI）
 *
 * 串行执行：GUI 应用 + 固定调试端口，多个实例并行会互相干扰。
 * 超时放宽：应用冷启动 + WebView 就绪 + 防抖保存都要时间。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    restoreMocks: true,
    // 失败时别把 180s 的等待都吞掉：打印到 stdout 便于排查
    silent: false,
  },
})

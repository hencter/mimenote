/** 渲染入口：先完成 bootstrap（主题 + IPC 适配器 + 命令），再挂载 React。 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { bootstrap } from '@/app/bootstrap'
import { App } from '@/App'
import { ErrorBoundary } from '@/components/ErrorBoundary'

import './styles/app.css'

async function start(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('找不到 #root 容器')
  }

  try {
    await bootstrap()
  } catch (cause) {
    // 启动失败也要把界面渲染出来，否则用户只会看到一个空白窗口
    console.error('[bootstrap] 启动失败：', cause)
  }

  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void start()

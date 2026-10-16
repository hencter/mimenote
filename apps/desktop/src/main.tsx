/** 渲染入口：先完成 bootstrap（主题 + IPC 适配器 + 命令），再挂载 React。 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { bootstrap } from '@/app/bootstrap'

/*
 * 样式清单（ADR-0060 §4；B1 把 `styles/app.css` 拆到了这些文件里）。
 *
 * ── 为什么由组合根逐个 import，而不是让 `styles/index.css` 用 `@import` 汇总 ──
 * `scripts/check-architecture.mjs` 的"死样式"判据与 `tests/integration/stylesheets.test.ts` 的"孤儿样式表"判据
 * 都只看 `.ts/.tsx` 里的**路径字面量** —— CSS 内部的 `@import` 不算"有人导入"，汇总文件会把每一份
 * 被汇总的表都变成孤儿。清单写在组合根，还让"这个界面到底加载了哪些表"一眼可见。
 *
 * ── 为什么这段必须排在 `@/App` **之前**，且内部按 tokens → base → components → features 分组 ──
 * 这是**由构造保证的层序**（第二道保险）：打包器按模块求值顺序拼接 CSS，入口自己的 import 先于它
 * 依赖子树的 import。把四层的锚排在 `@/App` 之前，产物里四种层块的**首次出现顺序**天然就是层序，
 * 与 CSS 压缩器怎么处理 `@layer` 无关。实测：把这段挪到 `@/App` 之后，未压缩产物第一段立刻变成
 * `features/trash/trash-dialog.css`（特性层在最前），届时就只能靠声明兜住。这条顺序由
 * `scripts/check-css-layers.mjs` 钉住（源侧查这里的层序单调 + 在 `@/App` 之前，产物侧查真实顺序）。
 *
 * ── 为什么每个样式表顶部还要重复写一遍 `@layer mn.tokens, …;` ──
 * 它是**第一道保险**：开发态（Vite 逐模块注入 `<style>`）与未压缩产物里，层块顺序就是模块顺序，
 * 是那行声明把层序扳正的；压缩器（Vite 8 用 lightningcss）也会**按声明把层块重排**、然后才把这条
 * 已冗余的声明删掉 —— 也就是它没有被忽略，而是被用完之后消掉了。两道保险互不依赖，任一道单独成立
 * 就够；都在，是为了"层序不靠巧合"。
 *
 * 行尾注释写的是该表拥有的 BEM 块 —— `tests/integration/stylesheets.test.ts` 的"导入方真的在用它的类名"
 * 判据靠它建立链接。由组件自己 import 的表（如 `components/ui-controls.css`）不在这里重复列。
 */
import './styles/tokens.css' // 令牌与 VI 别名层（只有变量与 @font-face，没有 .mn-* 规则）
import './styles/base.css' // mn-visually-hidden：选区、元素基座、滚动条、减弱动画
import './components/splitter.css' // mn-splitter
import './components/dialog.css' // mn-dialog mn-overlay
import './components/error-boundary.css' // mn-crash
import './features/layout/shell.css' // mn-app mn-body mn-pane
import './features/shell/toasts.css' // mn-toast mn-toasts
import './features/window/window-controls.css' // mn-window-controls
import './features/vault/tree.css' // mn-tree mn-tree-row mn-tree-toolbar mn-search-field
import './features/vault/vault-gate.css' // mn-gate
import './features/editor/editor-shell.css' // mn-editor
import './features/preview/preview.css' // mn-preview mn-callout mn-task-item mn-image-placeholder mn-wikilink mn-inline-tag
import './features/status/conflict-banner.css' // mn-conflict
import './features/status/status-bar.css' // mn-statusbar mn-status-dot
import './features/links/links-panel.css' // mn-links
import './features/palette/palette.css' // mn-palette mn-overlay--palette

import { App } from '@/App'
import { ErrorBoundary } from '@/components/ErrorBoundary'

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

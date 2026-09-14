/**
 * 应用外壳：布局、全局副作用装配。
 *
 * 布局（可在状态栏切换）：
 * ```
 * ┌──────────── titlebar ────────────┐   flex: 0 0 auto
 * ├─ 冲突横幅（可选，无冲突时不渲染） ─┤   flex: 0 0 auto
 * │ sidebar │ editor │ preview       │   .mn-body → flex: 1 1 auto
 * ├──────────── statusbar ───────────┤   flex: 0 0 auto
 * ```
 *
 * ⚠️ 布局不变式：外壳必须是**列方向 flex**，不能让任何区域依赖"自己是第几个子节点"。
 * 冲突横幅是可选的，用位置化的 `grid-template-rows` 会让主体错位
 * （曾经的真实 bug：主体落到 auto 行、状态栏占掉 1fr 行，窗口下方一片空白，
 * 直到打开笔记把内容撑高才"看起来对齐"）。详见 `styles/app.css` 顶部注释。
 */

import { useEffect, useRef } from 'react'

import { syncSnippets } from '@/app/actions'
import { useGlobalKeymap } from '@/app/keymap'
import { AppMenu } from '@/components/AppMenu'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Icon } from '@/components/Icon'
import { Splitter } from '@/components/Splitter'
import { Toasts } from '@/components/Toasts'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { ExportButton } from '@/features/export/ExportButton'
import { TrashDialog } from '@/features/trash/TrashDialog'
import { WindowControls } from '@/features/window/WindowControls'
import { ExportDialog } from '@/features/export/ExportDialog'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import { DockHost, useVisibleDockModules } from '@/features/dock/DockHost'
import { ImageLightbox } from '@/features/lightbox/ImageLightbox'
import { PaletteHost } from '@/features/palette/PaletteHost'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { ConflictBanner } from '@/features/status/ConflictBanner'
import { StatusBar } from '@/features/status/StatusBar'
import { useWindowTitle } from '@/features/status/window-title'
import { TabBar } from '@/features/tabs/TabBar'
import { VaultGate } from '@/features/vault/VaultGate'
import { formatDuration } from '@/domain/format'
import { subscribeIndexStatus, useLinksStore } from '@/state/links-store'
import { flushAutosave, hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { subscribeVaultChanges, useVaultStore } from '@/state/vault-store'
import { applyTheme, getTheme } from '@/theme/apply'
import { unloadSnippets } from '@/theme/snippets'

export function App() {
  const info = useVaultStore((state) => state.info)
  const rootPath = info?.rootPath ?? null
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const dirty = useNoteStore((state) => state.dirty)
  const saveCount = useNoteStore((state) => state.saveCount)

  const viewMode = useUiStore((state) => state.viewMode)
  const themeId = useUiStore((state) => state.themeId)
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth)
  const setLinksPanelWidth = useUiStore((state) => state.setLinksPanelWidth)
  const setBottomDockHeight = useUiStore((state) => state.setBottomDockHeight)

  /*
    每一区里**可见**的模块：分隔条要据此决定要不要渲染（见下面 `mn-body` 那段注释）。
    可见性仍归各自的开关管（`Ctrl+B` / `Ctrl+Shift+L` / `Ctrl+Shift+T` / `Ctrl+Shift+O`），
    停靠模型只管"它开在哪个区"—— 两件事分开，快捷键与拖拽各改各的，不会互相覆盖。
  */
  const leftModules = useVisibleDockModules('left')
  const rightModules = useVisibleDockModules('right')
  const bottomModules = useVisibleDockModules('bottom')

  const mainRef = useRef<HTMLElement | null>(null)

  useGlobalKeymap()

  // 窗口标题跟着当前笔记与未保存状态（任务栏 / Alt+Tab / 截图里唯一的身份信息）
  useWindowTitle({ relPath, dirty, rootPath })

  // 启动：尝试恢复上次打开的 Vault（失败则停留在门闸页）
  useEffect(() => {
    void useVaultStore.getState().restoreLastVault()
  }, [])

  // 主题：写 CSS 变量 + data-theme
  useEffect(() => {
    applyTheme(getTheme(themeId))
  }, [themeId])

  // Vault CSS 片段：Vault 变化或开关变化时重新同步（可逆副作用）
  useEffect(() => {
    if (rootPath === null) {
      unloadSnippets()
      return
    }
    void syncSnippets(snippetsEnabled, { silent: true })
  }, [rootPath, snippetsEnabled])

  // 每次成功保存后刷新"磁盘真实统计"（宿主侧 Rust 实现）
  useEffect(() => {
    if (saveCount === 0) return
    void useNoteStore.getState().refreshDiskStats()
  }, [saveCount])

  // 链接索引：订阅宿主的进度事件（浏览器预览模式下自动降级）
  useEffect(() => subscribeIndexStatus(), [])

  // 外部改动（资源管理器 / 别的编辑器 / 同步盘）：订阅宿主的事件，
  // 收到后重扫条目表并让当前笔记跟随磁盘（ADR-0016）。浏览器预览模式下自动降级。
  useEffect(() => subscribeVaultChanges(), [])

  // 打开笔记 → 拉取它的出链与反向链接
  useEffect(() => {
    void useLinksStore.getState().refresh(relPath)
  }, [relPath])

  // 打开/关闭 Vault → 同步索引状态
  useEffect(() => {
    if (rootPath === null) {
      useLinksStore.getState().clear()
      return
    }
    void useLinksStore.getState().refreshStatus()
  }, [rootPath])

  // 保存后若链接面板可见，刷新一次（正文里的链接可能变了）
  useEffect(() => {
    if (saveCount === 0 || relPath === null) return
    if (!useUiStore.getState().linksPanelVisible) return
    void useLinksStore.getState().refresh(relPath)
  }, [saveCount, relPath])

  // 未保存内容保护：关闭窗口前拦截 + 失焦/隐藏时立即落盘
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!hasUnsavedChanges()) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onBlur = (): void => {
      flushAutosave()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushAutosave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // 窗口标题反映当前文档与未保存状态
  useEffect(() => {
    document.title =
      relPath === null ? 'Mimenote' : `${dirty ? '● ' : ''}${relPath} — Mimenote`
  }, [relPath, dirty])

  if (info === null) {
    return (
      <>
        <VaultGate />
        <ConfirmDialog />
        {/* 门闸页没有标题栏，这里是"未打开 Vault 时也能进设置/改主题"的唯一入口；
            组件在关闭时自己返回 null，但 effect 仍活着（字号与自动保存延迟靠它维护），
            所以**不能**写成条件挂载。 */}
        <SettingsDialog />
        {/* 导出的目标路径只能由用户在系统保存对话框里选，门闸页也要能打开（会说明"还没有打开 Vault"）；
            必须常驻挂载：它同时是导出命令的进度面板与打印样式的挂载点 */}
        <ExportDialog />
        {/* 门闸页也挂面板：Ctrl+K / Ctrl+P 在没有 Vault 时同样要能打开
            （命令面板把依赖 Vault 的命令置灰，快速切换给"还没有打开 Vault"空态） */}
        <PaletteHost />
        <Toasts />
      </>
    )
  }

  const previewStyle = { flex: '1 1 auto' }
  const editorStyle = { flex: '1 1 auto' }

  return (
    <div className="mn-app">
      {/*
        自绘标题栏：`decorations: false` 之后它就是**唯一的**标题栏（见 features/window 的文档）。
        `data-tauri-drag-region="deep"` 让整条栏都能拖动窗口、双击即最大化 —— Tauri 注入的脚本
        会自动跳过 button/input/a 这类可点击元素，所以菜单与窗口按钮照常可用。
      */}
      <header className="mn-titlebar" data-tauri-drag-region="deep">
        <AppMenu />
        <div className="mn-titlebar__brand">
          <Icon name="sparkle" size={15} />
          <span>Mimenote</span>
        </div>
        <div className="mn-titlebar__vault" title={info.rootPath}>
          {info.name}
        </div>
        <div className="mn-titlebar__meta">
          {info.noteCount} 篇笔记 · {info.entryCount} 条目 · 扫描 {formatDuration(info.scanMs)}
          {info.truncated && ' · 已截断'}
        </div>
        <ExportButton />
        <WindowControls />
      </header>

      {/*
        标签栏在**窗口顶部**、横跨全宽（在标题栏之下、侧栏之上）：
        它是"我开着哪几篇笔记"的全局信息，属于窗口而不是某一块面板 ——
        挂在 `.mn-main` 里时，它会跟着主区域一起被侧栏挤窄（用户要的就是这一点改变）。
      */}
      <TabBar />

      <ConflictBanner />

      {/*
        主体 = 左停靠区 | 主区域（+ 底部停靠区） | 右停靠区。
        每块视图模块（文件树 / 链接 / 标签 / 大纲）都能被拖到任意一个区里
        （见 `features/dock/`），所以这里不再按"某个面板固定在左、某个固定在右"来排布。
        分隔条只在对应停靠区**有可见模块**时渲染 —— 否则会画出一条拖不动任何东西的线。
      */}
      <div className="mn-body">
        <DockHost side="left" />
        {leftModules.length > 0 && (
          <Splitter
            ariaLabel="调整侧栏宽度"
            onDrag={(event) => setSidebarWidth(event.clientX)}
            onNudge={(delta) => setSidebarWidth(useUiStore.getState().sidebarWidth + delta)}
          />
        )}

        {/* 中间那一列：主区域在上、底部停靠区在下（列方向，主区域永远吃满剩余高度） */}
        <div className="mn-center">
          {/* 主区域只有三种形态：所见即所得编辑 / 只读预览 / 知识图谱。
              "分栏（编辑 + 预览并排）"已移除 —— 编辑器本身就是所见即所得的（ADR-0009）。 */}
          <main className="mn-main" ref={mainRef}>
            {viewMode === 'edit' && (
              <section className="mn-pane mn-pane--editor" style={editorStyle}>
                <MarkdownEditor />
              </section>
            )}

            {viewMode === 'read' && (
              <section className="mn-pane" style={previewStyle}>
                <MarkdownPreview />
              </section>
            )}

            {viewMode === 'graph' && (
              <section className="mn-pane mn-pane--graph" style={previewStyle}>
                <GraphCanvas />
              </section>
            )}
          </main>

          {bottomModules.length > 0 && (
            <Splitter
              orientation="horizontal"
              ariaLabel="调整底部停靠区高度"
              onDrag={(event) => setBottomDockHeight(window.innerHeight - event.clientY)}
              onNudge={(delta) =>
                setBottomDockHeight(useUiStore.getState().bottomDockHeight - delta)
              }
            />
          )}
          <DockHost side="bottom" />
        </div>

        {rightModules.length > 0 && (
          <Splitter
            ariaLabel="调整右侧面板宽度"
            onDrag={(event) => setLinksPanelWidth(window.innerWidth - event.clientX)}
            onNudge={(delta) => setLinksPanelWidth(useUiStore.getState().linksPanelWidth - delta)}
          />
        )}
        <DockHost side="right" />
      </div>

      <StatusBar />
      <ConfirmDialog />
      <PaletteHost />
      <Toasts />
      {/* 图片灯箱：自己监听预览里的图片点击（document 捕获阶段），预览不需要转发事件。
          挂在 `.mn-app` 的直接子节点：fixed 定位不被祖先的 overflow 裁剪，层级也压得住对话框。 */}
      <ImageLightbox />
      <SettingsDialog />
      <ExportDialog />
      <TrashDialog />
    </div>
  )
}

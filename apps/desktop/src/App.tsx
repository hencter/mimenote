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
import { ExportDialog } from '@/features/export/ExportDialog'
import { GraphCanvas } from '@/features/graph/GraphCanvas'
import { LinksPanel } from '@/features/links/LinksPanel'
import { ImageLightbox } from '@/features/lightbox/ImageLightbox'
import { OutlinePanel } from '@/features/outline/OutlinePanel'
import { PaletteHost } from '@/features/palette/PaletteHost'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { ConflictBanner } from '@/features/status/ConflictBanner'
import { StatusBar } from '@/features/status/StatusBar'
import { useWindowTitle } from '@/features/status/window-title'
import { TabBar } from '@/features/tabs/TabBar'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { FileTree } from '@/features/vault/FileTree'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { VaultGate } from '@/features/vault/VaultGate'
import { formatDuration } from '@/domain/format'
import { subscribeIndexStatus, useLinksStore } from '@/state/links-store'
import { flushAutosave, hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { applyTheme, getTheme } from '@/theme/apply'
import { unloadSnippets } from '@/theme/snippets'

export function App() {
  const info = useVaultStore((state) => state.info)
  const rootPath = info?.rootPath ?? null
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const dirty = useNoteStore((state) => state.dirty)
  const saveCount = useNoteStore((state) => state.saveCount)

  const sidebarVisible = useUiStore((state) => state.sidebarVisible)
  const sidebarWidth = useUiStore((state) => state.sidebarWidth)
  const viewMode = useUiStore((state) => state.viewMode)
  const themeId = useUiStore((state) => state.themeId)
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)
  const linksPanelVisible = useUiStore((state) => state.linksPanelVisible)
  const linksPanelWidth = useUiStore((state) => state.linksPanelWidth)
  const outlinePanelVisible = useUiStore((state) => state.outlinePanelVisible)
  const tagsPanelVisible = useTagsStore((state) => state.open)
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth)
  const setLinksPanelWidth = useUiStore((state) => state.setLinksPanelWidth)

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
      <header className="mn-titlebar">
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
      </header>

      <ConflictBanner />

      <div className="mn-body">
        {sidebarVisible && (
          <>
            <aside className="mn-sidebar" style={{ width: sidebarWidth }}>
              <TreeToolbar />
              <FileTree />
            </aside>
            <Splitter
              ariaLabel="调整侧栏宽度"
              onDrag={(event) => setSidebarWidth(event.clientX)}
              onNudge={(delta) => setSidebarWidth(useUiStore.getState().sidebarWidth + delta)}
            />
          </>
        )}

        {/* 主区域只有三种形态：所见即所得编辑 / 只读预览 / 知识图谱。
            "分栏（编辑 + 预览并排）"已移除 —— 编辑器本身就是所见即所得的（ADR-0009）。 */}
        <main className="mn-main" ref={mainRef}>
          {/* 标签栏必须是 `.mn-main` 的**第一个子节点**：`tabs.css` 用
              `.mn-main:has(> .mn-tabs)` 条件地把主区域改成列方向（没有标签时逐像素不变，
              所以"主体吃掉剩余高度"的布局契约与 E2E 断言都不受影响）。 */}
          <TabBar />
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

        {linksPanelVisible && (
          <>
            <Splitter
              ariaLabel="调整链接面板宽度"
              onDrag={(event) => setLinksPanelWidth(window.innerWidth - event.clientX)}
              onNudge={(delta) =>
                setLinksPanelWidth(useUiStore.getState().linksPanelWidth - delta)
              }
            />
            <div className="mn-links-host" style={{ width: linksPanelWidth }}>
              <LinksPanel />
            </div>
          </>
        )}

        {/* 标签面板：宽度由自己的样式固定（内容窄，不需要拖拽分隔条） */}
        {tagsPanelVisible && <TagsPanel />}

        {/* 大纲面板：同上（固定宽度），放在最右侧 —— 它描述的是"主区域里这篇笔记的结构" */}
        {outlinePanelVisible && <OutlinePanel />}
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
    </div>
  )
}

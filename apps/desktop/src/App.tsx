/**
 * 应用外壳：布局、全局副作用装配。
 *
 * 布局（可在状态栏切换）：
 * ```
 * ┌──────────── titlebar ────────────┐
 * ├─ 冲突横幅（按需） ─────────────────┤
 * │ sidebar │ editor │ preview       │
 * ├──────────── statusbar ───────────┤
 * ```
 */

import { useEffect, useRef } from 'react'

import { syncSnippets } from '@/app/actions'
import { useGlobalKeymap } from '@/app/keymap'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Icon } from '@/components/Icon'
import { Splitter } from '@/components/Splitter'
import { Toasts } from '@/components/Toasts'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { ConflictBanner } from '@/features/status/ConflictBanner'
import { StatusBar } from '@/features/status/StatusBar'
import { FileTree } from '@/features/vault/FileTree'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { VaultGate } from '@/features/vault/VaultGate'
import { formatDuration } from '@/domain/format'
import { flushAutosave, hasUnsavedChanges, useNoteStore } from '@/state/note-store'
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
  const previewRatio = useUiStore((state) => state.previewRatio)
  const themeId = useUiStore((state) => state.themeId)
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth)
  const setPreviewRatio = useUiStore((state) => state.setPreviewRatio)

  const mainRef = useRef<HTMLElement | null>(null)

  useGlobalKeymap()

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
        <Toasts />
      </>
    )
  }

  const previewStyle = viewMode === 'split' ? { flexBasis: `${previewRatio * 100}%` } : { flex: '1 1 auto' }
  const editorStyle =
    viewMode === 'split' ? { flexBasis: `${(1 - previewRatio) * 100}%` } : { flex: '1 1 auto' }

  return (
    <div className="mn-app">
      <header className="mn-titlebar">
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

        <main className="mn-main" ref={mainRef}>
          {viewMode !== 'preview' && (
            <section className="mn-pane mn-pane--editor" style={editorStyle}>
              <MarkdownEditor />
            </section>
          )}

          {viewMode === 'split' && (
            <Splitter
              ariaLabel="调整预览宽度"
              onDrag={(event) => {
                const rect = mainRef.current?.getBoundingClientRect()
                if (rect === undefined || rect.width === 0) return
                setPreviewRatio((event.clientX - rect.left) / rect.width)
              }}
              onNudge={(delta) => {
                const width = mainRef.current?.clientWidth ?? 0
                if (width === 0) return
                setPreviewRatio(useUiStore.getState().previewRatio + delta / width)
              }}
            />
          )}

          {viewMode !== 'editor' && (
            <section className="mn-pane" style={previewStyle}>
              <MarkdownPreview />
            </section>
          )}
        </main>
      </div>

      <StatusBar />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

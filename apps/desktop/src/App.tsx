/**
 * 应用外壳：布局、全局副作用装配。
 *
 * 布局（容器切割树，ADR-0035）：
 * ```
 * ┌──────────── titlebar ────────────┐   flex: 0 0 auto
 * ├─ 冲突横幅（可选，无冲突时不渲染） ─┤   flex: 0 0 auto
 * │  TreeHost（二叉切割树）           │   .mn-body → flex: 1 1 auto
 * ├──────────── statusbar ───────────┤   flex: 0 0 auto
 * ```
 *
 * ⚠️ 布局不变式：外壳必须是**列方向 flex**，不能让任何区域依赖"自己是第几个子节点"。
 * 冲突横幅是可选的，用位置化的 `grid-template-rows` 会让主体错位
 * （曾经的真实 bug：主体落到 auto 行、状态栏占掉 1fr 行，窗口下方一片空白，
 * 直到打开笔记把内容撑高才"看起来对齐"）。详见 `styles/app.css` 顶部注释。
 */

import { useEffect } from 'react'

import { syncSnippets } from '@/app/actions'
import { useGlobalKeymap } from '@/app/keymap'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Icon } from '@/components/Icon'
import { Toasts } from '@/components/Toasts'
import { ExportButton } from '@/features/export/ExportButton'
import { TrashDialog } from '@/features/trash/TrashDialog'
import { WindowControls } from '@/features/window/WindowControls'
import { ExportDialog } from '@/features/export/ExportDialog'
import { ImageLightbox } from '@/features/lightbox/ImageLightbox'
import { PaletteHost } from '@/features/palette/PaletteHost'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { ConflictBanner } from '@/features/status/ConflictBanner'
import { StatusBar } from '@/features/status/StatusBar'
import { useWindowTitle } from '@/features/status/window-title'
import { TreeHost } from '@/features/layout/TreeHost'
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

  const themeId = useUiStore((state) => state.themeId)
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)

  useGlobalKeymap()

  // 窗口标题跟着当前笔记与未保存状态（任务栏 / Alt+Tab / 截图里唯一的身份信息）
  useWindowTitle({ relPath, dirty, rootPath })

  // 启动：尝试恢复上次打开的 Vault（失败则停留在门闸页）
  useEffect(() => {
    void useVaultStore.getState().restoreLastVault()
  }, [])

  // 换 Vault 时关掉附件查看器：那个文件属于**上一个** Vault
  useEffect(() => {
    useUiStore.getState().closeFile()
  }, [rootPath])

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

  return (
    <div className="mn-app">
      {/*
        自绘标题栏（`decorations: false` 之后它是**唯一的**标题栏），一行装下窗口的顶级信息：
        品牌 / 库名 · （中区留空，是纯拖动区）· 统计 / 导出 · 三个窗口按钮。

        - 文件标签**曾经**住在中区（ADR-0034）；容器切割树（ADR-0035）之后，笔记标签与
          模块标签一样是"某一格的标签"，全局标签栏随之退役 —— 中区回归纯拖动区；
        - `data-tauri-drag-region="deep"` 让整条栏都能拖动窗口、双击即最大化；
        - 当前笔记/附件的路径不在这一行 —— 它在状态栏最左（`data-main-path`）。
      */}
      <header className="mn-titlebar" data-tauri-drag-region="deep">
        {/* 左区 = "我在哪个库"：产品名、当前 Vault */}
        <div className="mn-titlebar__left">
          <div className="mn-titlebar__brand">
            <Icon name="sparkle" size="md" />
            <span>Mimenote</span>
          </div>
          <div className="mn-titlebar__vault" title={info.rootPath}>
            {info.name}
          </div>
        </div>

        {/* 中区 = 纯拖动区（ADR-0035 之后标签进了各自的格子，全局标签栏退役） */}
        <div className="mn-titlebar__center" />

        {/* 右区 = "这个库有多大" + 出口动作：统计、导出、三个窗口按钮 */}
        <div className="mn-titlebar__right">
          <div className="mn-titlebar__meta">
            {info.noteCount} 篇笔记 · {info.entryCount} 条目 · 扫描 {formatDuration(info.scanMs)}
            {info.truncated && ' · 已截断'}
          </div>
          <ExportButton />
          <WindowControls />
        </div>
      </header>


      <ConflictBanner />

      {/*
        主体 = 容器切割树（ADR-0035）：每个格子都是"标签 + 内容"，笔记与视图模块
        都是可拖的标签；格子之间的分隔条调比例、双击均分。旧的三区停靠
        （`features/dock/`）已被它取代，`dockLayout` 落盘键只留作回滚可读。
      */}
      <div className="mn-body">
        <TreeHost />
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

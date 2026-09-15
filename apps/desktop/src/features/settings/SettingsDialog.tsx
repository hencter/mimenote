/**
 * 设置对话框（占满窗口的模态：左侧分区导航 + 右侧内容）。
 *
 * 键盘与焦点（与 `ConfirmDialog` / `RenameDialog` 同一套约定）：
 * - `Esc` 关闭。用**捕获阶段**的 window 监听：与焦点在哪无关，且 `preventDefault()`
 *   之后 `app/keymap.ts` 的全局快捷键会跳过（它第一件事就是查 `defaultPrevented`）；
 * - 打开时焦点进入对话框、关闭后归还给"打开它的那个元素"（键盘用户不会掉焦点）；
 * - `Tab` 在对话框内部循环（模态占满窗口，焦点跑到遮罩后面的控件上会很困惑）。
 *
 * 生效方式（store 存值 → 这里落到 DOM / 编辑器流水线）：
 * - 字号 → `font-overrides.ts`（CSS 变量，不重建编辑器）；
 * - 自动保存延迟 → `configureAutosave()`；
 * - 主题 → 只改 `ui-store.themeId`，由 `App` 里的 `applyTheme` effect 统一应用
 *   （不在这里再写一条 applyTheme 路径，否则主题的生效点就有两处）。
 */

import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon, type IconName } from '@/components/Icon'
import { useConfirmStore } from '@/state/confirm-store'
import { configureAutosave } from '@/state/note-store'
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTIONS_META,
  useSettingsStore,
  type SettingsSection,
} from '@/state/settings-store'

import { AboutSection } from './AboutSection'
import { AppearanceSection } from './AppearanceSection'
import { EditorSection } from './EditorSection'
import { VaultSection } from './VaultSection'
import { applyAppearanceOverrides, clearAppearanceOverrides } from './font-overrides'

import './settings.css'

const SECTION_ICONS: Record<SettingsSection, IconName> = {
  appearance: 'palette',
  editor: 'pencil',
  vault: 'folder',
  about: 'info',
}

const PANEL_ID = 'mn-settings-panel'

function tabId(section: SettingsSection): string {
  return `mn-settings-tab-${section}`
}

/** 对话框内可聚焦的元素（Tab 循环用）。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function SettingsDialog() {
  const open = useSettingsStore((state) => state.open)
  const section = useSettingsStore((state) => state.section)
  const setSection = useSettingsStore((state) => state.setSection)
  const closeSettings = useSettingsStore((state) => state.closeSettings)

  const uiFontSize = useSettingsStore((state) => state.uiFontSize)
  const editorFontSize = useSettingsStore((state) => state.editorFontSize)
  const readingFontSize = useSettingsStore((state) => state.readingFontSize)
  const tabWidth = useSettingsStore((state) => state.tabWidth)
  const autosaveDelayMs = useSettingsStore((state) => state.autosaveDelayMs)
  const versionInfo = useSettingsStore((state) => state.versionInfo)
  const versionError = useSettingsStore((state) => state.versionError)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** 打开前聚焦的元素：关闭时还给它（`RenameDialog` 的同一写法）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  const close = useCallback((): void => {
    closeSettings()
  }, [closeSettings])

  // 字号 / Tab 宽度 → CSS 变量。卸载时整体撤掉（可逆副作用），字号回落到主题令牌。
  useEffect(() => {
    applyAppearanceOverrides({ uiFontSize, editorFontSize, readingFontSize, tabWidth })
    return clearAppearanceOverrides
  }, [uiFontSize, editorFontSize, readingFontSize, tabWidth])

  // 自动保存延迟 → 写盘流水线。卸载**不**恢复默认：这里只是把已持久化的偏好喂给
  // note-store 的模块级参数，没有注册任何监听或定时器需要撤销。
  useEffect(() => {
    configureAutosave({ delayMs: autosaveDelayMs })
  }, [autosaveDelayMs])

  // "关于"页需要版本信息：进入该分区时才拉取一次（失败可点「重新读取」）
  useEffect(() => {
    if (!open || section !== 'about') return
    if (versionInfo !== null || versionError !== null) return
    void useSettingsStore.getState().loadVersionInfo()
  }, [open, section, versionInfo, versionError])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 二次确认框叠在设置之上时，Esc 归确认框（同 RenameDialog 对命令面板的守卫）：
      // 否则一次 Esc 会同时关掉两层，用户不知道哪个"确定"被取消了
      if (useConfirmStore.getState().request !== null) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close])

  // 焦点：打开时进入对话框、关闭后归还
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = typeof document === 'undefined' ? null : document.activeElement
      restoreFocusRef.current = active instanceof HTMLElement ? active : null
      dialogRef.current?.focus()
    } else if (!open && wasOpenRef.current) {
      const previous = restoreFocusRef.current
      restoreFocusRef.current = null
      // 原元素可能已经不在了（例如打开的按钮所在的面板被卸载）→ 归还前确认仍在文档里
      if (previous !== null && previous.isConnected) previous.focus()
    }
    wasOpenRef.current = open
  }, [open])

  if (!open) return null

  const focusTab = (next: SettingsSection): void => {
    setSection(next)
    // 焦点跟着分区走（自动激活式 tablist 的约定），键盘用户可以一路按方向键浏览
    document.getElementById(tabId(next))?.focus()
  }

  const onTablistKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const index = SETTINGS_SECTIONS.indexOf(section)
    const last = SETTINGS_SECTIONS.length - 1
    const current = index === -1 ? 0 : index
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        event.preventDefault()
        const next = SETTINGS_SECTIONS[Math.min(last, current + 1)]
        if (next !== undefined) focusTab(next)
        return
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        event.preventDefault()
        const next = SETTINGS_SECTIONS[Math.max(0, current - 1)]
        if (next !== undefined) focusTab(next)
        return
      }
      case 'Home': {
        event.preventDefault()
        const first = SETTINGS_SECTIONS[0]
        if (first !== undefined) focusTab(first)
        return
      }
      case 'End': {
        event.preventDefault()
        const lastSection = SETTINGS_SECTIONS[last]
        if (lastSection !== undefined) focusTab(lastSection)
        return
      }
      default:
        return
    }
  }

  /** Tab 循环：模态占满窗口，焦点不该跑到遮罩后面的标题栏/状态栏上。 */
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    // 不做可见性过滤：对话框里没有隐藏控件，而 `offsetParent` 这类布局属性在 jsdom 里
    // 恒为 null，用它过滤会让"键盘循环"在测试里失效（真实浏览器与测试必须走同一条路径）
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const meta = SETTINGS_SECTIONS_META[section]

  return (
    <div className="mn-overlay mn-overlay--settings" role="presentation" onClick={close}>
      <div
        className="mn-settings"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <header className="mn-settings__header">
          <Icon name="settings" size="md" />
          <h2>设置</h2>
          <span className="mn-settings__header-spacer" />
          <kbd>Esc</kbd>
          <button
            type="button"
            className="mn-icon-button"
            aria-label="关闭设置"
            title="关闭设置（Esc）"
            onClick={close}
          >
            <Icon name="x" size="md" />
          </button>
        </header>

        <div className="mn-settings__body">
          <nav className="mn-settings__nav">
            <ul
              className="mn-settings__nav-list"
              role="tablist"
              aria-orientation="vertical"
              aria-label="设置分区"
              onKeyDown={onTablistKeyDown}
            >
              {SETTINGS_SECTIONS.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    id={tabId(id)}
                    role="tab"
                    aria-selected={id === section}
                    aria-controls={PANEL_ID}
                    className={
                      id === section
                        ? 'mn-settings__nav-item mn-settings__nav-item--active'
                        : 'mn-settings__nav-item'
                    }
                    title={SETTINGS_SECTIONS_META[id].description}
                    onClick={() => setSection(id)}
                  >
                    <Icon name={SECTION_ICONS[id]} size="sm" />
                    {SETTINGS_SECTIONS_META[id].label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div
            className="mn-settings__panel"
            id={PANEL_ID}
            role="tabpanel"
            aria-labelledby={tabId(section)}
            tabIndex={0}
          >
            <p className="mn-visually-hidden">{meta.description}</p>
            {section === 'appearance' && <AppearanceSection />}
            {section === 'editor' && <EditorSection />}
            {section === 'vault' && <VaultSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

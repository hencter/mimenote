// @vitest-environment jsdom
/**
 * 设置页与应用菜单。
 *
 * 覆盖三件事：
 * 1. **菜单是命令注册表的可发现视图**：按分类列出全部命令、显示快捷键、点击即执行
 *    （执行结果落在可观测的副作用上：视图模式、主题、设置对话框）；
 * 2. **设置项的生效链路**：字号 → CSS 变量（不重建编辑器）、自动保存延迟 → 写盘时机、
 *    Tab 宽度、主题、片段开关、索引状态与两个按钮；
 * 3. **持久化**：改动落到 localStorage，重新载入模块后读回上次的值与分区。
 *
 * 断言尽量落在可观测的副作用上（store 状态、DOM、localStorage、CSS 变量、IPC 调用），
 * 而不是实现细节：换实现（例如把 `<select>` 换成单选组）不该让这些用例变红。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import { AppMenu } from '@/components/AppMenu'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { configureAutosave, useNoteStore } from '@/state/note-store'
import {
  DEFAULT_SETTINGS,
  READING_FONT_SIZE_RANGE,
  SETTINGS_SECTION_KEY,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { DEFAULT_THEME_ID } from '@/theme/apply'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 记录 IPC 方法名，其余原样转发给 Mock 适配器（`tests/search.test.tsx` 的同一手法）。 */
function spyOnIpc(base: MockAdapter): { adapter: IpcAdapter; calls: string[] } {
  const calls: string[] = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      calls.push(method)
      return base.invoke<T>(method, args)
    },
  }
  return { adapter, calls }
}

/**
 * 渲染外壳的两个新增部分（标题栏菜单 + 设置对话框）。
 *
 * 刻意**不**渲染整个 `<App />`：这两个组件由 `App.tsx` 挂载（本次改动不碰那个文件），
 * 这里直接渲染它们才能独立验证；顺序与将来的真实挂载一致。
 */
function renderShell(): void {
  render(
    <>
      <AppMenu />
      <SettingsDialog />
    </>,
  )
}

function menuButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: '应用菜单' })
}

function openMenu(): HTMLElement {
  fireEvent.click(menuButton())
  return screen.getByRole('menu', { name: '应用菜单' })
}

async function openVault(): Promise<void> {
  await act(async () => {
    await useVaultStore.getState().openVault('C:\\MockVault')
  })
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  registerBuiltinCommands()
  window.localStorage.clear()
  configureAutosave({ delayMs: DEFAULT_SETTINGS.autosaveDelayMs })
  useNoteStore.getState().close()
  // 只重置与本文件相关的那几项：视图模式之类与本功能无关，不做耦合（避免别处重构把它带红）
  useUiStore.setState({
    paletteMode: null,
    linksPanelVisible: false,
    sidebarVisible: true,
    themeId: DEFAULT_THEME_ID,
    snippetsEnabled: true,
  })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
  useLinksStore.setState({
    status: { phase: 'ready', indexed: 12, total: 12, durationMs: 5, links: 9 },
    links: null,
    loading: false,
    error: null,
  })
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    open: false,
    section: 'appearance',
    versionInfo: null,
    versionError: null,
  })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// 应用菜单
// ---------------------------------------------------------------------------

describe('应用菜单', () => {
  it('点击菜单按钮弹出：设置入口 + 按分类分组的全部命令（标题 + 快捷键）', () => {
    renderShell()
    expect(screen.queryByRole('menu')).toBeNull()

    const menu = openMenu()

    // 数据源就是命令注册表：注册表里的 `settings.open` 由顶部那条固定入口代表
    // （菜单会跳过它，避免同一条命令出现两次），所以条数 = 全部命令。
    const expected = commands.list()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(expected.length)

    // 设置入口排在第一位（不该埋在按字典序排的分类里）
    const items = within(menu).getAllByRole('menuitem')
    expect(items[0]?.textContent).toContain('设置…')

    // 分类名与命令都在，快捷键按平台格式化（jsdom 不是 macOS → Mod 显示为 Ctrl）
    expect(within(menu).getAllByText('外观').length).toBeGreaterThan(0)
    expect(within(menu).getAllByText('视图').length).toBeGreaterThan(0)
    expect(within(menu).getByText('切换主题')).toBeTruthy()
    expect(within(menu).getByText('Ctrl+Alt+T')).toBeTruthy()
    expect(within(menu).getByText('显示 / 隐藏侧栏')).toBeTruthy()
    expect(within(menu).getByText('Ctrl+B')).toBeTruthy()
  })

  it('点击命令即执行（视图状态改变），并关掉菜单', () => {
    renderShell()
    const menu = openMenu()
    expect(useUiStore.getState().sidebarVisible).toBe(true)

    fireEvent.click(within(menu).getByText('显示 / 隐藏侧栏'))

    expect(useUiStore.getState().sidebarVisible).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('点击「切换主题」走同一个注册表：themeId 真的变了', () => {
    renderShell()
    const menu = openMenu()
    const before = useUiStore.getState().themeId

    fireEvent.click(within(menu).getByText('切换主题'))

    expect(useUiStore.getState().themeId).not.toBe(before)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('↑↓ 移动高亮、Enter 执行；Esc 关闭并把焦点还给菜单按钮', async () => {
    renderShell()
    const menu = openMenu()
    // 打开即聚焦弹出层（键盘不需要先 Tab 进来）
    expect(document.activeElement).toBe(menu)
    expect(menu.getAttribute('aria-activedescendant')).toBe('mn-appmenu-item-0')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(menu.getAttribute('aria-activedescendant')).toBe('mn-appmenu-item-1')
    })
    // 高亮跟着走：第 1 行是注册表里的第一条命令
    expect(document.getElementById('mn-appmenu-item-1')?.dataset['menuId']).toBe(
      commands.list()[0]?.id,
    )

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(menu.getAttribute('aria-activedescendant')).toBe('mn-appmenu-item-0')
    })

    // 回到第 0 行（设置…）后回车：真的打开了设置
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()

    // 关掉设置，回到菜单测 Esc 的焦点归还
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    fireEvent.click(menuButton())
    const reopened = screen.getByRole('menu', { name: '应用菜单' })
    fireEvent.keyDown(reopened, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(menuButton())
  })

  it('点击菜单外部关闭', () => {
    renderShell()
    openMenu()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('菜单里的「设置…」能打开设置对话框', () => {
    renderShell()
    const menu = openMenu()

    fireEvent.click(within(menu).getByText('设置…'))

    expect(useSettingsStore.getState().open).toBe(true)
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
  })

  it('未打开 Vault 时依赖 Vault 的命令置灰并给出原因，点了也不关菜单', () => {
    renderShell()
    const menu = openMenu()

    const item = menu.querySelector('[data-menu-id="vault.rescan"]')
    expect(item).not.toBeNull()
    expect(item?.getAttribute('aria-disabled')).toBe('true')
    expect(item?.textContent).toContain('需要先打开 Vault')

    fireEvent.click(item as Element)
    // 置灰项点不动，也不该把菜单关掉（否则用户会以为是自己点错了）
    expect(screen.queryByRole('menu')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 设置对话框
// ---------------------------------------------------------------------------

describe('设置对话框', () => {
  it('openSettings 打开、焦点进入；Esc 关闭并把焦点归还给打开它的元素', async () => {
    renderShell()
    // 从菜单进去：菜单按钮就是"打开它的元素"，Esc 后焦点该回到它
    const menu = openMenu()
    fireEvent.click(within(menu).getByText('设置…'))

    const dialog = screen.getByRole('dialog', { name: '设置' })
    await waitFor(() => {
      expect(document.activeElement).toBe(dialog)
    })

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useSettingsStore.getState().open).toBe(false)
    expect(document.activeElement).toBe(menuButton())
  })

  it('点遮罩关闭（点对话框内部不关）', async () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    const dialog = screen.getByRole('dialog', { name: '设置' })

    fireEvent.click(dialog)
    expect(screen.queryByRole('dialog')).not.toBeNull()

    // 遮罩是对话框的父节点（`role="presentation"`）
    fireEvent.click(dialog.parentElement as Element)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('分区切换：外观 / 编辑器 / Vault / 关于（版本、Vault 统计、日志位置）', async () => {
    await openVault()
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })

    const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
    expect(tab('外观').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('配色主题')).toBeTruthy()

    fireEvent.click(tab('编辑器'))
    expect(tab('编辑器').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('自动保存延迟')).toBeTruthy()
    expect(screen.getByLabelText('Tab 宽度')).toBeTruthy()

    fireEvent.click(tab('Vault'))
    expect(screen.getByLabelText('启用 Vault CSS 片段')).toBeTruthy()
    expect(screen.getByLabelText('重新扫描 Vault')).toBeTruthy()
    expect(screen.getByLabelText('刷新索引状态')).toBeTruthy()
    // 索引状态直接读 links-store
    expect(screen.getByText('就绪')).toBeTruthy()
    expect(screen.getByText('12 / 12 篇')).toBeTruthy()

    fireEvent.click(tab('关于'))
    // 版本信息经 store 走 IPC（Mock 返回 app / mn-core / tauri 都是 0.1.0，因此可能多条）
    expect((await screen.findAllByText('0.1.0')).length).toBeGreaterThan(0)
    const info = useVaultStore.getState().info
    expect(info).not.toBeNull()
    expect(screen.getByText(new RegExp(`${info?.entryCount ?? -1} 条目`))).toBeTruthy()
    expect(
      screen.getByText(/%LOCALAPPDATA%\\app\.mimenote\.desktop\\logs\\mimenote\.log/),
    ).toBeTruthy()
  })

  it('编辑器字号：写到 CSS 变量、落到 localStorage、关闭再打开读回', async () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })

    const range = screen.getByLabelText<HTMLInputElement>('编辑器字号')
    expect(range.value).toBe(String(DEFAULT_SETTINGS.editorFontSize))
    fireEvent.change(range, { target: { value: '18' } })

    // 1. 生效：CSS 变量（编辑器与预览正文都引用它，因此不需要重建编辑器）
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-editor')).toBe('18px')
    // 同时注入一条 !important 的作者样式规则：`applyTheme` 会整批重写内联令牌，
    // 只有样式表里的 important 声明才不会被主题覆盖回去
    expect(document.getElementById('mn-settings-font-overrides')?.textContent).toContain(
      '--mn-font-size-editor: 18px !important',
    )
    expect(screen.getByText('18px')).toBeTruthy()

    // 2. 持久化：落到 localStorage 的 JSON
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      editorFontSize?: number
    }
    expect(saved.editorFontSize).toBe(18)

    // 3. 关闭再打开：值还在（store 是唯一事实来源）
    act(() => {
      useSettingsStore.getState().closeSettings()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    expect(screen.getByLabelText<HTMLInputElement>('编辑器字号').value).toBe('18')
  })

  it('重新载入模块后从 localStorage 读回上次的字号与分区', async () => {
    // store 在模块初始化时读回持久化值：只有新的模块实例才观察得到这件事
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ uiFontSize: 16, editorFontSize: 21, autosaveDelayMs: 1000, tabWidth: 8 }),
    )
    window.localStorage.setItem(SETTINGS_SECTION_KEY, 'editor')

    vi.resetModules()
    const fresh = await import('@/state/settings-store')

    expect(fresh.useSettingsStore.getState()).toMatchObject({
      uiFontSize: 16,
      editorFontSize: 21,
      autosaveDelayMs: 1000,
      tabWidth: 8,
    })
    // 不带参数打开时停在"上次看的分区"
    fresh.useSettingsStore.getState().openSettings()
    expect(fresh.useSettingsStore.getState().section).toBe('editor')
    // 面板开关刻意不持久化：重启后不该自己弹出来
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toContain('"open"')
  })

  it('界面字号与「恢复默认字号」', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })

    fireEvent.change(screen.getByLabelText('界面字号'), { target: { value: '16' } })
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-ui')).toBe('16px')

    fireEvent.click(screen.getByRole('button', { name: '恢复默认字号' }))
    expect(useSettingsStore.getState().uiFontSize).toBe(DEFAULT_SETTINGS.uiFontSize)
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-ui')).toBe('13px')
  })

  it('阅读视图字号与编辑器字号分开：各自写自己的变量、各自持久化、一起被重置', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })

    const editor = screen.getByLabelText<HTMLInputElement>('编辑器字号')
    const reading = screen.getByLabelText<HTMLInputElement>('阅读视图字号')
    expect(editor.value).toBe(String(DEFAULT_SETTINGS.editorFontSize))
    expect(reading.value).toBe(String(DEFAULT_SETTINGS.readingFontSize))

    // 只动编辑器字号：阅读变量**不变**（此前两者共用同一个变量，改一个必然动另一个）
    fireEvent.change(editor, { target: { value: '22' } })
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-editor')).toBe('22px')
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-reading')).toBe('15px')

    // 只动阅读字号：编辑器不受影响
    fireEvent.change(reading, { target: { value: '20' } })
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-reading')).toBe('20px')
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-editor')).toBe('22px')

    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      readingFontSize?: number
    }
    expect(saved.readingFontSize).toBe(20)

    // 「恢复默认字号」把三项一起拉回默认
    fireEvent.click(screen.getByRole('button', { name: '恢复默认字号' }))
    expect(useSettingsStore.getState().readingFontSize).toBe(DEFAULT_SETTINGS.readingFontSize)
    expect(document.documentElement.style.getPropertyValue('--mn-font-size-reading')).toBe('15px')

    // 越界值被夹回范围（滑杆本身不会给出越界值，但持久化里可能被手工改过）
    act(() => {
      useSettingsStore.getState().setReadingFontSize(999)
    })
    expect(useSettingsStore.getState().readingFontSize).toBe(READING_FONT_SIZE_RANGE.max)
  })

  it('主题下拉直接改 ui-store（应用仍由 App 的 applyTheme effect 统一负责）', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })

    const select = screen.getByLabelText<HTMLSelectElement>('配色主题')
    const other = Array.from(select.options).find((option) => option.value !== select.value)
    expect(other).toBeDefined()

    fireEvent.change(select, { target: { value: other?.value ?? '' } })

    expect(useUiStore.getState().themeId).toBe(other?.value)
  })

  it('自动保存延迟：改动后真的改变了写盘时机', async () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    fireEvent.click(screen.getByRole('tab', { name: '编辑器' }))

    fireEvent.change(screen.getByLabelText('自动保存延迟'), { target: { value: '2000' } })
    expect(useSettingsStore.getState().autosaveDelayMs).toBe(2000)
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      autosaveDelayMs?: number
    }
    expect(saved.autosaveDelayMs).toBe(2000)

    await openVault()
    await act(async () => {
      await useNoteStore.getState().open('README.md')
    })
    act(() => {
      useNoteStore.getState().setText('# 改了一下\n')
    })
    expect(useNoteStore.getState().dirty).toBe(true)

    // 默认是 600ms：这里 900ms 还没落盘，说明生效的确实是 2000ms
    await sleep(900)
    expect(useNoteStore.getState().dirty).toBe(true)

    act(() => {
      useSettingsStore.getState().setAutosaveDelayMs(200)
    })
    act(() => {
      useNoteStore.getState().setText('# 又改了一下\n')
    })
    await sleep(400)
    // 新的延迟生效并真的写了盘
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('Tab 宽度写到 --mn-tab-size（CSS 变量，不碰编辑器实例）', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    fireEvent.click(screen.getByRole('tab', { name: '编辑器' }))

    fireEvent.change(screen.getByLabelText('Tab 宽度'), { target: { value: '8' } })
    expect(useSettingsStore.getState().tabWidth).toBe(8)
    expect(document.documentElement.style.getPropertyValue('--mn-tab-size')).toBe('8')
    // tab-size 由注入的样式表读取该变量（继承到编辑器与预览代码块）
    expect(document.getElementById('mn-settings-font-overrides')?.textContent).toContain(
      'tab-size: var(--mn-tab-size, 4)',
    )
  })

  it('Vault 分区：只改片段开关值、索引状态渲染、两个按钮各发一次 IPC', async () => {
    const { adapter, calls } = spyOnIpc(createMockAdapter())
    setIpcAdapter(adapter)
    await openVault()
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Vault' }))

    // CSS 片段：组件只改开关值（应用/卸载由 App 的 effect 统一负责）
    const checkbox = screen.getByLabelText<HTMLInputElement>('启用 Vault CSS 片段')
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(useUiStore.getState().snippetsEnabled).toBe(false)
    expect(screen.getByText('已停用')).toBeTruthy()

    calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: '刷新索引状态' }))
    await waitFor(() => {
      expect(calls).toContain('index_status')
    })

    calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: '重新扫描 Vault' }))
    await waitFor(() => {
      expect(calls).toContain('vault_snapshot')
    })
  })

  it('索引构建中显示进度条（而不是把"正在索引"显示成失败）', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Vault' }))

    act(() => {
      useLinksStore.setState({
        status: { phase: 'building', indexed: 30, total: 100, durationMs: 0, links: 0 },
      })
    })

    expect(screen.getByText('构建中…')).toBeTruthy()
    expect(screen.getByText('30 / 100 篇')).toBeTruthy()
    const progress = screen.getByLabelText<HTMLProgressElement>('索引进度')
    expect(progress.value).toBe(30)
    expect(progress.max).toBe(100)
  })

  it('未打开 Vault 时 Vault 分区给出提示而不是空转', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Vault' }))

    expect(screen.getByText('还没有打开 Vault')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('启用 Vault CSS 片段').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLButtonElement>('重新扫描 Vault').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLButtonElement>('刷新索引状态').disabled).toBe(true)
  })

  it('Tab 在对话框内部循环（模态占满窗口，焦点不该跑到遮罩后面）', () => {
    renderShell()
    act(() => {
      useSettingsStore.getState().openSettings()
    })
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    expect(first).toBeDefined()
    expect(last).toBeDefined()

    ;(last as HTMLElement).focus()
    fireEvent.keyDown(last as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first as HTMLElement, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

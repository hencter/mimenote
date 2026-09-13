/**
 * 标题栏的应用菜单。
 *
 * 为什么需要一个"看得见的菜单"：命令现在只能通过 `Ctrl+K` 的命令面板发现 ——
 * 那是一个**要求用户先知道快捷键**的入口。菜单是同一份命令注册表（`commands.list()`）
 * 的"可发现"视图：标题 + 快捷键 + 禁用原因，按分类分组，点一下就能执行。
 * 数据源与命令面板**完全共用**，因此将来登记的每条命令（含 M4 插件注册的）都会自动出现在这里。
 *
 * 键盘：`↑`/`↓` 移动、`Enter` 执行、`Esc` 关闭并把焦点还给按钮、`Tab` 移出即关闭。
 * 焦点放在弹出层容器上，当前行由 `aria-activedescendant` + 高亮表达（与命令面板同一套做法）。
 *
 * 状态全在组件内：菜单是"谁打开谁关掉"的瞬时 UI，没有第二个调用方需要它，
 * 放进全局 store 只会让状态图变复杂（同 `dom-events.ts` 对重命名对话框的约定）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { commands, formatChord, type Command } from '@/app/commands'
import { Icon } from '@/components/Icon'
import { useSettingsStore } from '@/state/settings-store'

// 样式与设置页同目录：两者都是本次新增的外壳层样式，故意不塞进共享的 `styles/app.css`
//（那个文件是全局布局的落点，改它会影响所有界面）。
import '@/features/settings/app-menu.css'

/** 弹出层里的一行：设置入口，或一条注册表命令。 */
type MenuRow = { kind: 'settings' } | { kind: 'command'; command: Command }

/** 渲染用的分组：`index` 是这一行在**全部行**里的序号（与 `aria-activedescendant` 一致）。 */
interface MenuGroup {
  category: string
  entries: Array<{ index: number; command: Command }>
}

interface MenuModel {
  groups: MenuGroup[]
  /** 扁平化后的行（`↑↓` 与 `Enter` 用），顺序与渲染顺序完全一致。 */
  rows: MenuRow[]
}

function rowId(index: number): string {
  return `mn-appmenu-item-${index}`
}

function isAvailable(command: Command): boolean {
  return command.when?.() ?? true
}

/**
 * 把命令注册表切成「设置入口 + 按分类分组的命令」。
 *
 * `commands.list()` 已经按「分类 → 标题」排好序，这里只切分组边界并顺带编号：
 * 编号与扁平行数组一起产出，避免"渲染顺序"和"键盘索引"两处各算一次而错位
 * （`aria-activedescendant` 指错行是这类菜单最容易出的 bug）。
 *
 * 注册表里的 `settings.open`（供 `Ctrl+,` 与命令面板用）在这里被跳过：菜单顶部已经有
 * 一条固定的"设置…"，同一条命令出现两次只会让人以为它们不一样。
 */
const SETTINGS_COMMAND_ID = 'settings.open'

function buildModel(list: readonly Command[]): MenuModel {
  const rows: MenuRow[] = [{ kind: 'settings' }]
  const groups: MenuGroup[] = []
  for (const command of list) {
    if (command.id === SETTINGS_COMMAND_ID) continue
    const index = rows.length
    rows.push({ kind: 'command', command })
    const last = groups[groups.length - 1]
    if (last !== undefined && last.category === command.category) {
      last.entries.push({ index, command })
      continue
    }
    groups.push({ category: command.category, entries: [{ index, command }] })
  }
  return { groups, rows }
}

/** 滚动到当前行（jsdom 没有实现 scrollIntoView，会抛 TypeError，所以先探测）。 */
function revealRow(index: number): void {
  const element = document.getElementById(rowId(index))
  if (element !== null && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' })
  }
}

export function AppMenu() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)

  // 每次打开都重新读一遍注册表（几十条，成本可忽略）：
  // 运行期新注册的命令（M4 插件）能立刻出现在菜单里，与命令面板的取数时机一致。
  const model = useMemo<MenuModel>(
    () => (open ? buildModel(commands.list()) : { groups: [], rows: [] }),
    [open],
  )
  const { groups, rows } = model

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setOpen(false)
    // 归还焦点：键盘用户按 Esc / 执行完命令后不该"掉焦点"
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // 打开即把焦点交给弹出层（键盘不需要先 Tab 进来）
  useEffect(() => {
    if (!open) return
    setActive(0)
    popupRef.current?.focus()
  }, [open])

  // 点击外部关闭。用 `mousedown` 而不是 `click`：点在别的按钮上时先关菜单，
  // 那次点击仍会正常落到目标上（不会出现"第一次点击只用来关菜单"）。
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open])

  const activate = useCallback(
    (row: MenuRow): void => {
      // 置灰项点不动，**也不关菜单**（同命令面板：让用户看清"为什么这条不能用"，
      // 而不是点一下就消失、还以为自己点错了）
      if (row.kind === 'command' && !isAvailable(row.command)) return
      // 先关菜单再执行：命令可能弹出自己的对话框（设置、确认框等），
      // 晚关会让两层叠在一起（同 CommandPalette 的处理）
      closeMenu(true)
      if (row.kind === 'settings') {
        useSettingsStore.getState().openSettings()
        return
      }
      // 注册表的 execute 里还会用 when() 再判一次（这里只是 UI 侧的短路）
      void commands.execute(row.command.id)
    },
    [closeMenu],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape': {
        event.preventDefault()
        closeMenu(true)
        return
      }
      case 'ArrowDown': {
        event.preventDefault()
        const next = Math.min(rows.length - 1, active + 1)
        setActive(next)
        revealRow(next)
        return
      }
      case 'ArrowUp': {
        event.preventDefault()
        const next = Math.max(0, active - 1)
        setActive(next)
        revealRow(next)
        return
      }
      case 'Enter': {
        event.preventDefault()
        const row = rows[active]
        if (row !== undefined) activate(row)
        return
      }
      default:
        return
    }
  }

  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))

  return (
    <div className="mn-appmenu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={open ? 'mn-icon-button mn-icon-button--active' : 'mn-icon-button'}
        aria-label="应用菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        title="应用菜单（全部命令）"
        onClick={() => {
          if (open) closeMenu(true)
          else setOpen(true)
        }}
      >
        <Icon name="menu" size={15} />
      </button>

      {open && (
        <div
          className="mn-appmenu__popup"
          role="menu"
          aria-label="应用菜单"
          tabIndex={-1}
          ref={popupRef}
          aria-activedescendant={rowId(activeIndex)}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            // 焦点移出整个菜单（Tab 到头、点了别处）就收起；移到菜单内部则不算
            const next = event.relatedTarget
            const root = rootRef.current
            if (next instanceof Node && root !== null && root.contains(next)) return
            setOpen(false)
          }}
        >
          {/* 设置入口固定排在最前：它是"用户找不到东西时"的兜底入口，
              不该埋在按字典序排的分类里 */}
          <button
            type="button"
            role="menuitem"
            id={rowId(0)}
            className={
              activeIndex === 0
                ? 'mn-appmenu__item mn-appmenu__item--active'
                : 'mn-appmenu__item'
            }
            data-menu-id="settings"
            onMouseMove={() => setActive(0)}
            onClick={() => activate({ kind: 'settings' })}
          >
            <Icon name="settings" size={14} />
            <span className="mn-appmenu__item-title">设置…</span>
          </button>

          <div className="mn-appmenu__divider" role="separator" />

          {groups.map((group) => (
            <div
              className="mn-appmenu__group"
              role="group"
              aria-label={group.category}
              key={group.category}
            >
              <div className="mn-appmenu__group-title" aria-hidden="true">
                {group.category}
              </div>
              {group.entries.map(({ index, command }) => {
                const enabled = isAvailable(command)
                const keybinding = command.keybinding
                const chord =
                  keybinding === undefined
                    ? null
                    : formatChord(Array.isArray(keybinding) ? (keybinding[0] ?? '') : keybinding)
                return (
                  <button
                    type="button"
                    key={command.id}
                    role="menuitem"
                    id={rowId(index)}
                    className={
                      activeIndex === index
                        ? 'mn-appmenu__item mn-appmenu__item--active'
                        : 'mn-appmenu__item'
                    }
                    aria-disabled={!enabled}
                    title={enabled ? command.title : (command.unavailableReason ?? command.title)}
                    data-menu-id={command.id}
                    onMouseMove={() => setActive(index)}
                    onClick={() => activate({ kind: 'command', command })}
                  >
                    <span className="mn-appmenu__item-title">{command.title}</span>
                    {!enabled && command.unavailableReason !== undefined && (
                      <span className="mn-appmenu__item-reason">{command.unavailableReason}</span>
                    )}
                    {chord !== null && chord !== '' && (
                      <span className="mn-appmenu__item-chord">{chord}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

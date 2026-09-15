/**
 * 命令面板 / 快速切换 / 全文搜索 —— **同一个组件的三种模式**。
 *
 * 为什么是一个组件：三种模式除了"读哪份数据源"和"激活时做什么"之外完全一样
 * （输入框与高亮、↑↓/Enter/Esc、`listbox/option` 的 aria 结构、空态、结果上限、
 * 焦点归还）。拆成三个组件只会把这些逐字复制一遍。
 *
 * 三种模式的差别，一句话说清：
 * - `commands`：命令注册表，**同步**过滤，激活 = 执行命令；
 * - `quickSwitch`：Vault 条目表派生的笔记索引，**同步**过滤，激活 = 打开笔记；
 * - `search`：宿主的全文搜索结果，**异步**（防抖 + 竞态丢弃，见 `use-search.ts`），
 *   激活 = 打开笔记并**跳到命中行**（见 `activateHit`）。
 *
 * 状态划分（为什么一半在 store、一半在组件内）：
 * - **开关与模式**在 `ui-store`：调用方除了 React 组件，还有全局快捷键监听与命令
 *   注册表（`palette.open` / `palette.quickSwitch` / `search.open`），组件内 state 给不了它们；
 * - **查询串、高亮下标、搜索结果**在组件内：它们是面板私有、且每次打开都要重置的瞬时状态。
 *   若塞进全局 store，每敲一个字符都会通知所有订阅者（搜索结果还会把整棵树的重渲染
 *   扩散到面板之外），而它们谁也不关心 —— 顺带还把"面板关闭即忘记查询、即取消在途请求"
 *   这件正确的事交给 React 卸载逻辑自动完成。
 *
 * 性能（1 万条目基线，详见 `match.ts` 的注释）：
 * - 同步模式的索引（小写路径、文件名起点、排序）由宿主按「Vault 变化」派生一次后传进来
 *   （见 `PaletteHost`），**不**在按键路径上重建，也不在每次打开时重算；
 * - 每次按键只跑一遍 O(n) 扫描，命中即早退，不做 DP 最优对齐，不引第三方 fuzzy 库；
 * - 全文搜索**不在主线程上对整库做任何过滤**：匹配在 Rust / SQLite 侧完成，
 *   前端只渲染宿主返回的前 {@link MAX_PALETTE_RESULTS} 条（其余只报"还有 N 条未显示"）；
 * - 输入框用 `useDeferredValue`（与 FileTree 的过滤一致），列表不阻塞打字。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

import { openNote, openNoteAt } from '@/app/actions'
import { commands, formatChord } from '@/app/commands'
import { Icon, type IconName } from '@/components/Icon'
import { displayPath } from '@/domain/paths'
import { describeError } from '@/ipc/types'
import type { IndexPhase, SearchHit } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useUiStore, type PaletteMode } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import {
  buildCommandIndex,
  filterCommands,
  filterNotes,
  substringMatchIndices,
  MAX_PALETTE_RESULTS,
  type NoteIndexEntry,
  type PaletteOutcome,
  type RankedCommand,
  type RankedNote,
} from './match'
import { usePaletteSearch, type PaletteSearchState } from './use-search'

/** 列表容器的 DOM id（输入的 `aria-controls` 指向它）。 */
const LIST_ID = 'mn-palette-list'

/** 模式无关的常量空结果：避免在另一个分支上白跑一次过滤。 */
const EMPTY_COMMANDS: PaletteOutcome<RankedCommand> = { items: [], total: 0 }
const EMPTY_NOTES: PaletteOutcome<RankedNote> = { items: [], total: 0 }
/** 非搜索模式下的空命中（同一个常量引用，省掉每次渲染的分配）。 */
const EMPTY_HITS: readonly SearchHit[] = []

const MODE_TEXT: Record<
  PaletteMode,
  { title: string; placeholder: string; confirm: string; icon: IconName; listLabel: string }
> = {
  commands: {
    title: '命令面板',
    placeholder: '输入命令名或分类…',
    confirm: '执行',
    icon: 'sparkle',
    listLabel: '命令',
  },
  quickSwitch: {
    title: '快速切换笔记',
    placeholder: '输入文件名或相对路径…',
    confirm: '打开',
    icon: 'file',
    listLabel: '笔记',
  },
  search: {
    title: '全文搜索',
    placeholder: '搜索正文内容…',
    // 与另外两种模式不同：这里回车不只是"打开"，还会把光标落到那一行
    confirm: '打开并定位',
    icon: 'search',
    listLabel: '搜索结果',
  },
}

function optionId(index: number): string {
  return `mn-palette-option-${index}`
}

function rowClassName(active: boolean, disabled: boolean): string {
  return [
    'mn-palette__item',
    active ? 'mn-palette__item--active' : '',
    disabled ? 'mn-palette__item--disabled' : '',
  ]
    .filter((name) => name !== '')
    .join(' ')
}

/**
 * 命令面板 / 快速切换的空态文案。
 *
 * 三种"空"必须说清楚原因，否则用户只会看到一片空白：
 * 没打开 Vault / Vault 里压根没有笔记 / 有笔记但当前输入没匹配上。
 * （全文搜索有自己的版本 `searchEmptyMessage`：它还要表达"正在搜""搜失败"两种中间态。）
 */
function emptyMessage(mode: PaletteMode, hasVault: boolean, noteCount: number): string {
  if (mode === 'quickSwitch') {
    if (!hasVault) {
      return `还没有打开 Vault —— 按 ${formatChord('Mod+O')} 选择一个文件夹后，就能在这里快速切换笔记`
    }
    if (noteCount === 0) return '这个 Vault 里还没有 Markdown 笔记'
    return '没有匹配的笔记'
  }
  return '没有匹配的命令'
}

/**
 * 全文搜索的空态。
 *
 * 与另外两种模式不同，这里要区分**五种**情况：没打开 Vault / 还没输入 / 结果还没回来 /
 * 搜失败 / 真的没有命中。"搜索中"与"没有结果"混淆会直接误导用户（前者该等一下，
 * 后者该换词），所以判据取 `settledQuery` 而不是 `loading`：
 * 防抖窗口内请求还没发出，`loading` 仍是 false，光看它会早一帧显示"没有结果"。
 */
function searchEmptyMessage(
  state: PaletteSearchState,
  query: string,
  hasVault: boolean,
  indexPhase: IndexPhase,
): string {
  if (!hasVault) {
    return `还没有打开 Vault —— 按 ${formatChord('Mod+O')} 选择一个文件夹后，就能搜索正文内容`
  }
  const trimmed = query.trim()
  if (trimmed === '') return '输入关键词，搜索当前 Vault 的正文内容'
  if (state.error !== null) {
    // 索引还在构建时，宿主返回的是带原因的 `IO` 错误 —— 那不是"搜索坏了"，
    // 而是"还没准备好"，所以用提示语气（大 Vault 首次打开要几秒）。
    if (indexPhase === 'building') {
      return '全文索引正在构建…（大 Vault 首次打开需要几秒，构建完成后即可搜索）'
    }
    return describeError(state.error, '搜索失败')
  }
  if (state.loading || state.settledQuery !== trimmed) return '搜索中…'
  return '没有匹配的正文内容'
}

export function CommandPalette({
  mode,
  noteIndex,
}: {
  mode: PaletteMode
  /** 由宿主派生并传入的笔记索引（快速切换模式使用）。 */
  noteIndex: readonly NoteIndexEntry[]
}) {
  const close = useUiStore((state) => state.closePalette)
  const hasVault = useVaultStore((state) => state.info !== null)
  /** 索引进度：用来区分"索引还在建"（提示等一下）与"搜索真的失败"（报错）。 */
  const indexPhase = useLinksStore((state) => state.status.phase)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 过滤是一次 O(n) 扫描：用 deferred value 降优先级，输入框本身不等待列表
  const deferredQuery = useDeferredValue(query)
  const lowerQuery = deferredQuery.trim().toLowerCase()

  // 命令索引在这里构建（几十条，不到 1ms）：顺带保证每次打开都重新读一遍注册表，
  // M4 的插件在运行期注册命令后能立刻出现在面板里。
  // 笔记索引则由宿主按「Vault 变化」派生好传进来（见 PaletteHost 的注释）。
  const commandIndex = useMemo(
    () => (mode === 'commands' ? buildCommandIndex(commands.list()) : []),
    [mode],
  )

  const commandOutcome = useMemo(
    () => (mode === 'commands' ? filterCommands(commandIndex, lowerQuery) : EMPTY_COMMANDS),
    [mode, commandIndex, lowerQuery],
  )
  const noteOutcome = useMemo(
    () => (mode === 'quickSwitch' ? filterNotes(noteIndex, lowerQuery) : EMPTY_NOTES),
    [mode, noteIndex, lowerQuery],
  )

  // 全文搜索：异步、防抖、竞态丢弃都在这个 hook 里（用**原始** query 而不是 deferred：
  // 防抖已经承担了降频，再叠一层延迟只会让"最后一次输入的查询"更晚发出）。
  // 未打开 Vault 时 enabled=false —— 不必打扰宿主（面板此时显示"还没有打开 Vault"空态）。
  const search = usePaletteSearch(query, mode === 'search' && hasVault)
  const searchHits = mode === 'search' ? search.hits.slice(0, MAX_PALETTE_RESULTS) : EMPTY_HITS

  const shown =
    mode === 'commands'
      ? commandOutcome.items.length
      : mode === 'quickSwitch'
        ? noteOutcome.items.length
        : searchHits.length
  const total =
    mode === 'commands'
      ? commandOutcome.total
      : mode === 'quickSwitch'
        ? noteOutcome.total
        : search.total

  // 结果集变了就把高亮收回第一条，否则可能停在一个已经不存在的下标上
  useEffect(() => {
    setActive(0)
  }, [lowerQuery])

  /**
   * 模式切换时**连查询串一起清空**。
   *
   * 面板在三种模式之间切换时，React 看到的是同一个组件实例（元素类型与位置都没变），
   * 不会重新挂载 —— 于是"在命令面板里输入的命令名"会原样留在搜索框里：
   * `Ctrl+K` → 输入「全文搜索」→ 回车之后，面板变成全文搜索模式，
   * 而查询串还是「全文搜索」，用户立刻看到一个"用命令名搜正文"的空结果。
   * 跨模式复用查询串没有任何意义（命令名 vs 笔记路径 vs 正文关键词），直接清掉。
   */
  useEffect(() => {
    setQuery('')
    setActive(0)
  }, [mode])
  const activeIndex = Math.min(active, Math.max(0, shown - 1))

  // 焦点：打开时记住"从哪来"，关闭（= 卸载）时还回去。
  // 用卸载清理来归还焦点，天然满足"每个副作用必须可逆"（architecture.md §2 规则 6）。
  useEffect(() => {
    const previous = document.activeElement
    const restore = previous instanceof HTMLElement ? previous : null
    inputRef.current?.focus()
    return () => {
      // 原元素可能已经不在了（例如命令刚把整棵子树换掉）→ 归还前必须确认仍在文档里
      if (restore !== null && restore.isConnected) restore.focus()
    }
  }, [])

  const activateCommand = useCallback(
    (item: RankedCommand) => {
      // 置灰项不执行（注册表 execute 里还会用 when() 再判一次，这里是 UI 侧的短路）
      if (!item.entry.enabled) return
      // 先关面板再执行：命令可能弹出自己的对话框（二次确认等），晚关会叠在它上面
      close()
      void commands.execute(item.entry.id)
    },
    [close],
  )

  const activateNote = useCallback(
    (item: RankedNote) => {
      close()
      // 走既有高层动作（app/actions.openNote）：展开路径 → 切走前落盘 → 读取 → 选中。
      // 组件自己绝不 invoke IPC（architecture.md §2 边界规则 5）。
      void openNote(item.relPath)
    },
    [close],
  )

  const activateHit = useCallback(
    (hit: SearchHit) => {
      close()
      // 与快速切换走同一个高层动作（app/actions.openNote 的"打开 + 定位"版本）：
      // 组件自己绝不 invoke IPC，也不自己造一套"滚动 + 设选区"（那会绕过编辑器既有的
      // 装配：文档切换、`revision` 整篇替换、只读/冲突态）。
      // 定位实现在 features/editor/line-jump.ts：它负责"等新文档真的进了编辑器"再算位置，
      // 并顺带把主区域切回编辑视图、把焦点交给编辑器。
      void openNoteAt(hit.relPath, hit.line)
    },
    [close],
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (shown === 0) return
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        setActive(Math.min(shown - 1, activeIndex + 1))
        return
      }
      case 'ArrowUp': {
        event.preventDefault()
        setActive(Math.max(0, activeIndex - 1))
        return
      }
      case 'Enter': {
        event.preventDefault()
        if (mode === 'commands') {
          const item = commandOutcome.items[activeIndex]
          if (item !== undefined) activateCommand(item)
        } else if (mode === 'quickSwitch') {
          const item = noteOutcome.items[activeIndex]
          if (item !== undefined) activateNote(item)
        } else {
          const hit = searchHits[activeIndex]
          if (hit !== undefined) activateHit(hit)
        }
        return
      }
      default:
        // Escape 由 usePaletteHotkeys 在**捕捉阶段**处理：必须与焦点位置无关，
        // 且不能冒泡给全局快捷键。
        return
    }
  }

  const text = MODE_TEXT[mode]
  const emptyText =
    mode === 'search'
      ? searchEmptyMessage(search, query, hasVault, indexPhase)
      : emptyMessage(mode, hasVault, noteIndex.length)
  // 空态里的错误用警示色（"搜失败"不该长得像"没有结果"）；索引构建中不算失败
  const emptyIsError =
    mode === 'search' && search.error !== null && query.trim() !== '' && indexPhase !== 'building'
  // 列表里还留着上一次的结果时，"搜索中…"放在页脚而不是换掉整个列表 —— 避免闪一下
  const searchStatus = mode === 'search' && search.loading && shown > 0 ? '搜索中…' : null

  return (
    <div className="mn-overlay mn-overlay--palette" role="presentation" onClick={close}>
      <div
        className="mn-palette"
        role="dialog"
        aria-modal="true"
        aria-label={text.title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mn-palette__field">
          <Icon name={text.icon} size="sm" />
          <input
            ref={inputRef}
            className="mn-palette__input"
            type="text"
            value={query}
            placeholder={text.placeholder}
            aria-label={text.title}
            aria-controls={shown === 0 ? undefined : LIST_ID}
            aria-activedescendant={shown === 0 ? undefined : optionId(activeIndex)}
            autoComplete="off"
            spellCheck={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
          <span className="mn-palette__mode">{text.title}</span>
          <kbd>Esc</kbd>
        </div>

        {shown === 0 ? (
          <p
            className={
              emptyIsError ? 'mn-palette__empty mn-palette__empty--error' : 'mn-palette__empty'
            }
          >
            {emptyText}
          </p>
        ) : (
          <ul className="mn-palette__list" id={LIST_ID} role="listbox" aria-label={text.listLabel}>
            {mode === 'commands'
              ? commandOutcome.items.map((item, index) => (
                  <li
                    key={item.entry.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={!item.entry.enabled}
                    className={rowClassName(index === activeIndex, !item.entry.enabled)}
                    data-palette-id={item.entry.id}
                    // 鼠标移到哪一条就高亮哪一条（用 mousemove 而不是 mouseenter：
                    // 键盘移动后鼠标不动时，不应被"静止的鼠标位置"抢走高亮）
                    onMouseMove={() => setActive(index)}
                    onClick={() => activateCommand(item)}
                  >
                    <span className="mn-palette__item-title">
                      <Highlighted text={item.entry.title} indices={item.titleIndices} />
                    </span>
                    <span className="mn-palette__item-meta">
                      <Highlighted text={item.entry.category} indices={item.categoryIndices} />
                    </span>
                    {item.entry.disabledReason !== null && (
                      <span className="mn-palette__reason">{item.entry.disabledReason}</span>
                    )}
                    {item.entry.keybindingLabel !== null && <kbd>{item.entry.keybindingLabel}</kbd>}
                  </li>
                ))
              : mode === 'quickSwitch'
                ? noteOutcome.items.map((item, index) => (
                    <li
                      key={item.relPath}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={rowClassName(index === activeIndex, false)}
                      data-rel-path={item.relPath}
                      onMouseMove={() => setActive(index)}
                      onClick={() => activateNote(item)}
                    >
                      <span className="mn-palette__item-title">
                        <Highlighted text={item.displayPath} indices={item.indices} />
                      </span>
                    </li>
                  ))
                : searchHits.map((hit, index) => (
                    <li
                      // 同一文件会有多条命中（行号不同）→ key 必须带上行号
                      key={`${hit.relPath}:${hit.line}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === activeIndex}
                      // 两行布局：主行路径、副行「行号: 片段」
                      className={
                        `${rowClassName(index === activeIndex, false)} mn-palette__item--stacked`
                      }
                      data-rel-path={hit.relPath}
                      data-line={hit.line}
                      onMouseMove={() => setActive(index)}
                      onClick={() => activateHit(hit)}
                    >
                      <span className="mn-palette__item-title">{displayPath(hit.relPath)}</span>
                      <span className="mn-palette__item-sub">
                        {hit.line}:{' '}
                        {/* 高亮用**子串**下标（不是子序列）：必须与宿主实际命中的位置一致 */}
                        <Highlighted
                          text={hit.snippet}
                          indices={substringMatchIndices(hit.snippet, query.trim())}
                        />
                      </span>
                    </li>
                  ))}
          </ul>
        )}

        <footer className="mn-palette__footer">
          <span className="mn-palette__hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span className="mn-palette__hint">
            <kbd>Enter</kbd> {text.confirm}
          </span>
          <span className="mn-palette__hint">
            <kbd>Esc</kbd> 关闭
          </span>
          {searchStatus !== null && <span className="mn-palette__status">{searchStatus}</span>}
          {/* 搜索模式下 `total` 是宿主的命中总数：它可能大于 `hits.length`（宿主按每篇取前几条 /
              按 limit 截断），"还有 N 条未显示"正是契约里这个字段的用途 */}
          {total > shown && (
            <span className="mn-palette__more">
              还有 {total - shown} 条未显示（继续输入以缩小范围）
            </span>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * 命中字符高亮。
 *
 * 下标由匹配阶段给出（`fuzzyMatch` 的子序列下标，或全文搜索的 {@link substringMatchIndices}
 * 子串下标），因此这里只做渲染，不重新算匹配；相邻的命中合并成一个 `<mark>`，
 * 避免把词切成碎片影响可读性。
 */
function Highlighted({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <span>{text}</span>

  // 相邻下标合并成区间
  const runs: Array<[number, number]> = []
  for (const index of indices) {
    const last = runs[runs.length - 1]
    if (last !== undefined && index === last[1] + 1) last[1] = index
    else runs.push([index, index])
  }

  const nodes: ReactNode[] = []
  let cursor = 0
  runs.forEach(([start, end], position) => {
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(
      <mark key={position} className="mn-palette__hit">
        {text.slice(start, end + 1)}
      </mark>,
    )
    cursor = end + 1
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))

  return <span>{nodes}</span>
}

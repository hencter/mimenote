/**
 * 标签过滤控件：文件树的头部入口 —— 把树收窄到"用了某个标签（或它的子标签）的笔记"。
 *
 * ## 为什么入口在文件树上，而不是标签面板
 * 标签面板回答"哪些笔记用了它"，看完一条就得退回全量树；而"在**当前这条工作流**里只想看见
 * 这一类笔记"是文件树自己的诉求（与它已有的文本过滤框同一层级）。两个入口各管一件事，
 * 谁也不抢谁的焦点。
 *
 * ## 界面上必须能一眼读出的四件事
 * 1. **现在只显示 M/N 篇**（`data-tag-filter-count`）—— 收窄了多少是过滤控件的第一信息；
 * 2. **多选 = 并集**（任一标签命中即显示）—— 一行说明文字，与
 *    `domain/tag-filter.ts` 的 `TAG_MATCH_MODE` 同源，不给用户猜的余地；
 * 3. **「含子标签」是一对一的开关**：选 `#父` 时是否把 `#父/子` 算进来，开关上写着，
 *    有效果时还带上"共几个子标签"；选中键没有子标签时**置灰并说明原因**
 *    （点了没反应的开关比禁用更难懂）；
 * 4. **随时能回到全量**：`Esc`（焦点在树上或搜索框里都行）与「清除」按钮两条路。
 *
 * ## 失败与空集都要有交代
 * 读取失败时**过滤不生效**（树上仍是全量）并说明原因 + 提供「重试」；
 * 选中的标签已经不在全库标签里（可能刚被重命名/合并）时点名说出这件事 ——
 * 否则用户看到的就是"树空着、界面一声不吭"。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { Icon } from '@/components/Icon'
import { useTagFilterStore } from '@/state/tag-filter-store'
import { useTagFilterView } from './use-tag-filter-view'

import './tag-filter.css'

/** 选项列表一次最多渲染多少条（与 `[[` 补全面板同一个做法：超出就用输入收窄）。 */
const MAX_OPTIONS = 100

const LIST_ID = 'mn-tag-filter-options'

function optionId(key: string): string {
  return `${LIST_ID}-${encodeURIComponent(key)}`
}

export function TagFilterControl() {
  const view = useTagFilterView()
  const toggleKey = useTagFilterStore((state) => state.toggleKey)
  const setIncludeSubtags = useTagFilterStore((state) => state.setIncludeSubtags)
  const toggleExcludeKey = useTagFilterStore((state) => state.toggleExcludeKey)
  const clear = useTagFilterStore((state) => state.clear)
  const ensureSummary = useTagFilterStore((state) => state.ensureSummary)
  const reload = useTagFilterStore((state) => state.reload)
  const summary = useTagFilterStore((state) => state.summary)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 打开选择器才拉标签概览：关着时一次 IPC 都不发（与标签面板同一个姿态）
  useEffect(() => {
    if (!open) return
    void ensureSummary()
  }, [open, ensureSummary])

  // 打开就聚焦搜索框：这个控件存在的意义就是"敲两个字选一个标签"
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open])

  // 点控件外面收起。用 mousedown 而不是 click：拖选文本松手在别处时不该被当成"点外面"
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const node = containerRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched =
      needle === ''
        ? summary
        : summary.filter(
            (item) =>
              item.key.toLowerCase().includes(needle) || item.tag.toLowerCase().includes(needle),
          )
    return {
      rows: matched.slice(0, MAX_OPTIONS),
      hidden: Math.max(0, matched.length - MAX_OPTIONS),
    }
  }, [summary, query])

  // 搜索让列表变短时把高亮夹回范围（否则 Enter 会指向一条不存在的项）
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, options.rows.length - 1)))
  }, [options.rows.length])

  const activeKey = options.rows[activeIndex]?.key

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(0, options.rows.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(0, current - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (activeKey !== undefined) toggleKey(activeKey)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      // 两段式：先清搜索词（还在挑标签），再清过滤（回到全量）。
      // 一条路径两种结果会让人不知道 Esc 到底干了什么，所以把"当前最浅的一层"先撤掉。
      if (query !== '') setQuery('')
      else {
        clear()
        setOpen(false)
      }
    }
  }

  const countLabel = view.applied
    ? `仅显示 ${view.visibleNoteCount}/${view.totalNoteCount} 篇`
    : view.status === 'loading'
      ? '正在过滤…'
      : '过滤未生效'

  return (
    <div
      className="mn-tag-filter"
      ref={containerRef}
      data-tag-filter-active={view.active ? 'true' : 'false'}
    >
      <div className="mn-tag-filter__bar">
        <button
          type="button"
          className={`mn-tag-filter__trigger${open ? ' mn-tag-filter__trigger--open' : ''}`}
          data-tag-filter-toggle
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="按标签过滤文件树"
          title="按标签收窄文件树（可多选；Esc 或「清除」随时回到全量）"
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="sparkle" size="xs" />
          <span>标签过滤</span>
        </button>

        {view.active ? (
          <>
            <span className="mn-tag-filter__count" data-tag-filter-count={view.visibleNoteCount}>
              {countLabel}
            </span>
            <button
              type="button"
              className="mn-icon-button"
              aria-label="清除标签过滤"
              title="清除标签过滤（Esc）"
              data-tag-filter-clear
              onClick={clear}
            >
              <Icon name="x" size="xs" />
            </button>
          </>
        ) : null}
      </div>

      {/* 选中的标签 + 「含子标签」：即使收起选择器也必须看得见，它们决定结果长什么样 */}
      {view.active ? (
        <div className="mn-tag-filter__active">
          <ul className="mn-tag-filter__chips">
            {view.keys.map((key, index) => (
              <li key={key} className="mn-tag-filter__chip">
                <span className="mn-tag-filter__chip-label">#{view.labels[index] ?? key}</span>
                <button
                  type="button"
                  className="mn-tag-filter__chip-remove"
                  data-tag-filter-chip-remove={key}
                  aria-label={`取消标签过滤 ${view.labels[index] ?? key}`}
                  onClick={() => toggleKey(key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {/*
            「不含」是单独一组胶囊：它与「含」的语义相反，混在同一行里会让"这行到底要什么"
            变得要靠颜色去猜。加号/减号在视觉上分开，读屏也念得清（`aria-label` 带"不含"）。
          */}
          {view.excludeKeys.length > 0 ? (
            <ul className="mn-tag-filter__chips mn-tag-filter__chips--exclude" data-tag-filter-exclude-chips>
              {view.excludeKeys.map((key, index) => (
                <li key={key} className="mn-tag-filter__chip mn-tag-filter__chip--exclude">
                  <span className="mn-tag-filter__chip-label">
                    不含 #{view.excludeLabels[index] ?? key}
                  </span>
                  <button
                    type="button"
                    className="mn-tag-filter__chip-remove"
                    data-tag-filter-exclude-chip-remove={key}
                    aria-label={`取消排除 ${view.excludeLabels[index] ?? key}`}
                    onClick={() => toggleExcludeKey(key)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className={`mn-tag-filter__subtags${
              view.includeSubtags ? ' mn-tag-filter__subtags--on' : ''
            }`}
            data-tag-filter-subtags={view.includeSubtags ? 'on' : 'off'}
            aria-pressed={view.includeSubtags}
            disabled={view.subtagCount === 0}
            title={
              view.subtagCount === 0
                ? '所选标签没有子标签（子标签写作 #父/子）—— 这个开关当前不影响结果'
                : `选中 #父 时同时算上它的子标签（共 ${view.subtagCount} 个）`
            }
            onClick={() => setIncludeSubtags(!view.includeSubtags)}
          >
            含子标签
            {view.subtagCount > 0 ? `（${view.subtagCount}）` : ''}
          </button>
        </div>
      ) : null}

      {view.active ? (
        <p className="mn-tag-filter__hint" data-tag-filter-hint="any-not-none">
          多选 = <strong>含任意一个</strong>即显示（并集）；用「排除」把某一类剔出去 =
          <strong>有 A 且没有 B</strong>；「含子标签」= 把 <code>#父/子</code> 也算进{' '}
          <code>#父</code>。过滤期间拖拽仍可用，但落点只能是看得见的行。
        </p>
      ) : null}

      {/* 状态交代：任何一条"树看起来不对"的可能，这里都得有一句话 */}
      {view.active && view.status === 'loading' ? (
        <p className="mn-tag-filter__note" data-tag-filter-loading>
          正在读取标签下的笔记…
        </p>
      ) : null}
      {view.active && view.status === 'error' ? (
        <p className="mn-tag-filter__note mn-tag-filter__note--warn" data-tag-filter-error>
          标签过滤未生效（树仍是全量）：{view.errorText}
          <button
            type="button"
            className="mn-button mn-button--small"
            onClick={() => void reload()}
          >
            重试
          </button>
        </p>
      ) : null}
      {view.active && view.applied && view.missingKeys.length > 0 ? (
        <p
          className="mn-tag-filter__note mn-tag-filter__note--warn"
          data-tag-filter-missing={view.missingKeys.join(',')}
        >
          标签 #{view.missingKeys.join('、#')} 已不在这个 Vault 里（可能被重命名或合并），
          因此命中 0 篇。
        </p>
      ) : null}
      {view.hitsOutsideTree ? (
        <p className="mn-tag-filter__note" data-tag-filter-outside-tree>
          命中的 {view.hitCount} 篇都不在当前文件树里（Vault 刚被重扫或改名？），
          点「重新过滤」再算一次。
        </p>
      ) : null}
      {view.openNoteHidden && view.openRelPath !== null ? (
        <p className="mn-tag-filter__note" data-tag-filter-open-hidden={view.openRelPath}>
          当前打开的笔记 {view.openRelPath} 不在过滤结果里（它没有这些标签）。
        </p>
      ) : null}

      {open ? (
        <div className="mn-tag-filter__popover" data-tag-filter-popover>
          <div className="mn-search-field">
            <Icon name="search" size="sm" />
            <input
              ref={inputRef}
              type="text"
              // 刻意不复用工具栏那个 `.mn-search-field__input` 类名：样式上确实一样，
              // 但页面上就会出现**两个**同类的输入框，选择器（测试、自动化、用户脚本）
              // 会分不清点的是哪一个 —— 这里用自己的类名，样式在 tag-filter.css 里对齐
              className="mn-tag-filter__search-input"
              data-tag-filter-search
              role="combobox"
              aria-expanded="true"
              aria-controls={options.rows.length === 0 ? undefined : LIST_ID}
              aria-activedescendant={activeKey === undefined ? undefined : optionId(activeKey)}
              aria-label="搜索标签"
              placeholder="搜索标签…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleSearchKeyDown}
            />
            {query !== '' ? (
              <button
                type="button"
                className="mn-icon-button"
                aria-label="清除标签搜索"
                onClick={() => setQuery('')}
              >
                <Icon name="x" size="xs" />
              </button>
            ) : null}
          </div>

          {view.summaryStatus === 'loading' ? (
            <p className="mn-tag-filter__note">正在读取全库标签…</p>
          ) : view.summaryStatus === 'error' ? (
            <p className="mn-tag-filter__note mn-tag-filter__note--warn">
              读不到全库标签：{view.summaryErrorText}
              <button
                type="button"
                className="mn-button mn-button--small"
                onClick={() => void ensureSummary(true)}
              >
                重试
              </button>
            </p>
          ) : options.rows.length === 0 ? (
            <p className="mn-tag-filter__note">
              {summary.length === 0 ? '这个 Vault 还没有标签。' : '没有匹配的标签。'}
            </p>
          ) : (
            <ul
              className="mn-tag-filter__options"
              id={LIST_ID}
              role="listbox"
              aria-multiselectable="true"
              aria-label="全库标签"
            >
              {options.rows.map((item, index) => {
                const selected = view.keys.includes(item.key)
                const excluded = view.excludeKeys.includes(item.key)
                return (
                  <li key={item.key} className="mn-tag-filter__option-row">
                    <button
                      type="button"
                      id={optionId(item.key)}
                      role="option"
                      // `aria-selected` 在这里是**真的选中状态**（可多选），不是键盘高亮：
                      // 高亮只用样式 + `aria-activedescendant` 表达，两者不能混
                      aria-selected={selected}
                      className={`mn-tag-filter__option${
                        index === activeIndex ? ' mn-tag-filter__option--active' : ''
                      }${selected ? ' mn-tag-filter__option--selected' : ''}${
                        excluded ? ' mn-tag-filter__option--excluded' : ''
                      }`}
                      data-tag-filter-option={item.key}
                      data-tag-filter-option-excluded={excluded ? 'true' : 'false'}
                      title={`#${item.tag} · ${item.count} 篇（点 = 含它；右边的「排除」= 不含它）`}
                      onClick={() => toggleKey(item.key)}
                    >
                      <span className="mn-tag-filter__option-name">#{item.tag}</span>
                      <span className="mn-tag-filter__option-count">{item.count}</span>
                      {selected ? <Icon name="check" size="xs" /> : null}
                    </button>
                    {/*
                      「排除」是行内第二个动作：它把"有 A 且没有 B"做成一次点击，
                      而不是让用户去别处找一个排除输入框。同一个键不会同时在两组里
                      （store 负责互斥），所以这两个按钮是互斥的开关。
                    */}
                    <button
                      type="button"
                      className={`mn-tag-filter__exclude${excluded ? ' mn-tag-filter__exclude--on' : ''}`}
                      data-tag-filter-option-exclude={item.key}
                      aria-pressed={excluded}
                      aria-label={excluded ? `不再排除 #${item.tag}` : `排除 #${item.tag}`}
                      title={excluded ? `不再排除 #${item.tag}` : `排除 #${item.tag}（只看不含它的笔记）`}
                      onClick={() => toggleExcludeKey(item.key)}
                    >
                      {excluded ? '−' : '排除'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {options.hidden > 0 ? (
            <p className="mn-tag-filter__note">还有 {options.hidden} 个标签，继续输入以缩小范围。</p>
          ) : null}

          <div className="mn-tag-filter__footer">
            <button
              type="button"
              className="mn-button mn-button--small"
              title="条目表被重扫或笔记在应用外改动之后，重新计算命中集合"
              onClick={() => void reload()}
            >
              重新过滤
            </button>
            <button
              type="button"
              className="mn-button mn-button--small"
              disabled={!view.active}
              onClick={clear}
            >
              清除
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 大纲面板：当前笔记的标题树，点一下跳过去。
 *
 * 为什么需要它：长笔记里"跳到第 3 节"靠滚动找标题是纯粹的体力活；编辑器虽然有
 * `Ctrl+F`，但那只在知道要找什么词时有用。大纲是"这篇笔记的结构"本身。
 *
 * ## 三种视图下的行为（**同一个点击只有一种结果**，不随视图漂移）
 * - **编辑视图**：把光标放到那一行并滚动（复用 `features/editor/line-jump.ts`，
 *   与搜索命中跳转是同一条路径：不改文档、不进撤销历史）；
 * - **阅读视图**：预览里没有光标，于是滚动到第 N 个标题并高亮一下 —— "跳转"的对象
 *   从光标换成视口，用户的意图（去那一节）完全一样；
 * - **图谱视图**：正文根本不在屏幕上，先切回编辑视图再定位（与搜索跳转同一约定）。
 *
 * ## 看什么：级别过滤（顶部一排 H1–H6 开关）
 * - **默认全亮 = 不过滤**：升级上来的老用户打开面板看到的必须还是原来那份完整标题树，
 *   新能力只能是一个"还没被人动过"的开关，不能替他们做减法；
 * - 选择按 Vault 根持久化（`state/ui-store.ts` 的 `outlineLevelsByVault`），理由写在
 *   `OutlineLevelsByVault` 的注释里；
 * - 全部关掉是合法状态（面板给一句空态文案 + 一条"显示全部级别"的退路）：
 *   "我想看看只剩骨架是什么样"是合理的探索，而静默拒绝一次点击更费解。
 *
 * ## 看到多深：章节折叠（条目左侧的三角）
 * - 收起一条 = 隐藏它后面所有级别更深的标题，直到遇到同级或更浅的那一条
 *   （H2 折叠隐藏其后的 H3+，直到下一个 H1/H2）。规则与纯粹的算法都在
 *   `features/outline/outline-view.ts`；
 * - **折叠状态刻意不持久化**（与知识图谱的展开状态同一取舍，见 architecture §8 第 15/20 条）：
 *   它是"我刚才在看这一段"的临时动作，而下次打开笔记时用户要的是**完整的结构**；
 *   持久化一份"上次收起了哪几节"只会让用户下次面对一棵残缺的树，还得先还原它。
 *   折叠也**不跨笔记带着走**（换笔记即全展开）—— 同一个理由，序号在不同的笔记里
 *   指向完全不同的章节，带过去只会是噪音。
 * - 折叠按**序号**记（不是行号、不是标题文本）：与阅读视图的跳转/高亮同一个口径
 *   （都是"完整列表里的第几个"），且重复标题（两节都叫"备注"）不会互相带偏。
 *   代价是：在折叠项**上方**插入/删除标题时，折叠会落到相邻的一条上 —— 内容本来就在变，
 *   用户再点一下就能纠正，不值得为此引入一套更容易判错的"按文本追踪"。
 *
 * ## "当前章节"高亮永远按**完整标题列表**算
 * 高亮的下标来自 `currentHeadingIndex`（编辑视图，光标行）或 `visibleHeadingOrdinal`
 * （阅读视图，视口顶部），两者都是完整列表的下标（见 `outline-view.ts` 的文件头）。
 * 过滤与折叠只改变"渲染哪几条"，因此**不会**把高亮挤到相邻的条目上。
 * 当前章节恰好被过滤掉或被收起的祖先藏起来时，这里也**不**把高亮改指到别的条目
 * （那等于告诉用户"你在另一节"，是明确错误的方位）：面板头部如实说明它去哪了
 * （第几行、为什么看不见），用户自己一步就能还原 —— 折叠与过滤都是他刚亲手做的动作，
 * 替他自动撤销（把级别加回过滤、展开祖先）才是抢方向盘。
 *
 * ## 为什么用 `useDeferredValue`
 * 大纲跟着正文每次输入重算（用户敲一个字就该看到标题树更新）。整篇解析是 O(行数)，
 * 大文档下放在同步渲染路径上会拖慢输入 —— 与预览用的是同一个降级手段（deferred 更新
 * 不阻塞输入）。标题树变化只影响这个侧栏，落后一帧没有观感问题。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'

import { useUiStore } from '@/state/ui-store'
import { Icon } from '@/components/Icon'
import { outlineDepths, parseOutline, type OutlineHeading } from '@/domain/outline'
import { jumpToLineInOpenNote } from '@/features/editor/line-jump'
import { useCursorStore } from '@/state/cursor-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

import { scrollPreviewToHeading, subscribeVisibleHeading } from './outline-scroll'
import { ALL_HEADING_LEVELS, buildOutlineRows, toggleHeadingLevel } from './outline-view'
import './outline.css'

/** 每一项的缩进步长（像素），与 `outline.css` 里的 padding 计算一致。 */
const INDENT_STEP = 12

/** 空折叠集合的替身：只当只读常量用（写入一律新建 `Set`，绝不改它）。 */
const NO_COLLAPSE: ReadonlySet<number> = new Set<number>()

/**
 * "当前章节"：最后一个**不晚于**光标行的标题。
 *
 * 用 `<=` 而不是"行号完全相等"：光标落在标题下面的正文里时，用户看到的仍然是那一章
 * （这正是"我在哪一节"的含义）。返回下标而不是标题对象 —— 渲染时要按它打标记。
 *
 * 下标是**完整列表**的下标，与过滤/折叠无关（见文件头）。
 */
export function currentHeadingIndex(
  headings: readonly OutlineHeading[],
  cursorLine: number | null,
): number {
  if (cursorLine === null) return -1
  let index = -1
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]
    if (heading === undefined || heading.line > cursorLine) break
    index = i
  }
  return index
}

export function OutlinePanel() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const viewMode = useUiStore((state) => state.viewMode)
  const setViewMode = useUiStore((state) => state.setViewMode)
  /** 光标行（编辑器装配层节流后写入；阅读视图里没有光标 → `null`）。 */
  const cursorLine = useCursorStore((state) => state.line)
  const setOutlineLevels = useUiStore((state) => state.setOutlineLevels)
  const vaultRoot = useVaultStore((state) => state.info?.rootPath ?? state.lastRoot)

  const deferredText = useDeferredValue(text)
  const headings = useMemo(() => parseOutline(deferredText), [deferredText])
  const depths = useMemo(() => outlineDepths(headings), [headings])

  /**
   * 级别过滤：订阅的是"当前 Vault 的那一份"，没有就落到模块级常量（全亮）。
   *
   * 这里刻意保持**引用稳定**（没设置过时返回同一个常量）：下面算可见条目的 `useMemo`
   * 以它为依赖，每次渲染都新建一个数组会让那份 memo 每次都失效 —— 那样"过滤后的可见
   * 列表"就等于没缓存，与"面板只在光标行号真的变了时重渲染"的既有设计意图相冲突。
   */
  const storedLevels = useUiStore((state) =>
    vaultRoot === null ? undefined : state.outlineLevelsByVault[vaultRoot],
  )
  const levels = storedLevels ?? ALL_HEADING_LEVELS
  const levelSet = useMemo(() => new Set(levels), [levels])

  /**
   * 折叠集合：`note` 是它属于哪篇笔记，换笔记即视为空（理由见文件头）。
   *
   * 为什么不用 `useEffect` 在切笔记时清空：那会多一帧"上篇笔记的折叠还在新笔记上生效"
   * 的中间态，而且要多一次渲染。把"属于哪篇"记在状态里，渲染时直接判等，没有中间态。
   */
  const [collapse, setCollapse] = useState<{ note: string | null; ordinals: ReadonlySet<number> }>(
    () => ({ note: null, ordinals: NO_COLLAPSE }),
  )
  const collapsed = collapse.note === relPath ? collapse.ordinals : NO_COLLAPSE

  /**
   * 阅读视图里"读到哪一节"：视口顶部最后一个标题的序号（由滚动订阅回报）。
   *
   * 与编辑视图的"当前章节"是同一件事的两种来源：那边是光标行，这边是滚动位置。
   * 语义因此统一为"你正看着的那一节"，而不是两个视图各说一套。
   */
  const [visibleOrdinal, setVisibleOrdinal] = useState(-1)
  useEffect(() => {
    if (viewMode !== 'read') {
      setVisibleOrdinal(-1)
      return
    }
    // 订阅放在 effect 里：切走阅读视图（或换笔记）时必须撤掉，否则滚动监听会越挂越多
    return subscribeVisibleHeading(setVisibleOrdinal)
  }, [viewMode, relPath, deferredText])

  const activeIndex = useMemo(
    () => (viewMode === 'read' ? visibleOrdinal : currentHeadingIndex(headings, cursorLine)),
    [viewMode, visibleOrdinal, headings, cursorLine],
  )

  /** 可见条目（过滤 + 折叠一次算完）。依赖都是稳定引用 —— 见上面两处注释。 */
  const rows = useMemo(
    () => buildOutlineRows(headings, depths, levelSet, collapsed),
    [headings, depths, levelSet, collapsed],
  )

  /** 当前章节真的被藏起来了（被过滤掉，或落在某个收起的章节里）。 */
  const activeHeading = activeIndex >= 0 ? headings[activeIndex] : undefined
  const activeHidden =
    activeHeading !== undefined && !rows.some((row) => row.ordinal === activeIndex)

  const toggleLevel = useCallback(
    (level: number): void => {
      // 没有 Vault 就没有"按 Vault 存"的地方（正常路径上打不开笔记，也就到不了这里）
      if (vaultRoot === null) return
      // 从 store 现读而不是用渲染时捕获的 `levels`：连续两次改动落在同一批渲染里时
      // （键盘连按、以及测试里同一个 act 里点两下），闭包里的值会是旧的，
      // 后一次就会把前一次的选择覆盖掉。偏好改动必须是"读最新值再改"。
      const current = useUiStore.getState().outlineLevelsByVault[vaultRoot] ?? ALL_HEADING_LEVELS
      setOutlineLevels(vaultRoot, toggleHeadingLevel(current, level))
    },
    [vaultRoot, setOutlineLevels],
  )

  const showAllLevels = useCallback((): void => {
    if (vaultRoot === null) return
    setOutlineLevels(vaultRoot, ALL_HEADING_LEVELS)
  }, [vaultRoot, setOutlineLevels])

  const toggleCollapse = useCallback(
    (ordinal: number): void => {
      setCollapse((previous) => {
        const current = previous.note === relPath ? previous.ordinals : NO_COLLAPSE
        const next = new Set(current)
        if (next.has(ordinal)) next.delete(ordinal)
        else next.add(ordinal)
        return { note: relPath, ordinals: next }
      })
    },
    [relPath],
  )

  const jump = useCallback(
    (heading: OutlineHeading, ordinal: number): void => {
      if (viewMode === 'read') {
        if (scrollPreviewToHeading(ordinal)) return
        // 预览还没挂上（或这一节还没渲染出来）：退回编辑视图，至少能到那一行
      }
      if (viewMode !== 'edit') setViewMode('edit')
      // 切到编辑视图后编辑器要等到下一次提交才存在，因此排到下一帧再跳
      requestAnimationFrame(() => {
        jumpToLineInOpenNote(heading.line)
      })
    },
    [viewMode, setViewMode],
  )

  /**
   * 头部计数：默认（没有过滤、没有折叠）时就是标题总数，与从前一致；
   * 只有真的藏起来了几条才补一个分母 —— 那正是"还有 N 条没显示"要回答的问题。
   */
  const countLabel =
    rows.length === headings.length ? String(headings.length) : `${rows.length}/${headings.length}`

  return (
    <aside className="mn-outline" aria-label="大纲">
      <header className="mn-outline__head">
        <span className="mn-outline__title">
          <Icon name="outline" size="xs" /> 大纲
        </span>
        <span className="mn-outline__count">{countLabel}</span>
      </header>

      {/* 级别过滤条：没有打开笔记时不出现 —— 那时候连"要过滤什么"都还没有 */}
      {relPath !== null && (
        <div className="mn-outline__levels" role="group" aria-label="标题级别过滤">
          {ALL_HEADING_LEVELS.map((level) => {
            const on = levelSet.has(level)
            return (
              <button
                key={level}
                type="button"
                className={`mn-outline__level${on ? ' mn-outline__level--on' : ''}`}
                data-outline-level={level}
                // `aria-pressed`：读屏软件念的是"显示 H2 级标题，按下/未按下"，
                // 单靠一个亮起来的方块对它们完全不可见
                aria-pressed={on}
                title={`${on ? '不再显示' : '显示'} H${level} 级标题`}
                onClick={() => toggleLevel(level)}
              >
                H{level}
              </button>
            )
          })}
        </div>
      )}

      {/*
        当前章节被藏着时的交代。放在列表之前（而不是塞进列表里）：它描述的是"面板里
        找不到那一条"这件事本身，与列表内容无关，也不该占用一个条目的位置。
      */}
      {activeHidden && activeHeading !== undefined && (
        <p className="mn-outline__hidden" data-outline-hidden-current={activeHeading.line}>
          当前章节（第 {activeHeading.line} 行）没有显示在列表里
        </p>
      )}

      {relPath === null ? (
        <p className="mn-empty__text mn-outline__empty">没有打开的笔记</p>
      ) : headings.length === 0 ? (
        <p className="mn-empty__text mn-outline__empty">
          这篇笔记还没有标题。用 <code>#</code> 开头的行就是标题。
        </p>
      ) : rows.length === 0 ? (
        <div className="mn-outline__empty">
          <p className="mn-empty__text">当前过滤条件下没有标题。</p>
          <button type="button" className="mn-button mn-outline__reset" onClick={showAllLevels}>
            显示全部级别
          </button>
        </div>
      ) : (
        <nav className="mn-outline__list">
          {rows.map((row) => (
            <div className="mn-outline__row" key={`${row.heading.line}-${row.heading.text}`}>
              {row.hasChildren ? (
                <button
                  type="button"
                  className={`mn-outline__toggle${row.collapsed ? '' : ' mn-outline__toggle--open'}`}
                  data-outline-collapse={row.heading.line}
                  // 手风琴的语义就是"这一节展开了没有"，读屏与测试都读它
                  aria-expanded={!row.collapsed}
                  aria-label={`${row.collapsed ? '展开' : '收起'}「${
                    row.heading.text === '' ? '（空标题）' : row.heading.text
                  }」下的子标题`}
                  onClick={() => toggleCollapse(row.ordinal)}
                >
                  <Icon name="chevron" size="xs" />
                </button>
              ) : (
                // 没有子标题的条目也占住这一列：左边缘才对得齐（与文件树同一个做法）
                <span className="mn-outline__toggle mn-outline__toggle--placeholder" aria-hidden="true" />
              )}
              <button
                type="button"
                className={
                  'mn-outline__item' +
                  ` mn-outline__item--h${row.heading.level}` +
                  (row.ordinal === activeIndex ? ' mn-outline__item--current' : '')
                }
                // 缩进只按层级算（不随过滤变化）：打开/关掉某一级时，剩下条目的方位不该重排
                style={{ paddingLeft: 8 + row.depth * INDENT_STEP }}
                data-outline-line={row.heading.line}
                // `aria-current="location"`：读屏软件会念出"当前"（纯颜色高亮对它们不可见）
                aria-current={row.ordinal === activeIndex ? 'location' : undefined}
                title={`第 ${row.heading.line} 行 · ${'#'.repeat(row.heading.level)} ${row.heading.text}`}
                onClick={() => jump(row.heading, row.ordinal)}
              >
                {row.heading.text === '' ? '（空标题）' : row.heading.text}
              </button>
            </div>
          ))}
        </nav>
      )}
    </aside>
  )
}

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

import { scrollPreviewToHeading, subscribeVisibleHeading } from './outline-scroll'
import './outline.css'

/** 每一项的缩进步长（像素），与 `outline.css` 里的 padding 计算一致。 */
const INDENT_STEP = 12

/**
 * "当前章节"：最后一个**不晚于**光标行的标题。
 *
 * 用 `<=` 而不是"行号完全相等"：光标落在标题下面的正文里时，用户看到的仍然是那一章
 * （这正是"我在哪一节"的含义）。返回下标而不是标题对象 —— 渲染时要按它打标记。
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

  const deferredText = useDeferredValue(text)
  const headings = useMemo(() => parseOutline(deferredText), [deferredText])
  const depths = useMemo(() => outlineDepths(headings), [headings])

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

  return (
    <aside className="mn-outline" aria-label="大纲">
      <header className="mn-outline__head">
        <span className="mn-outline__title">
          <Icon name="outline" size={13} /> 大纲
        </span>
        <span className="mn-outline__count">{headings.length}</span>
      </header>

      {relPath === null ? (
        <p className="mn-empty__text mn-outline__empty">没有打开的笔记</p>
      ) : headings.length === 0 ? (
        <p className="mn-empty__text mn-outline__empty">
          这篇笔记还没有标题。用 <code>#</code> 开头的行就是标题。
        </p>
      ) : (
        <nav className="mn-outline__list">
          {headings.map((heading, ordinal) => (
            <button
              key={`${heading.line}-${heading.text}`}
              type="button"
              className={
                'mn-outline__item' +
                ` mn-outline__item--h${heading.level}` +
                (ordinal === activeIndex ? ' mn-outline__item--current' : '')
              }
              style={{ paddingLeft: 8 + (depths[ordinal] ?? 0) * INDENT_STEP }}
              data-outline-line={heading.line}
              // `aria-current="location"`：读屏软件会念出"当前"（纯颜色高亮对它们不可见）
              aria-current={ordinal === activeIndex ? 'location' : undefined}
              title={`第 ${heading.line} 行 · ${'#'.repeat(heading.level)} ${heading.text}`}
              onClick={() => jump(heading, ordinal)}
            >
              {heading.text === '' ? '（空标题）' : heading.text}
            </button>
          ))}
        </nav>
      )}
    </aside>
  )
}

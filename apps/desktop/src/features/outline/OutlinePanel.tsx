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

import { useCallback, useDeferredValue, useMemo } from 'react'

import { useUiStore } from '@/state/ui-store'
import { Icon } from '@/components/Icon'
import { outlineDepths, parseOutline, type OutlineHeading } from '@/domain/outline'
import { jumpToLineInOpenNote } from '@/features/editor/line-jump'
import { useNoteStore } from '@/state/note-store'

import { scrollPreviewToHeading } from './outline-scroll'
import './outline.css'

/** 每一项的缩进步长（像素），与 `outline.css` 里的 padding 计算一致。 */
const INDENT_STEP = 12

export function OutlinePanel() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const viewMode = useUiStore((state) => state.viewMode)
  const setViewMode = useUiStore((state) => state.setViewMode)

  const deferredText = useDeferredValue(text)
  const headings = useMemo(() => parseOutline(deferredText), [deferredText])
  const depths = useMemo(() => outlineDepths(headings), [headings])

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
              className={`mn-outline__item mn-outline__item--h${heading.level}`}
              style={{ paddingLeft: 8 + (depths[ordinal] ?? 0) * INDENT_STEP }}
              data-outline-line={heading.line}
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

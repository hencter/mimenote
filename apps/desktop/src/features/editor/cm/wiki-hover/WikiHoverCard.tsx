/**
 * 悬停预览卡片的**卡面**（只有 DOM 与布局，没有命中判定）。
 *
 * ## 为什么正文交给 `StaticNotePreview`
 *
 * 渲染管线只有一份（`domain/markdown.ts` + DOMPurify，经 `StaticNotePreview` 消费）。
 * 图谱浮窗（`features/graph/FloatingNote.tsx`）与非当前分栏的叶子用的都是它 ——
 * 卡片再写一条"读 `noteRead` → `renderMarkdown` → 贴链接标注"的链路，就等于把净化、
 * frontmatter 剥离、悬空链接的标注规则各复制一份，迟早出现"浮窗里对、卡片里错"。
 *
 * ## 为什么这一层刻意**没有**任何交互能力
 *
 * 卡片是只读的：不写盘、不进标签页、不拖不缩（与图谱浮窗同一条纪律）。它唯一的"活"是
 * 内部链接可点 —— 那是 `StaticNotePreview` 现成的行为（走 `openNote` 的完整打开流程）。
 * 卡片自己**绝不**实现"打开笔记"这类动作：一旦它能把用户带离当前笔记，就得处理
 * "跳转之后卡片还停在哪儿"这种问题，而那个问题的正确答案是"收起卡片"，不是"卡片跟着走"。
 *
 * ## 事件为什么在卡面自己身上截住
 *
 * 卡片的宿主是 `.cm-editor`（CodeMirror 的根元素），而编辑器在内容区上有自己的
 * mousedown 处理。不拦的话，用户点卡片正文会**同时**发生两件事：链接被点开，
 * 以及编辑器把这次点击当成"点了外面"（光标跳走、失焦）。
 * 这里用捕获阶段把 mousedown / wheel / click 截在卡片内部：
 * `StaticNotePreview` 自己的 React 处理器挂在**卡片根**上，捕获阶段在上、冒泡阶段在下，
 * 所以拦下来不会顺手拦掉它自己的链接点击。
 *
 * 代价写在 `wiki-hover.css` 里：卡片里的文字确实**拖不出选区到编辑器**（本来也不需要）。
 */

import { useCallback } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'

import { displayName } from '@/domain/paths'
import { StaticNotePreview } from '@/features/preview/StaticNotePreview'

export interface WikiHoverCardProps {
  /** 目标笔记的 Vault 相对路径（已解析，绝不可能是悬空链接）。 */
  relPath: string
}

/** 卡片根元素的类名（宿主与测试都读它；CSS 在同一目录的 `wiki-hover.css`）。 */
export const WIKI_HOVER_CLASS = 'mn-wiki-hover'

/**
 * 截住那些会"漏"到编辑器上去的事件。
 *
 * 用**捕获**而不是冒泡：React 的事件委托挂在卡片根上（`createRoot` 的容器），
 * 捕获阶段比它更早，因此"拦住编辑器"与"放行卡片自己的处理器"可以同时成立。
 * `preventDefault` 只对 mousedown 调 —— 它的作用是别让这次点击把焦点从编辑器挪走
 * （挪走之后光标所在行的"露出原文"会当场失效，观感上像点了卡片正文就坏了一次）。
 */
function stopAtCard(
  event: { stopPropagation: () => void; preventDefault: () => void },
  prevent: boolean,
): void {
  event.stopPropagation()
  if (prevent) event.preventDefault()
}

export function WikiHoverCard({ relPath }: WikiHoverCardProps): JSX.Element {
  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>): void => {
    stopAtCard(event, true)
  }, [])
  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>): void => {
    stopAtCard(event, false)
  }, [])
  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>): void => {
    // 卡片的滚轮只滚自己：不拦的话，滚到尽头之后编辑器接管，用户会看到"卡片没动、正文滚了"
    stopAtCard(event, false)
  }, [])

  return (
    <section
      className={WIKI_HOVER_CLASS}
      // `role="dialog"`：屏幕阅读器会把它读成"出现在当前上下文里的一个窗口"，
      // 与图谱浮窗同一个口径（那里也是 dialog + aria-modal={false}）
      role="dialog"
      aria-modal={false}
      aria-label={`${displayName(relPath)}（悬停预览，只读）`}
      data-mn-wiki-hover={relPath}
      onMouseDownCapture={onMouseDown}
      onClickCapture={onClick}
      onWheelCapture={onWheel}
    >
      <header className={`${WIKI_HOVER_CLASS}__header`}>
        <span className={`${WIKI_HOVER_CLASS}__title`} title={relPath}>
          {displayName(relPath)}
        </span>
        <span className={`${WIKI_HOVER_CLASS}__path`} title={relPath}>
          {relPath}
        </span>
      </header>
      {/* 正文：唯一那条渲染管线；类名是本卡片自己的钩子（样式见 wiki-hover.css） */}
      <StaticNotePreview
        relPath={relPath}
        className={`${WIKI_HOVER_CLASS}__body`}
        articleClassName={`${WIKI_HOVER_CLASS}__article`}
        errorClassName={`${WIKI_HOVER_CLASS}__error`}
      />
    </section>
  )
}
/**
 * Live Preview 的内联 widget。
 *
 * 只做 DOM、不做数据：能不能显示图片由装饰层决定（授权是异步的），
 * 这里只负责把"已授权的 URL"或"占位文本"变成元素。
 */

import { WidgetType } from '@codemirror/view'

/** 取一个人类可读的标签（说明文字优先，其次文件名）。 */
function labelFor(rel: string, alt: string): string {
  if (alt.trim() !== '') return alt.trim()
  const name = rel.split('/').pop()
  return name === undefined || name === '' ? rel : name
}

/**
 * 图片 widget：`![说明](路径)` 在光标不在该行时被它替换。
 *
 * 为什么 `url === null` 时要退成**文本**而不是空 `<img>`：没有授权、路径越界、
 * 文件被删、浏览器预览模式都会走到这里，留一个裂图比"没有图片"更糟
 * （与预览面板 `imagePlaceholderHtml` 的取舍一致）。
 *
 * 呈现上是**块级**的（见 `theme.ts` 里 `.mn-md-image-wrap` 的说明）：它在两行之间独占一行。
 * 这里只给类名，块级/尺寸全部归样式层 —— widget 是纯 DOM、不做布局决策。
 */
export class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string | null,
    private readonly rel: string,
    private readonly alt: string,
  ) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.rel === this.rel &&
      other.alt === this.alt
    )
  }

  override toDOM(): HTMLElement {
    if (this.url === null) {
      const placeholder = document.createElement('span')
      placeholder.className = 'mn-md-image-placeholder'
      placeholder.textContent = `▧ ${labelFor(this.rel, this.alt)}`
      placeholder.title = this.rel
      return placeholder
    }

    const wrap = document.createElement('span')
    wrap.className = 'mn-md-image-wrap'
    const image = document.createElement('img')
    // `mn-md-image` 是加载失敗事件的识别依据（插件在 contentDOM 上以捕获阶段监听 error）
    image.className = 'mn-md-image'
    image.src = this.url
    image.alt = this.alt
    image.loading = 'lazy'
    image.decoding = 'async'
    image.title = this.rel
    wrap.appendChild(image)
    return wrap
  }

  /**
   * 图片 widget 内部的点击**交给编辑器忽略**：点图片不该把光标塞进这一行源码里
   * （那会让图片立刻变回 `![说明](路径)`，看起来像"点一下就坏了"）。
   * 想编辑这一行，点它旁边的空白或文字即可 —— 块级盒子只占图片自身的宽度
   * （`.mn-md-image-wrap` 的 `width: fit-content`），右边的空白仍然是可点的一行。
   */
  override ignoreEvent(): boolean {
    return true
  }
}

/**
 * 任务列表复选框。
 *
 * 为什么不用真的 `<input type="checkbox">`：它位于 `contenteditable` 的正文里，
 * 焦点与编辑行为会互相打架。这里用 span + `role="checkbox"`，点击交给插件的
 * mousedown 处理（并写回文档，见 task.ts）。
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly markerFrom: number,
  ) {
    super()
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.markerFrom === this.markerFrom
    )
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'mn-md-task-box mn-md-task-box--checked' : 'mn-md-task-box'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('data-mn-task', String(this.markerFrom))
    box.setAttribute('title', this.checked ? '点击标记为未完成' : '点击标记为已完成')
    box.textContent = this.checked ? '✓' : ''
    return box
  }

  /**
   * 复选框的点击必须由插件处理，所以这里**不能**返回 true。
   *
   * CodeMirror 在派发事件前会先走 `eventBelongsToEditor`：只要事件路径上有一个
   * `ignoreEvent() === true` 的 widget，事件就被整个丢掉 —— 连插件自己的 mousedown 也收不到
   * （真实踩过：复选框点了没反应）。所以返回 false，并由处理器 `preventDefault()`
   * 挡掉编辑器默认的"移动光标"。
   */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 分隔线 `---` 的 widget：一条真正的横线，而不是三个减号。 */
export class HorizontalRuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof HorizontalRuleWidget
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'mn-md-hr'
    return rule
  }

  /** 点一下横线：交给编辑器放光标（于是这一行会露出 `---` 原文，方便改） */
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 阅读视图里代码块的"复制"按钮（含语言标签）。
 *
 * 为什么是"渲染完再挂按钮"，而不是在 Markdown 渲染阶段就生成按钮：
 * 预览的 HTML 要过 DOMPurify（见 `domain/markdown.ts` 的两道防线），任何按钮/属性
 * 都可能被净化掉；而且渲染层是纯函数（`renderMarkdown`），它不该知道"有个按钮"。
 * 于是按钮用**委托**的方式挂：这里只管 DOM，点击由 `MarkdownPreview` 的委托处理。
 *
 * 为什么按钮挂在 `<pre>` 内部而不是包一层容器：包一层就要替换 React（`dangerouslySetInnerHTML`）
 * 拥有的节点，而它下次渲染会整块重建 —— 包裹层会跟着消失，逻辑得再想一遍"什么时候重建"。
 * 只用 `<pre>` 绝对定位的按钮是纯粹的附加物，重建即重挂，没有中间态。
 *
 * 副作用可逆：按钮与定时器都记在返回的清理函数里，卸载/重新渲染时一并清掉。
 */

import { copyText } from '@/domain/clipboard'

/** 复制按钮的类名（E2E 与样式共用，避免字符串散落）。 */
export const CODE_COPY_CLASS = 'mn-code-copy'

/** "已复制"提示停留时长（毫秒）。 */
export const CODE_COPY_FEEDBACK_MS = 1_200

/** 按钮上的语言标签类名。 */
const CODE_LANG_CLASS = 'mn-code-lang'

/** 从 `code` 元素的 class 里取语言（markdown-it 写成 `language-ts`）。 */
function languageOf(code: Element): string {
  const match = /(?:^|\s)language-([\w+#.-]+)/u.exec(code.className)
  return match?.[1] ?? ''
}

/**
 * 给 `root` 里每个代码块挂一个复制按钮，返回清理函数。
 *
 * 幂等：已经挂过的代码块会跳过（同一份 HTML 重复跑不会出现两个按钮）。
 */
export function attachCodeCopyButtons(root: HTMLElement | null): () => void {
  if (root === null) return () => undefined

  const attached: HTMLElement[] = []

  for (const element of Array.from(root.querySelectorAll('pre'))) {
    const code = element.querySelector('code')
    if (code === null) continue
    if (element.querySelector(`.${CODE_COPY_CLASS}`) !== null) continue

    const language = languageOf(code)
    if (language !== '') {
      const label = document.createElement('span')
      label.className = CODE_LANG_CLASS
      // 语言标签只是装饰（给"这段是什么"一个提示），读屏软件不需要为它多念一句
      label.setAttribute('aria-hidden', 'true')
      label.textContent = language
      element.appendChild(label)
      attached.push(label)
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = CODE_COPY_CLASS
    button.textContent = '复制'
    button.setAttribute('aria-label', language === '' ? '复制代码' : `复制 ${language} 代码`)
    // 数据放在按钮上而不是闭包里：点击由委托处理，闭包拿不到"是哪个按钮"。
    // 去掉**一个**行尾换行：渲染出来的 `code` 文本总带着围栏那行的收尾换行，
    // 直接复制会让粘贴出来的每段代码都多一个空行（只去一个，正文里的空行保留）
    button.dataset.mnCode = (code.textContent ?? '').replace(/\n$/u, '')
    element.appendChild(button)
    attached.push(button)
  }

  return () => {
    for (const node of attached) node.remove()
  }
}

/**
 * 处理一次对复制按钮的点击；返回是否处理了（不是复制按钮就返回 false）。
 *
 * 反馈走按钮自己的文字（"已复制"），而不是 toast：复制是高频小动作，
 * 弹 toast 会盖住正文，而按钮就在鼠标下面，改字最省事。
 */
export function handleCodeCopyClick(target: Element): boolean {
  const button = target.closest(`.${CODE_COPY_CLASS}`)
  if (!(button instanceof HTMLButtonElement)) return false

  const text = button.dataset.mnCode ?? ''
  const restore = (): void => {
    button.textContent = '复制'
  }

  void copyText(text).then((ok) => {
    button.textContent = ok ? '已复制' : '复制失败'
    const timer = setTimeout(restore, CODE_COPY_FEEDBACK_MS)
    // 定时器不逐个登记（按钮可能在下一次渲染里被整块替换掉），
    // 到点后如果按钮已经脱离文档，这次赋值就是一次无害的空操作
    void timer
  })
  return true
}

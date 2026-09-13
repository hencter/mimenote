/**
 * 图片灯箱：点预览里的图片放大看（缩放 / 关闭 / 键盘 / 焦点归还）。
 *
 * 为什么用 **document 级捕获监听**，而不是让预览组件把点击转发过来：
 * 1. 预览的正文是 `dangerouslySetInnerHTML` 渲染的，React 手里没有那些 `<img>` 的引用，
 *    只能在**别人**的容器上挂委托 —— 那等于把"图片能不能点"写进预览组件的点击处理里，
 *    以后任何一次预览改动都可能顺手把它弄坏；
 * 2. 捕获阶段先于 `<a>` 的默认行为与预览自己的点击处理生效：`[![图](x.png)](别的笔记.md)`
 *    这种写法里点图片应该放大，而不是跳去另一篇笔记；
 * 3. 命中判定精确到 `img.mn-image`：占位元素、灯箱自己的大图、编辑器里的图片都不受影响，
 *    队列里的其它点击（wikilink、外链）完全不必知道这个组件的存在。
 *
 * 打开条件里**排除加载失败**的图片（`complete && naturalWidth === 0`）：那类图预览层已经
 * 就地换成了占位元素，把一个裂图放大只会比"点了没反应"更让人困惑。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import './lightbox.css'
// 预览里图片的呈现细节（图注 / 骨架 / 超大图限制）与灯箱属于同一件事：都只服务"图片"这个特性。
// 单独一个文件是因为 `styles/app.css` 不在本特性的可改范围，而这些规则必须与 `domain/markdown.ts`
// 渲染出来的 `.mn-figure / .mn-image__caption / .mn-image__hint` 成对维护（类名改一处就要改两处）。
import './preview-image.css'

/** 缩放上下限：下限避免缩到看不见，上限避免小图被放成马赛克。 */
const MIN_SCALE = 0.25
const MAX_SCALE = 8
/** 缩放步长：按钮与键盘共用，保证两种操作结果一致。 */
const ZOOM_STEP = 1.25
/** 方向键平移步长（像素）。 */
const PAN_STEP = 60

interface LightboxTarget {
  /** 实际显示的地址（已授权的 asset URL；不再走解析层）。 */
  src: string
  /** 无障碍文本：图注为空时仍然有东西可读。 */
  alt: string
  /** 图注（渲染层给出的 alt/标题）。 */
  caption: string
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/**
 * 这张图现在能不能放大：返回要显示的地址，不能则返回 `null`。
 *
 * `currentSrc` 优先：将来若引入 `srcset`，用户看到的那张与放大后看到的必须是同一张。
 */
function openableSrc(image: HTMLImageElement): string | null {
  const src = image.currentSrc !== '' ? image.currentSrc : image.src
  if (src === '') return null
  if (image.complete && image.naturalWidth === 0) return null
  return src
}

/** 图注：优先用渲染层已经写好的图注元素，退到 `alt`，最后退到原始地址（至少说明缺的是哪张图）。 */
function captionOf(image: HTMLImageElement): string {
  const rendered = image.closest('.mn-figure')?.querySelector('.mn-image__caption')?.textContent
  if (rendered !== undefined && rendered !== null && rendered.trim() !== '') return rendered.trim()
  const alt = (image.getAttribute('alt') ?? '').trim()
  if (alt !== '') return alt
  return image.getAttribute('data-mn-src') ?? ''
}

export function ImageLightbox() {
  const [target, setTarget] = useState<LightboxTarget | null>(null)
  /** 相对"适应窗口"的缩放倍数；1 = 正好铺满舞台（不是"1 像素比 1 像素"）。 */
  const [scale, setScale] = useState(1)
  /** 大图加载失败（文件被删/被移走）：就地给一句说明，而不是留个裂图或直接闪退。 */
  const [failed, setFailed] = useState(false)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback((): void => {
    setTarget(null)
    setFailed(false)
    setScale(1)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  const open = useCallback((next: LightboxTarget): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setFailed(false)
    setScale(1)
    setTarget(next)
  }, [])

  // 委托监听（捕获阶段，document 级）：理由见文件头
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return
      // 带修饰键的点击留给浏览器（复制图片地址等），别抢
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const node = event.target
      if (!(node instanceof Element)) return
      const image = node.closest('img.mn-image')
      if (!(image instanceof HTMLImageElement)) return
      const src = openableSrc(image)
      if (src === null) return
      open({ src, alt: image.getAttribute('alt') ?? '', caption: captionOf(image) })
      // 图片可能被包在链接里：拦掉默认跳转，也别让预览的点击处理器再开一篇笔记
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
    }
  }, [open])

  // 打开即把焦点收进对话框（否则 Tab 会从背后的文件树开始走）
  useEffect(() => {
    if (target === null) return
    dialogRef.current?.focus()
  }, [target])

  /**
   * 给"被超大图封顶裁短"的图片打标记（`data-mn-clipped`），让"点击查看原图"常驻显示，
   * 而不是只有悬停才看得见 —— 那正是最需要这个提示的情况。
   *
   * 为什么放在这里：判断"是不是被裁短了"必须等浏览器解码完（`naturalHeight` 对
   * `clientHeight`），而预览组件不该为了一个角标多出一个监听；标记只是**呈现**层的附加信息，
   * 丢了也只是退回"悬停才提示"，所以不需要 React 参与（预览重渲染会换成新节点，下一次
   * `load` 再打一遍）。`load` 不冒泡，因此同样走捕获阶段。
   */
  useEffect(() => {
    const mark = (image: HTMLImageElement): void => {
      const figure = image.closest('.mn-figure')
      if (figure === null) return
      const decoded = image.naturalHeight
      const shown = image.clientHeight
      // 显示高度明显小于解码高度 = 被 `max-height` 压过（允许 1px 的舍入）
      if (decoded > 0 && shown > 0 && decoded - shown > 1) {
        figure.setAttribute('data-mn-clipped', '1')
      } else {
        figure.removeAttribute('data-mn-clipped')
      }
    }
    const onLoad = (event: Event): void => {
      const node = event.target
      if (node instanceof HTMLImageElement && node.classList.contains('mn-image')) mark(node)
    }
    document.addEventListener('load', onLoad, true)
    // 组件挂载可能晚于图片加载（缓存命中）：补扫一次已经加载完的
    for (const image of Array.from(document.querySelectorAll<HTMLImageElement>('img.mn-image'))) {
      if (image.complete && image.naturalWidth > 0) mark(image)
    }
    return () => {
      document.removeEventListener('load', onLoad, true)
    }
  }, [])

  // 键盘：只在打开期间安装，关掉立刻还原 —— 编辑器与文件树的快捷键不受影响
  useEffect(() => {
    if (target === null) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      const stage = stageRef.current

      switch (event.key) {
        case 'Escape':
          // 先拦住事件：不拦的话，已经开着的其它层（命令面板等）会跟着一起关
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        case '+':
        case '=':
          event.preventDefault()
          setScale((current) => clampScale(current * ZOOM_STEP))
          return
        case '-':
        case '_':
          event.preventDefault()
          setScale((current) => clampScale(current / ZOOM_STEP))
          return
        case '0':
          event.preventDefault()
          setScale(1)
          return
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (stage === null) return
          event.preventDefault()
          // 直接改 scrollTop/scrollLeft：`scrollBy` 在 jsdom 里是"未实现"的空壳（会让测试报错），
          // 而且键盘平移要的就是"按一次走一格"，不需要平滑滚动。
          if (event.key === 'ArrowUp') stage.scrollTop -= PAN_STEP
          if (event.key === 'ArrowDown') stage.scrollTop += PAN_STEP
          if (event.key === 'ArrowLeft') stage.scrollLeft -= PAN_STEP
          if (event.key === 'ArrowRight') stage.scrollLeft += PAN_STEP
          return
        }
        case 'Tab': {
          // 模态焦点圈：Tab 不许跑到背后的文件树/编辑器上（`aria-modal` 的应有之义）
          const dialog = dialogRef.current
          if (dialog === null) return
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'),
          )
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (first === undefined || last === undefined) return
          const active = document.activeElement
          if (event.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              event.preventDefault()
              last.focus()
            }
            return
          }
          if (active === last) {
            event.preventDefault()
            first.focus()
          }
          return
        }
        default:
          return
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [target, close])

  if (target === null) return null

  return (
    <div
      className="mn-lightbox"
      role="presentation"
      // 点遮罩关闭：只有点在遮罩本身（而不是图片、工具栏）上才算
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="mn-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="mn-lightbox__toolbar">
          <span className="mn-lightbox__zoom" title="相对「适应窗口」的缩放" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="mn-button"
            title="缩小（-）"
            disabled={scale <= MIN_SCALE}
            onClick={() => setScale((current) => clampScale(current / ZOOM_STEP))}
          >
            缩小
          </button>
          <button
            type="button"
            className="mn-button"
            title="放大（+）"
            disabled={scale >= MAX_SCALE}
            onClick={() => setScale((current) => clampScale(current * ZOOM_STEP))}
          >
            放大
          </button>
          <button
            type="button"
            className="mn-button"
            title="恢复成适应窗口（0）"
            disabled={scale === 1}
            onClick={() => setScale(1)}
          >
            适应窗口
          </button>
          <button type="button" className="mn-button" title="关闭（Esc）" onClick={close}>
            关闭
          </button>
        </div>

        <div
          className="mn-lightbox__stage"
          ref={stageRef}
          // 大图周围那圈深色区域也属于"遮罩"：点它同样关闭（图片与工具栏不关）
          onClick={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          {failed ? (
            <p className="mn-lightbox__error">图片无法显示（可能已被移动或删除）</p>
          ) : (
            // 缩放用 max-width/max-height 的百分比实现（1 倍 = 适应窗口）：
            // 布局尺寸真的会跟着变，因此舞台能正常出现滚动条 —— 换成 transform: scale()
            // 只会把溢出部分裁掉，还没法平移。
            <img
              className="mn-lightbox__image"
              src={target.src}
              alt={target.alt}
              style={{ maxWidth: `${scale * 100}%`, maxHeight: `${scale * 100}%` }}
              onError={() => setFailed(true)}
            />
          )}
        </div>

        {target.caption !== '' && <p className="mn-lightbox__caption">{target.caption}</p>}
      </div>
    </div>
  )
}

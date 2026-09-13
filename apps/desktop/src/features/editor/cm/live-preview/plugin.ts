/**
 * Live Preview 的 ViewPlugin 装配：视口重算、点击交互、外部状态变化的重算触发。
 *
 * 三条纪律：
 * 1. **重算只在必要时发生**：文档变、选区变、视口变、或外部状态（链接索引 / 图片授权 /
 *    切换笔记）明确通知时才重算，而且只算 `view.visibleRanges`；
 * 2. **输入路径零 IO**：装饰计算本身不发请求；图片授权是在算完之后"这一屏出现过哪些图"
 *    一次性登记的（同一路径只请求一次，见 assets.ts）；
 * 3. **一切副作用可逆**：事件监听、store 订阅、授权订阅都在 `destroy()` 里解除
 *    （architecture.md §2 的"每个副作用都必须可逆"）。
 */

import { RangeSet, StateEffect, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view'

import { createNoteFromLink, openNote } from '@/app/actions'
import { createAssetResolver, type AssetResolver } from '@/domain/assets'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

import {
  flushAssets,
  lookupAsset,
  markAssetFailed,
  resetAssets,
  stageAsset,
  subscribeAssets,
} from './assets'
import { buildLivePreview } from './build'
import { toggleTaskAt } from './task'
import { LINK_ATTR, WIKILINK_ATTR, WIKILINK_RESOLVED_ATTR, livePreviewTheme } from './theme'
import type { LivePreviewContext } from './types'

/** 让 Live Preview 重算装饰（外部状态变了：链接索引回来、图片授权回来、换了笔记/Vault）。 */
export const livePreviewRefresh = StateEffect.define<null>()

/** 请求一次重算（不改变文档；因此不会污染撤销历史）。 */
export function refreshLivePreview(view: EditorView): void {
  view.dispatch({ effects: livePreviewRefresh.of(null) })
}

/**
 * 全库索引解析器的缓存。
 *
 * `createAssetResolver` 构造时要走一遍整张条目表（O(条目数)，1 万条目约几毫秒），
 * 而装饰是**每次按键**都会重算的 —— 所以只在 `entries` 换了新数组（打开/重扫 Vault、
 * 新建/删除/改名）时才重建，其余时候复用同一个解析器实例。
 */
let resolverEntries: readonly { relPath: string; isDir: boolean }[] | null = null
let resolver: AssetResolver | null = null

function assetResolverFor(entries: readonly { relPath: string; isDir: boolean }[]): AssetResolver {
  if (resolverEntries !== entries || resolver === null) {
    resolver = createAssetResolver(entries)
    resolverEntries = entries
  }
  return resolver
}

/** 读取当前上下文。每次重算都重新读，不做缓存 —— 链接与授权都是异步来的。 */
function livePreviewContext(): LivePreviewContext {
  const vault = useVaultStore.getState()
  return {
    noteRelPath: useNoteStore.getState().doc?.relPath ?? null,
    outbound: useLinksStore.getState().links?.outbound ?? [],
    resolveAsset: assetResolverFor(vault.entries),
    resolveImage: (rel) => {
      const rootPath = vault.info?.rootPath ?? null
      if (rootPath === null) return { kind: 'placeholder' }
      // 只登记，不发请求：真正的 IPC 在 flushAssets（这一屏算完之后一次批量）
      stageAsset(rootPath, rel)
      return lookupAsset(rootPath, rel)
    },
  }
}

/**
 * 点击交互（mousedown）。
 *
 * - 任务复选框 → 切换 `- [ ]` / `- [x]` 并**写回文档**（走既有保存流水线）；
 * - `[[wikilink]]` → 已解析打开、悬空创建（与预览面板一致）；
 * - `[文字](笔记.md)` → 同样走宿主出链表判断指向哪一篇；
 * - 按住 Alt 点击 = 不跳转，只把光标放进链接里编辑（否则纯点击被链接占用后，
 *   鼠标就没法改链接目标了 —— 这是刻意的取舍，不是遗漏）。
 */
function handleMouseDown(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false
  const target = event.target
  if (!(target instanceof Element)) return false

  const taskBox = target.closest('[data-mn-task]')
  if (taskBox !== null) {
    const at = Number(taskBox.getAttribute('data-mn-task'))
    event.preventDefault()
    toggleTaskAt(view, Number.isFinite(at) ? at : 0)
    return true
  }

  const element = target.closest(`[${WIKILINK_ATTR}], [${LINK_ATTR}]`)
  if (element === null) return false
  if (event.altKey) return false
  event.preventDefault()

  const noteRelPath = useNoteStore.getState().doc?.relPath ?? null
  const outbound = useLinksStore.getState().links?.outbound ?? []

  const wikiTarget = element.getAttribute(WIKILINK_ATTR)
  if (wikiTarget !== null) {
    const key = normalizeLinkTarget(wikiTarget)
    const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
    // 装饰上带的解析结果是"算的时候"的；store 里的可能更新，两者取其一即可
    const resolved =
      match?.resolvedRelPath ?? (element.getAttribute(WIKILINK_RESOLVED_ATTR) || null)
    if (resolved !== null) void openNote(resolved)
    else if (noteRelPath !== null) void createNoteFromLink(wikiTarget, noteRelPath)
    return true
  }

  const href = element.getAttribute(LINK_ATTR) ?? ''
  if (href === '') return true
  const key = normalizeLinkTarget(href)
  const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
  if (match?.resolvedRelPath != null) {
    void openNote(match.resolvedRelPath)
    return true
  }
  if (isInternalNoteHref(href)) {
    if (noteRelPath !== null) void createNoteFromLink(href, noteRelPath)
    return true
  }
  // 外部链接：不让 WebView 直接跳走（会丢掉整个界面），与预览面板同样的处理
  toast.info('外部链接未在应用内打开', `${href}（M2 之后接入系统浏览器打开）`)
  return true
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class LivePreview implements PluginValue {
    decorations: DecorationSet = Decoration.none
    atomicRanges: RangeSet<Decoration> = RangeSet.empty

    private readonly view: EditorView
    private readonly disposers: Array<() => void> = []

    constructor(view: EditorView) {
      this.view = view
      this.recompute()

      // 图片加载失败（作用域没覆盖到、文件被删、磁盘上是坏图）→ 就地降级成占位文本。
      // 用**捕获阶段**：`error` 事件不冒泡，挂在自己的 DOM 上拿不到。
      view.contentDOM.addEventListener('error', this.onImageError, true)
      this.disposers.push(() =>
        view.contentDOM.removeEventListener('error', this.onImageError, true),
      )

      // 宿主索引回来后，wikilink 的"已解析/悬空"要跟着变
      this.disposers.push(
        useLinksStore.subscribe((state, previous) => {
          if (state.links !== previous.links) refreshLivePreview(this.view)
        }),
      )
      // 切换笔记 / 从磁盘重新加载：`revision` 变了就重算（图片是相对笔记解析的）
      this.disposers.push(
        useNoteStore.subscribe((state, previous) => {
          if (
            state.doc?.relPath !== previous.doc?.relPath ||
            state.doc?.revision !== previous.doc?.revision
          ) {
            refreshLivePreview(this.view)
          }
        }),
      )
      // 换 Vault：授权缓存必须整体失效（键里含 Vault 根，但留着旧条目只会白占内存）。
      // 条目表变了（新建/删除/改名/重扫）也要重算：图片解析依赖全库索引。
      this.disposers.push(
        useVaultStore.subscribe((state, previous) => {
          if (state.info?.rootPath !== previous.info?.rootPath) {
            resetAssets()
            refreshLivePreview(this.view)
            return
          }
          if (state.entries !== previous.entries) refreshLivePreview(this.view)
        }),
      )
      // 授权结果（成功/失败）回来：换成真图或占位文本
      this.disposers.push(subscribeAssets(() => refreshLivePreview(this.view)))
    }

    private readonly onImageError = (event: Event): void => {
      const target = event.target
      if (target instanceof HTMLImageElement && target.classList.contains('mn-md-image')) {
        markAssetFailed(target.src)
      }
    }

    update(update: ViewUpdate): void {
      const forced = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(livePreviewRefresh)),
      )
      if (update.docChanged || update.selectionSet || update.viewportChanged || forced) {
        this.recompute()
      }
    }

    destroy(): void {
      for (const dispose of this.disposers) dispose()
      this.disposers.length = 0
    }

    /** 重算装饰：只覆盖视口，且不派发任何事务（纯展示层）。 */
    private recompute(): void {
      const result = buildLivePreview(this.view.state, livePreviewContext(), this.view.visibleRanges)
      this.decorations = result.decorations
      this.atomicRanges = result.atomicRanges
      // 把"这一屏出现过、但还没授权"的图片一次性交给宿主（同一路径只请求一次）
      flushAssets()
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        return handleMouseDown(event as MouseEvent, view)
      },
    },
  },
)

/** Live Preview 的扩展三件套：样式 + 装饰插件 + 原子区间。 */
export function livePreviewExtensions(): Extension[] {
  return [
    livePreviewTheme,
    livePreviewPlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(livePreviewPlugin)?.atomicRanges ?? RangeSet.empty,
    ),
  ]
}

/**
 * Live Preview 的装饰上下文与结果类型（纯类型，无 store / IO 依赖）。
 *
 * 为什么要有"上下文"这一层：装饰计算必须**廉价**且**可测**，所以它只吃三样东西 ——
 * 当前笔记路径、宿主索引给出的出链、以及一个**只读**的图片解析器。
 * 任何 IO（读文件、发 IPC）都不发生在这里：图片授权由插件在算完之后批量登记（见 assets.ts）。
 */

import type { RangeSet } from '@codemirror/state'
import type { Decoration, DecorationSet } from '@codemirror/view'

import type { AssetResolver } from '@/domain/assets'
import type { ResolvedLink } from '@/ipc/types'

/**
 * 一张图片此刻能不能显示。
 *
 * 授权是**异步**的（ADR-0007 逐文件授权），装饰层只读结果：
 * - `ready`：缓存里已有 asset URL，直接渲染 `<img>`；
 * - `placeholder`：还没授权 / 授权失败 / 不是 Tauri 运行时 —— 渲染等宽占位文本，
 *   **绝不留裂图**。
 */
export type ImageResolution = { kind: 'ready'; url: string } | { kind: 'placeholder' }

/** 装饰计算需要的外部信息（每次重算都重新读取，不缓存）。 */
export interface LivePreviewContext {
  /** 当前笔记的 Vault 相对路径（图片相对路径解析、悬空链接创建都要用它）。 */
  noteRelPath: string | null
  /** 当前笔记的出链（与预览面板同一套口径：`normalizeLinkTarget(rawTarget)` 匹配）。 */
  outbound: readonly ResolvedLink[]
  /**
   * 资源地址 → Vault 相对路径（`domain/assets.ts` 的 `createAssetResolver`）。
   *
   * 为什么由外部注入而不是在这里 new 一个：它带**全库索引**（处理 Obsidian 用户写的
   * `![[图.png]]` 裸文件名），索引必须在"条目表变化时"才重建 —— 那是接线层（plugin.ts）的活。
   * 返回 `null` = 解析不出（外部地址、越界）→ 占位文本，**不登记授权请求**。
   */
  resolveAsset: AssetResolver
  /** 只读查询图片：命中授权缓存就返回 asset URL，否则返回占位；**不发起请求**。 */
  resolveImage: (rel: string) => ImageResolution
}

/** 视口内的可视范围（与 `EditorView.visibleRanges` 同形，让领域层不依赖 view 类型）。 */
export interface VisibleRange {
  from: number
  to: number
}

/** 装饰计算结果。 */
export interface LivePreviewDecorationResult {
  /** 交给 `ViewPlugin.decorations` 的展示层装饰（不改变 `doc`）。 */
  decorations: DecorationSet
  /**
   * 被替换（隐藏）的区间，交给 `EditorView.atomicRanges`。
   *
   * 必要性：`Decoration.replace` 让原文不再显示，但它的**位置**还在文档里；
   * 不声明为原子区间，光标就能停在两个看不见的 `*` 之间，退格键也会删掉看不见的字符。
   */
  atomicRanges: RangeSet<Decoration>
}

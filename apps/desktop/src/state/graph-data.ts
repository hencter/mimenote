/**
 * 图谱的**数据装载**切片（zustand slice）。
 *
 * 一句话职责：从 IPC 拉全库图谱 / 自我中心子图、读回节点正文，并维护
 * `status / data / error / rootPath / ego / egoStatus / texts` 这些"数据本身"的状态。
 *
 * ## 两条加载路径：完整重载 vs 保留视角的刷新
 *
 * `load()` 默认是**完整重载**（"从头再来"）：换 Vault、用户点"重新读取图谱"时，视角、
 * 折叠、选中都属于**另一个上下文**，留着只会画出错的图。但"数据变新了"是另一回事 ——
 * 编辑完一篇笔记、自动保存成功、索引重建完成，这些都不该动用户的镜头：他好不容易把镜头
 * 对准某片区域，一次后台刷新就把他甩回"适应窗口"，下一次他就不敢相信这幅画布了。
 *
 * 把两件事合并成一个函数必然二选一（要么刷新时镜头乱跳，要么换 Vault 时残留脏状态），
 * 所以显式分成 `keepView: true` 与完整重载两条路。保留视角的刷新还必须**不闪白**：
 * 它不进 `loading` 状态（画布继续用旧数据渲染），只在 HUD 上给一个轻量指示；
 * 宿主返回空数据时同样保留旧数据并给提示（见 `load` 的实现）。
 *
 * 这两条路在 `load` 与 `loadEgo` 里都**按原样保留**，不许合并成一个函数：
 * 合并必然二选一（要么刷新时镜头乱跳，要么换 Vault 时残留脏状态）。
 *
 * 本切片只认识 `set/get` 与 IPC；需要视图/卡片字段时用 `get()` 交叉读（同一个 store），
 * 需要落盘时走 `graph-persist.ts`（本文件不直接碰 localStorage）。
 */

import type { StateCreator } from 'zustand'

import type { Point } from '@/domain/graph/geometry'
import { pruneManualPositions } from '@/domain/graph/layout'
import type { CardSize } from '@/domain/graph/prefs'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { GraphData } from '@/ipc/types'

import { flushPositions, loadCardSizes, readStoredPositions, toMap } from './graph-persist'
import type { GraphState } from './graph-store'
import { DEFAULT_VIEW } from './graph-view-store'
import { useVaultStore } from './vault-store'

/**
 * 一次 `notes_read_batch` 要几篇正文。
 *
 * 宿主逐篇读文件（本地磁盘），40 篇一批在 SSD 上是几毫秒级；批太大只会让"第一张卡片出现"
 * 的时间变长（我们要等这一批回来才排版），批太小则多几轮 IPC 往返。
 */
const TEXT_BATCH_SIZE = 40

/** 宿主返回空数据时给用户看的提示（保留视角的刷新专用）。 */
const EMPTY_NOTICE = '图谱这次没有返回任何节点（索引可能正在重建），当前显示的是上一次的结果'

/** 保留视角的刷新失败时的提示后缀。 */
const STALE_SUFFIX = '（当前显示的是上一次的结果）'

export type GraphStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 自我中心视图的三样东西：根、跳数、数据（前两者换掉即作废）。 */
export interface EgoSnapshot {
  /** 圆心那一篇（Vault 相对路径）。 */
  root: string
  /** 算这份数据时用的跳数：它也是"能不能保留视角"的判据之一。 */
  depth: number
  data: GraphData
}

export interface GraphLoadOptions {
  /** 数据是在索引构建期间拿的 ⇒ 索引就绪后要自动补一次。 */
  indexBuilding?: boolean
  /**
   * 保留视角的刷新：只更新 `nodes` / `edges`，保留缩放、偏移、选中、手工位置与折叠集合
   * （指向已消失笔记的手工位置与选中会被清掉）。
   *
   * 由调用方声明意图，但**换 Vault 时会被强制降级为完整重载**（见 `load`）——
   * 那种情况下"保留视角"没有意义，而且很容易写错。
   */
  keepView?: boolean
}

/** 数据切片：两份"数据本身"的状态 + 两个装载动作（加载路径的说明见文件头）。 */
export interface DataSlice {
  status: GraphStatus
  /** 节点与边；`null` 表示还没加载成功过。 */
  data: GraphData | null
  error: MimenoteError | null
  /** 当前数据属于哪个 Vault（换 Vault 即作废）。 */
  rootPath: string | null

  /** 加载时索引还在构建 ⇒ 索引就绪后自动补一次（不需要用户手动刷新）。 */
  staleIndex: boolean
  loadedAtMs: number

  /** 正在做"保留视角的刷新"：HUD 上的轻量指示，画布照常渲染旧数据（**不闪白**）。 */
  refreshing: boolean
  /** 上一次刷新留下的提示（空数据 / 刷新失败）；`null` = 一切正常。 */
  refreshNotice: string | null

  /** 自我中心子图（`null` = 还没拿到过；`status` 说明当前在干什么）。 */
  ego: EgoSnapshot | null
  egoStatus: GraphStatus
  egoError: MimenoteError | null

  /**
   * 圆心那一篇的正文（节点卡片画的是**完整 Markdown 预览**，不是摘要行）。
   *
   * 键是 Vault 相对路径。每次重载子图时**整体替换**：一篇笔记保存后，正文变了，
   * 旧的那份必须一起失效 —— 增量合并会让画布上留着上一次保存前的内容。
   */
  texts: ReadonlyMap<string, string>

  /** 拉一次自我中心子图（`relPath` 为 `null` = 没有打开的笔记，清空）。 */
  loadEgo: (relPath: string | null, options?: { keepView?: boolean }) => Promise<void>

  load: (rootPath: string | null, options?: GraphLoadOptions) => Promise<void>
  clear: () => void
}

/** 加载请求序号：连续切换 Vault / 手动刷新时只采纳最后一次。 */
let loadSeq = 0

/** 自我中心子图的请求序号（与全库那份**各算各的**：两种视图可以同时在途）。 */
let egoSeq = 0

export const createDataSlice: StateCreator<GraphState, [], [], DataSlice> = (set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  rootPath: null,
  staleIndex: false,
  loadedAtMs: 0,
  refreshing: false,
  refreshNotice: null,
  ego: null,
  egoStatus: 'idle',
  egoError: null,
  texts: new Map<string, string>(),

  load: async (rootPath, options = {}) => {
    if (rootPath === null) {
      get().clear()
      return
    }
    const previous = get()
    // 只有"同一个 Vault 且已经有数据"才谈得上保留视角：换 Vault 时旧的视角/折叠/手工位置
    // 都属于上一个 Vault，必须完整重载（哪怕调用方传了 keepView，也不该按它的意图走）。
    const keepView =
      options.keepView === true && previous.rootPath === rootPath && previous.data !== null

    const seq = ++loadSeq
    if (keepView) {
      // 保留视角的刷新**不进 `loading` 状态**：画布必须继续用旧数据渲染（否则会先闪一片白），
      // "正在刷新"只体现在 HUD 的轻量指示上。
      set({ refreshing: true })
    } else {
      // 完整重载顺手把"刷新中"按下去：可能有一次保留视角的刷新正在途中被这次完整重载取代
      // （序号一变它的响应就被丢弃），不按下去 HUD 上的指示会一直亮着。
      set({ status: 'loading', error: null, rootPath, refreshing: false })
    }

    try {
      const data = await ipc.graphData()
      if (seq !== loadSeq) return // 过期响应：丢弃
      const state = get()
      const empty = data.nodes.length === 0 && data.edges.length === 0

      if (keepView && empty) {
        // 宿主返回空 = 索引正在重建（或还没建好）。此时**保留旧数据**：把画布清空会让用户
        // 以为"笔记都没了"，而且重建完成后还得靠他自己再点一次刷新。
        // 只有在"保留视角的刷新"里才这样做 —— 显式的"重新读取"（keepView 为 false）照旧采纳
        // 空结果，那既是用户明确要求的"从头再来"，也是真正变空的 Vault 唯一能被画出来的路径。
        set({
          refreshing: false,
          refreshNotice: EMPTY_NOTICE,
          // 标记"数据可能是旧的"：索引一就绪就会自动再补一次（画布的索引订阅看这个标志）
          staleIndex: true,
        })
        return
      }

      // 手工位置：只清掉"确实已经从 Vault 里消失"的笔记。
      // `truncated` 时**不能**按"不在列表里"判定消失：宿主只返回了度数最高的一部分，
      // 没返回的笔记并不是被删了，清掉就等于把用户手工摆好的布局悄悄丢了。
      let manual: ReadonlyMap<string, Point>
      if (keepView) {
        // 保留视角的刷新**不重新读 localStorage**：内存里的手工位置可能还有一次防抖没落盘，
        // 重读会把用户刚拖过的位置吃掉（这也是"刷新"与"重新加载"的区别之一）。
        manual = data.truncated ? state.manual : pruneManualPositions(state.manual, data.nodes)
        // 真的清掉了东西就顺手落盘，别让已删除笔记的位置一直躺在 localStorage 里
        if (manual.size !== state.manual.size) flushPositions(rootPath, manual)
      } else {
        const stored = toMap(readStoredPositions()[rootPath])
        manual = data.truncated ? stored : pruneManualPositions(stored, data.nodes)
      }

      // 选中的卡片若已经不在数据里（笔记被删/改名），预览必须关掉 —— 否则面板会挂着一条
      // 指向不存在文件的路径。`truncated` 时同样不能判定"消失"（理由同手工位置）。
      const alive = data.truncated ? null : new Set(data.nodes.map((node) => node.relPath))
      const selected =
        state.selected !== null && alive !== null && !alive.has(state.selected)
          ? null
          : state.selected

      set({
        status: 'ready',
        data,
        error: null,
        rootPath,
        loadedAtMs: Date.now(),
        staleIndex: options.indexBuilding === true,
        refreshing: false,
        refreshNotice: null,
        manual,
        ...(keepView
          ? { selected }
          : {
              // 完整重载 = 真正的"从头再来"：视角回到适应窗口（`fitKey` 一并清空，
              // 画布据此重新适应一次），折叠与选中清空 —— 旧路径在新的数据里没有意义
              selected: null,
              collapsed: new Set<string>(),
              view: DEFAULT_VIEW,
              fitKey: null,
            }),
      })
    } catch (cause) {
      if (seq !== loadSeq) return
      if (keepView) {
        // 保留视角的刷新失败：**不能把 data 清空**（画布会瞬间变成白板并弹出全屏错误层），
        // 只记一条提示，让用户知道"看到的是上一次的结果"。
        set({
          refreshing: false,
          refreshNotice: `${describeError(MimenoteError.from(cause), '刷新图谱失败')}${STALE_SUFFIX}`,
        })
        return
      }
      set({ status: 'error', error: MimenoteError.from(cause), data: null })
    }
  },

  clear: () => {
    loadSeq += 1
    flushPositions(get().rootPath, get().manual)
    set({
      status: 'idle',
      data: null,
      error: null,
      rootPath: null,
      selected: null,
      collapsed: new Set<string>(),
      manual: new Map<string, Point>(),
      staleIndex: false,
      view: DEFAULT_VIEW,
      refreshing: false,
      refreshNotice: null,
      fitKey: null,
      // 卡片尺寸、浮动面板、力导向都跟着 Vault 一起作废（它们都是"这个 Vault 的视图状态"）
      cardSizes: new Map<string, CardSize>(),
      floatingPanes: [],
      ego: null,
      egoStatus: 'idle',
      egoError: null,
      texts: new Map<string, string>(),
      egoBounds: null,
    })
  },

  loadEgo: async (relPath, options = {}) => {
    if (relPath === null) {
      egoSeq += 1
      set({ ego: null, egoStatus: 'idle', egoError: null, texts: new Map<string, string>() })
      return
    }

    const seq = ++egoSeq
    const depth = get().depth
    const previous = get().ego
    /**
     * 这一份子图属于**哪个 Vault**。
     *
     * 为什么要在这里补一次：卡片尺寸（"我怎么看这一篇"）按 Vault 落盘，落盘的键就是这个
     * `rootPath`；它在过去只由全库视图的 `load()` 写入 —— 于是"默认入口是关系图"的用户
     * 调过的卡片尺寸**从来没被保存过**（下次打开就没了，而且是个静默的丢失）。
     *
     * 优先级：store 里已有的（`load()` 写的，代表"当前这份数据属于谁"）→ 宿主那一刻的
     * Vault 根（焦点视图这条路上没有别的来源）→ 保持不变。
     */
    const rootPath = get().rootPath ?? useVaultStore.getState().info?.rootPath ?? null
    // 保留视角的刷新（保存成功 / 索引就绪）不进 `loading`：画布继续用旧数据渲染（不闪白）。
    // **换圆心或改跳数则相反** —— 那是一幅新的图，留着旧的只会让人以为按钮没反应；
    // 判据放在这里而不是调用方：只有 store 同时知道"旧的这份数据是谁的、用的几跳"。
    const keepView =
      options.keepView === true && previous !== null && previous.root === relPath && previous.depth === depth
    if (!keepView) {
      // 卡片尺寸是**布局的输入**：非保留视角的加载顺手把它从落盘读回来（用户为此调过宽度，
      // 每次换深度都重调一遍是不能接受的）。保留视角的刷新不动它 —— 内存里的才是最新的。
      set({ egoStatus: 'loading', egoError: null, cardSizes: loadCardSizes(rootPath) })
    }
    try {
      const data = await ipc.graphEgo(relPath, depth)
      if (seq !== egoSeq) return
      // 正文是**卡片正面**的内容：与子图一起换，避免"节点换了一批、卡片还写着上一批的正文"
      const texts = await readTexts(data.nodes.map((node) => node.relPath))
      if (seq !== egoSeq) return
      set({
        ego: { root: relPath, depth, data },
        egoStatus: 'ready',
        egoError: null,
        texts,
        // 记下这个 Vault：卡片尺寸与手工位置都按它落盘（见上面 `rootPath` 的说明）
        ...(rootPath === null ? {} : { rootPath }),
        ...(keepView ? {} : { selected: null }),
      })
    } catch (cause) {
      if (seq !== egoSeq) return
      if (keepView) {
        // 刷新失败：留住旧数据，只记一条提示（与全库视图同一条纪律）
        set({ refreshNotice: `${describeError(MimenoteError.from(cause), '刷新关系图失败')}${STALE_SUFFIX}` })
        return
      }
      set({ egoStatus: 'error', egoError: MimenoteError.from(cause), ego: null })
    }
  },
})

/**
 * 批量读一批笔记的正文（节点卡片正面画的就是它）。
 *
 * 两件事刻意这样做：
 *
 * 1. **分批**：一次 IPC 读 300 篇正文会让第一张卡片出现得很晚，而且任何一篇读失败都可能
 *    把整批拖成错误；按 `TEXT_BATCH_SIZE` 切开，前几批回来就能开始排版。
 * 2. **失败不抛**：读不到正文的节点退化成"只画标题/标签/度数"的紧凑卡片 —— 图谱的结构
 *    仍然完整可读，比整幅画布变成错误层好得多（宿主那边 `notes_read_batch` 本来就会把
 *    跳过的东西放在 `skipped` 里，不是异常）。
 */
async function readTexts(relPaths: readonly string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (let start = 0; start < relPaths.length; start += TEXT_BATCH_SIZE) {
    const batch = relPaths.slice(start, start + TEXT_BATCH_SIZE)
    if (batch.length === 0) continue
    try {
      const result = await ipc.notesReadBatch(batch)
      for (const item of result.items) texts.set(item.relPath, item.text)
    } catch {
      // 整批失败就跳过这一批：剩下的批次照旧读（一篇坏文件不该让其余卡片没有正文）
      continue
    }
  }
  return texts
}

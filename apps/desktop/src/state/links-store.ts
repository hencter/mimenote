/**
 * 链接状态：索引进度 + 当前笔记的出链/反向链接。
 *
 * 数据来自宿主的 `mn-index`（权威实现），前端不做链接解析；
 * 索引进度通过 Tauri 事件推送，避免轮询。
 */

import { create } from 'zustand'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { IndexStatus, NoteLinks } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'

/** 宿主推送索引进度的事件名（与 `src-tauri/src/indexer.rs` 保持一致）。 */
export const INDEX_STATUS_EVENT = 'mn://index-status'

const IDLE_STATUS: IndexStatus = {
  phase: 'idle',
  indexed: 0,
  total: 0,
  durationMs: 0,
  links: 0,
  reusedNotes: 0,
}

interface LinksState {
  status: IndexStatus
  /** 当前打开笔记的链接；`null` 表示没有笔记或尚未加载。 */
  links: NoteLinks | null
  loading: boolean
  error: MimenoteError | null
  /**
   * 按路径缓存的**出链**（当前笔记那一份也在里面）。
   *
   * 为什么需要它：分栏之后同一个界面里可能有几篇笔记同时显示，而每一篇的 `[[链接]]`
   * 必须按**自己那一篇**的出链判断"解析得到 / 悬空"。共用一个 `links` 的后果很具体：
   * 非当前那格里的有效链接会被判成悬空，点一下就会弹出"要新建这篇笔记吗"——
   * 而它其实早就存在。
   */
  outboundByPath: Record<string, NoteLinks['outbound']>

  refresh: (relPath: string | null) => Promise<void>
  /** 确保某一篇的出链在缓存里（缺席就取一次；同一路径的并发请求合并成一次）。 */
  ensureOutbound: (relPath: string) => void
  refreshStatus: () => Promise<void>
  clear: () => void
}

/**
 * 请求序号：快速切换笔记时，只有最后一次请求的结果会被采纳
 * （与笔记读取用同一套"过期响应丢弃"策略）。
 */
let requestSeq = 0

/**
 * 索引进度：事件是主通道，但**事件可能早于订阅**。
 *
 * 真实竞态：宿主在 `vault_open` 返回后立刻开始后台构建，小 Vault 1ms 就建完并发出
 * 完成事件；而前端订阅要走一次动态 import + 注册监听（几十毫秒）。事件丢了就会
 * 永久停在"索引中…"。
 *
 * 因此：订阅成功后立刻查一次状态；只要状态仍是 `building`，就以 500ms 自终止轮询兜底
 * （建完即停，最多 60 秒）。
 */
const STATUS_POLL_MS = 500
const STATUS_POLL_MAX_ATTEMPTS = 120
let statusPollTimer: ReturnType<typeof setTimeout> | null = null
let statusPollAttempts = 0

function stopStatusPolling(): void {
  if (statusPollTimer !== null) {
    clearTimeout(statusPollTimer)
    statusPollTimer = null
  }
  statusPollAttempts = 0
}

function scheduleStatusPoll(): void {
  if (statusPollTimer !== null) return
  if (statusPollAttempts >= STATUS_POLL_MAX_ATTEMPTS) return
  statusPollTimer = setTimeout(() => {
    statusPollTimer = null
    statusPollAttempts += 1
    void useLinksStore.getState().refreshStatus()
  }, STATUS_POLL_MS)
}

export const useLinksStore = create<LinksState>((set, get) => ({
  status: IDLE_STATUS,
  links: null,
  loading: false,
  error: null,
  outboundByPath: {},

  refresh: async (relPath) => {
    if (relPath === null) {
      requestSeq += 1
      set({ links: null, loading: false, error: null })
      return
    }

    const seq = ++requestSeq
    set({ loading: true })
    try {
      const links = await ipc.noteLinks(relPath)
      if (seq !== requestSeq) return
      set((state) => ({
        links,
        loading: false,
        error: null,
        // 当前笔记那一份也进缓存：分栏里别的格子按它自己的路径取（见 `outboundByPath`）
        outboundByPath: { ...state.outboundByPath, [relPath]: links.outbound },
      }))
    } catch (cause) {
      if (seq !== requestSeq) return
      set({ links: null, loading: false, error: MimenoteError.from(cause) })
    }
  },

  ensureOutbound: (relPath) => {
    if (get().outboundByPath[relPath] !== undefined) return
    if (outboundInflight.has(relPath)) return
    outboundInflight.add(relPath)
    void ipc.noteLinks(relPath).then((links) => {
      outboundInflight.delete(relPath)
      set((state) => ({ outboundByPath: { ...state.outboundByPath, [relPath]: links.outbound } }))
    }).catch(() => {
      // 取不到就让它保持"未知"（装饰层按悬空画，但点击不会去新建 —— 见 live-preview 的判据）
      outboundInflight.delete(relPath)
    })
  },

  refreshStatus: async () => {
    try {
      const status = await ipc.indexStatus()
      set({ status })
      if (status.phase === 'building') {
        scheduleStatusPoll()
      } else {
        stopStatusPolling()
      }
    } catch {
      // 索引状态拿不到不影响主流程（浏览器预览模式下就没有这个命令）
    }
  },

  clear: () => {
    requestSeq += 1
    stopStatusPolling()
    outboundInflight.clear()
    set({ links: null, loading: false, error: null, status: IDLE_STATUS, outboundByPath: {} })
  },
}))

/** 正在取的那几篇（把同一路径的并发请求合并成一次）。 */
const outboundInflight = new Set<string>()

/**
 * 某一篇此刻的出链；`null` = **还没取到**（与"取到了、但一条也没有"是两件事）。
 *
 * 区分这两者很重要：装饰层可以把"未知"画成悬空（宁可暂不亮），但**点击**不能凭它去新建
 * 一篇早就存在的笔记 —— 调用方用 `null` 走"先取、这次不处理"那条路。
 *
 * 兜底：`links` 这一份仍然代表**当前文档**（旧口径）。很多既有接线与单测直接
 * `setState({ links })` 而不经过 `refresh`，那时按路径的缓存是空的 —— 请求的正是当前文档时
 * 用它就是对的；请求别的篇则必须等 `ensureOutbound` 取回来（不许拿别人的出链去解析）。
 */
export function outboundFor(relPath: string): NoteLinks['outbound'] | null {
  const state = useLinksStore.getState()
  const cached = state.outboundByPath[relPath]
  if (cached !== undefined) return cached
  const active = useNoteStore.getState().doc?.relPath ?? null
  return relPath === active ? (state.links?.outbound ?? null) : null
}

/** 把宿主推来的索引进度写入 store（供事件订阅与测试调用）。 */
export function applyIndexStatus(status: IndexStatus): void {
  useLinksStore.setState({ status })
}

/**
 * 订阅索引进度事件。
 *
 * 返回取消订阅函数；在浏览器预览模式下（没有 Tauri 事件系统）静默降级 ——
 * 此时索引状态由 `refreshStatus()` 手动刷新。
 */
export function subscribeIndexStatus(): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const stop = await listen<IndexStatus>(INDEX_STATUS_EVENT, (event) => {
        applyIndexStatus(event.payload)
        // 收到终态就停止兜底轮询
        if (event.payload.phase !== 'building') stopStatusPolling()
      })
      if (disposed) {
        stop()
        return
      }
      unlisten = stop

      // 关键：订阅注册**之后**立刻查一次状态 ——
      // 补上"事件在本监听注册之前已经发出"的那些情况（见 scheduleStatusPoll 的说明）。
      await useLinksStore.getState().refreshStatus()
    } catch (cause) {
      // 浏览器预览模式（没有 Tauri 事件系统）会走到这里，属于预期降级
      console.debug('[index] 订阅索引进度事件失败，改用状态查询：', cause)
      // 事件不可用时完全依赖状态查询
      await useLinksStore.getState().refreshStatus()
    }
  })()

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
    stopStatusPolling()
  }
}

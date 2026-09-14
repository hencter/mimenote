/**
 * 标签状态：当前笔记的标签/属性 + 全库标签概览。
 *
 * 数据来自宿主的标签索引（`mn-index`，权威实现在 Rust），前端只做展示与跳转 ——
 * 与 `links-store` 一样用**请求序号**丢弃过期响应：快速切换笔记时只有最后一次结果被采纳，
 * 否则慢请求会把新笔记的标签盖回去。
 *
 * 面板开关放在这里（而不是 `ui-store`）：它是标签面板自己的状态，别的模块不关心；
 * 反过来 `ui-store` 里的东西是所有面板共用的（视图模式、侧栏、主题），混在一起会让
 * "谁打开了我"变得难追踪。
 */

import { create } from 'zustand'

import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { NoteTags, TagSummary } from '@/ipc/types'
import { loadJson, saveJson } from './persist'

/** 面板开关是"工作区布局"的一部分，重启后应当恢复（M3：布局持久化）。 */
const OPEN_KEY = 'mimenote.tags.open.v1'

function loadOpen(): boolean {
  return loadJson<boolean>(OPEN_KEY, false, (value): value is boolean => typeof value === 'boolean')
}

function persistOpen(open: boolean): void {
  saveJson(OPEN_KEY, open)
}

interface TagsState {
  /** 面板是否可见。 */
  open: boolean
  /** 面板当前展示的笔记（`null` = 没有打开的笔记）。 */
  relPath: string | null
  noteTags: NoteTags | null
  /** 全库标签概览。 */
  summary: TagSummary[]
  /** 展开查看的标签键（**归一化后**，来自宿主返回的 `TagNotes.key`）。 */
  activeKey: string | null
  /** 用户点的那条标签的**原始写法**（用于判断"再点一次收起"）。 */
  activeRaw: string | null
  /** 该标签下的笔记（字典序）。 */
  activeNotes: string[]
  loading: boolean
  error: MimenoteError | null

  setOpen: (open: boolean) => void
  toggle: () => void
  /** 拉取某篇笔记的标签与属性（`null` 表示清空）。 */
  refreshFor: (relPath: string | null) => Promise<void>
  /** 只刷新全库标签概览。 */
  refreshSummary: () => Promise<void>
  /** 展开/收起某个标签下的笔记（传 `null` 收起）。 */
  selectTag: (key: string | null) => Promise<void>
  /**
   * 标签改名/合并之后把"展开中的那个标签"换到新键（**只加不改语义**：既有动作的行为不变）。
   *
   * 为什么必须有这一步：面板按 `activeKey` 记住用户展开的是哪个标签，改名之后旧键
   * 在索引里已经不存在，再拿它去查只会得到空列表 —— 用户看到的是"我刚改完，名单空了"。
   * 与 `key` 无关时什么都不做（普通编辑路径不受影响）。
   */
  retargetActiveTag: (fromKey: string, toKey: string) => void
  clear: () => void
}

let requestSeq = 0

export const useTagsStore = create<TagsState>((set, get) => ({
  open: loadOpen(),
  relPath: null,
  noteTags: null,
  summary: [],
  activeKey: null,
  activeRaw: null,
  activeNotes: [],
  loading: false,
  error: null,

  setOpen: (open) => {
    set({ open })
    persistOpen(open)
    if (!open) {
      // 关闭即收起展开的标签：下次打开时从干净状态开始（不保留"上次点开的标签"）
      set({ activeKey: null, activeRaw: null, activeNotes: [] })
    }
  },

  toggle: () => {
    get().setOpen(!get().open)
  },

  refreshFor: async (relPath) => {
    const seq = ++requestSeq

    if (relPath === null) {
      set({ relPath: null, noteTags: null, loading: false, error: null })
      await get().refreshSummary()
      return
    }

    set({ loading: true, relPath })
    try {
      const [noteTags, summary] = await Promise.all([ipc.noteTags(relPath), ipc.tagsList()])
      if (seq !== requestSeq) return
      set({ noteTags, summary, loading: false, error: null })
    } catch (cause) {
      if (seq !== requestSeq) return
      set({ noteTags: null, loading: false, error: MimenoteError.from(cause) })
    }
  },

  refreshSummary: async () => {
    try {
      const summary = await ipc.tagsList()
      set({ summary })
    } catch {
      // 标签概览拿不到不影响主流程（浏览器预览/旧宿主没有这个命令）
    }
  },

  selectTag: async (key) => {
    if (key === null) {
      set({ activeKey: null, activeRaw: null, activeNotes: [] })
      return
    }
    set({ activeKey: key, activeRaw: key })
    try {
      const result = await ipc.tagNotes(key)
      // 展开期间用户可能又点了别的标签
      if (get().activeRaw !== key) return
      // 高亮用**宿主返回的归一化键**：本篇 chip 的原始写法（`Rust`）与概览行的键（`rust`）
      // 因此都能正确高亮 —— 前端不复制 `normalize_tag` 规则（判同只有一份，在 Rust）。
      set({ activeKey: result.key, activeNotes: result.notes })
    } catch {
      if (get().activeRaw !== key) return
      set({ activeNotes: [] })
    }
  },

  retargetActiveTag: (fromKey, toKey) => {
    // 归一化比较由调用方保证（两侧都是宿主返回的键）；这里只处理"正展开着被改名的那个"
    if (get().activeKey !== fromKey && get().activeRaw !== fromKey) return
    set({ activeKey: toKey, activeRaw: toKey, activeNotes: [] })
    void get().selectTag(toKey)
  },

  clear: () => {
    requestSeq += 1
    set({
      relPath: null,
      noteTags: null,
      summary: [],
      activeKey: null,
      activeRaw: null,
      activeNotes: [],
      loading: false,
      error: null,
    })
  },
}))

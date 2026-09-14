// @vitest-environment jsdom
/**
 * 图谱 store 的**自我中心视图**那一半（模式、跳数、子图、正文、适应窗口）。
 *
 * 为什么这些断言落在 store 上而不是组件上：模式与跳数是**跨挂载**的状态
 * （画布切走会卸载组件，切回来时用户刚选的视图与跳数必须还在），而"保留视角的刷新"
 * 与"换圆心/改跳数"的区别只有 store 同时知道新旧数据是谁的。组件那边只测交互。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import {
  DEFAULT_EGO_DEPTH,
  DEFAULT_VIEW,
  FALLBACK_VIEWPORT,
  MAX_EGO_DEPTH,
  MIN_EGO_DEPTH,
  PREFS_KEY,
  clampEgoDepth,
  refreshGraphData,
  useGraphStore,
} from '@/state/graph-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\Mock\\Vault'

const NOTES = [
  { relPath: '中心.md', text: '# 中心\n\n正文一段。\n\n[[甲]] 与 [[乙]]\n' },
  { relPath: '甲.md', text: '# 甲\n\n甲二跳邻居：[[甲二]]\n' },
  { relPath: '甲二.md', text: '# 甲二\n\n再远一层。\n' },
  { relPath: '乙.md', text: '# 乙\n\n正文。\n' },
  { relPath: '丙.md', text: '[[中心]]\n' },
  { relPath: '孤岛.md', text: '谁也不连。\n' },
]

function paths(): string[] {
  const ego = useGraphStore.getState().ego
  return (ego?.data.nodes ?? []).map((node) => node.relPath).sort()
}

function pretendOpenNote(relPath: string, text = ''): void {
  useNoteStore.setState({
    doc: {
      relPath,
      text,
      format: { bom: false, eol: '\n' },
      baseMtimeMs: 0,
      sizeBytes: text.length,
      revision: 1,
      openedAt: 0,
    },
  })
}

function resetGraphStore(depth = DEFAULT_EGO_DEPTH, mode: 'focus' | 'vault' = 'focus'): void {
  useGraphStore.setState({
    status: 'idle',
    data: null,
    error: null,
    rootPath: null,
    selected: null,
    view: DEFAULT_VIEW,
    collapsed: new Set<string>(),
    manual: new Map(),
    staleIndex: false,
    viewport: { ...FALLBACK_VIEWPORT, known: false },
    refreshing: false,
    refreshNotice: null,
    fitKey: null,
    mode,
    depth,
    ego: null,
    egoStatus: 'idle',
    egoError: null,
    texts: new Map<string, string>(),
  })
}

beforeEach(async () => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: NOTES }))
  useNoteStore.setState({ doc: null })
  resetGraphStore()
  await useVaultStore.getState().openVault(VAULT_ROOT)
  useGraphStore.setState({ rootPath: VAULT_ROOT })
})

describe('跳数归一化与偏好持久化', () => {
  it('跳数夹在 1..5，非法值回到默认', () => {
    expect(clampEgoDepth(0)).toBe(MIN_EGO_DEPTH)
    expect(clampEgoDepth(99)).toBe(MAX_EGO_DEPTH)
    expect(clampEgoDepth(2.4)).toBe(2)
    expect(clampEgoDepth(Number.NaN)).toBe(DEFAULT_EGO_DEPTH)
  })

  it('模式与跳数写进 localStorage（切走画布再回来时还在）', () => {
    useGraphStore.getState().setDepth(3)
    useGraphStore.getState().setMode('vault')

    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}')).toEqual({
      mode: 'vault',
      depth: 3,
    })
  })

  it('换视图会清掉"已适应窗口"的记账，并关掉预览（选中属于上一个视图）', () => {
    useGraphStore.setState({ fitKey: 'x', selected: '甲.md' })
    useGraphStore.getState().setMode('vault')

    expect(useGraphStore.getState().fitKey).toBeNull()
    expect(useGraphStore.getState().selected).toBeNull()
  })

  it('改跳数同样清掉适应记账（环半径全变了，停在上一个镜头没有意义）', () => {
    useGraphStore.setState({ fitKey: 'x' })
    useGraphStore.getState().setDepth(4)

    expect(useGraphStore.getState().fitKey).toBeNull()
    expect(useGraphStore.getState().depth).toBe(4)
  })
})

describe('加载自我中心子图', () => {
  it('默认 1 跳：只有直接相关的那一圈（双向）', async () => {
    await useGraphStore.getState().loadEgo('中心.md')

    const state = useGraphStore.getState()
    expect(state.egoStatus).toBe('ready')
    expect(state.ego?.root).toBe('中心.md')
    expect(state.ego?.depth).toBe(1)
    expect(paths()).toEqual(['中心.md', '丙.md', '乙.md', '甲.md'].sort())
    expect(paths()).not.toContain('甲二.md')
  })

  it('顺带把每个节点的正文读回来（卡片正面画的就是它）', async () => {
    await useGraphStore.getState().loadEgo('中心.md')

    const texts = useGraphStore.getState().texts
    expect(texts.get('中心.md')).toContain('正文一段。')
    expect(texts.get('甲.md')).toContain('甲二跳邻居')
    // 不在子图里的笔记不该被读（省掉几十次没人看的文件读）
    expect(texts.has('孤岛.md')).toBe(false)
  })

  it('改跳数后重新加载：`ego.depth` 跟着变，旧的正文被整批换掉', async () => {
    await useGraphStore.getState().loadEgo('中心.md')
    useGraphStore.getState().setDepth(2)
    await useGraphStore.getState().loadEgo('中心.md')

    const state = useGraphStore.getState()
    expect(state.ego?.depth).toBe(2)
    expect(paths()).toContain('甲二.md')
    expect(state.texts.get('甲二.md')).toContain('再远一层。')
  })

  it('圆心不存在（笔记刚被删）：空子图 + `ready`，**不报错**', async () => {
    await useGraphStore.getState().loadEgo('不存在的笔记.md')

    const state = useGraphStore.getState()
    expect(state.egoStatus).toBe('ready')
    expect(state.ego?.data.nodes).toEqual([])
    expect(state.egoError).toBeNull()
  })

  it('没有打开的笔记：清空子图（焦点视图没有圆心可谈）', async () => {
    await useGraphStore.getState().loadEgo('中心.md')
    await useGraphStore.getState().loadEgo(null)

    const state = useGraphStore.getState()
    expect(state.ego).toBeNull()
    expect(state.egoStatus).toBe('idle')
    expect(state.texts.size).toBe(0)
  })

  it('换圆心：选中与旧数据一起换掉（旧路径在新图里没有意义）', async () => {
    await useGraphStore.getState().loadEgo('中心.md')
    useGraphStore.getState().select('乙.md')
    await useGraphStore.getState().loadEgo('甲.md')

    const state = useGraphStore.getState()
    expect(state.ego?.root).toBe('甲.md')
    expect(state.selected).toBeNull()
  })

  it('过期的响应被丢弃：连续两次加载只采纳最后一次', async () => {
    const first = useGraphStore.getState().loadEgo('中心.md')
    const second = useGraphStore.getState().loadEgo('乙.md')
    await Promise.all([first, second])

    expect(useGraphStore.getState().ego?.root).toBe('乙.md')
  })
})

describe('保留视角的刷新（保存成功 / 索引就绪）', () => {
  it('同一个圆心同一个跳数：保留选中与镜头，只换数据', async () => {
    await useGraphStore.getState().loadEgo('中心.md')
    useGraphStore.getState().select('乙.md')
    const view = useGraphStore.getState().view

    await useGraphStore.getState().loadEgo('中心.md', { keepView: true })

    const state = useGraphStore.getState()
    expect(state.selected).toBe('乙.md')
    expect(state.view).toEqual(view)
    expect(state.egoStatus).toBe('ready')
  })

  it('刷新期间不进 `loading`：画布继续画旧数据（不闪白）', async () => {
    await useGraphStore.getState().loadEgo('中心.md')
    const pending = useGraphStore.getState().loadEgo('中心.md', { keepView: true })

    expect(useGraphStore.getState().egoStatus).toBe('ready')
    await pending
  })

  it('`refreshGraphData` 在焦点视图里刷的是**当前打开那篇**的子图', async () => {
    pretendOpenNote('中心.md')
    await refreshGraphData()

    const state = useGraphStore.getState()
    expect(state.egoStatus).toBe('ready')
    expect(state.ego?.root).toBe('中心.md')
    expect(paths()).toContain('甲.md')
    // 全库那份数据**没有**被顺带加载（焦点视图不需要 8000 个节点）
    expect(state.data).toBeNull()
  })

  it('没有打开的笔记时不发请求（也就没有"刷新"可言）', async () => {
    await refreshGraphData()

    const state = useGraphStore.getState()
    expect(state.ego).toBeNull()
    expect(state.egoStatus).toBe('idle')
  })
})

describe('适应窗口（自我中心视图的包围盒由组件交进来）', () => {
  it('`fitToBounds` 按包围盒与视口算缩放与偏移', () => {
    useGraphStore.setState({ viewport: { width: 1000, height: 500, known: true } })
    useGraphStore.getState().fitToBounds({ x: -100, y: -50, width: 400, height: 200 })

    const view = useGraphStore.getState().view
    // 400×200 的图放进 1000×500（留 64 边距）→ 缩放 (1000-128)/400 = 2.18，
    // 但上限是 MAX_ZOOM(2.5) 之内的；这里只断言"内容确实被挪到了视口里"
    expect(view.zoom).toBeGreaterThan(1)
    expect(view.zoom).toBeLessThanOrEqual(2.5)
  })

  it('同一个键只自动适应一次（切走画布再回来不会重置镜头）', () => {
    useGraphStore.setState({ viewport: { width: 800, height: 600, known: true } })
    useGraphStore.getState().autoFitBounds('中心|1', { x: 0, y: 0, width: 200, height: 100 })
    const first = useGraphStore.getState().view

    // 用户自己拖过 / 缩过之后，同一个键不再抢镜头
    useGraphStore.getState().setView({ x: 42, y: 42, zoom: 1 })
    useGraphStore.getState().autoFitBounds('中心|1', { x: 0, y: 0, width: 200, height: 100 })
    expect(useGraphStore.getState().view).not.toEqual(first)

    // 换圆心（新的键）→ 重新适应一次
    useGraphStore.getState().autoFitBounds('甲|1', { x: 0, y: 0, width: 200, height: 100 })
    expect(useGraphStore.getState().fitKey).toBe('甲|1')
  })

  it('空包围盒不覆盖镜头（数据还没到时不该把画布缩成一个点）', () => {
    useGraphStore.getState().setView({ x: 5, y: 5, zoom: 1 })
    useGraphStore.getState().autoFitBounds('空', { x: 0, y: 0, width: 0, height: 0 })

    expect(useGraphStore.getState().view).toEqual({ x: 5, y: 5, zoom: 1 })
  })

  it('`fitToWindow`（`Ctrl+0` 那条路）在焦点视图里用的是**关系图**的包围盒', async () => {
    useGraphStore.setState({ viewport: { width: 1000, height: 600, known: true } })
    // 全库数据也塞进来：焦点视图绝不能去适应它（两者可能差几十倍）
    await useGraphStore.getState().load(VAULT_ROOT)
    useGraphStore.getState().setEgoBounds({ x: -200, y: -200, width: 400, height: 400 })

    useGraphStore.getState().fitToWindow()
    const focusView = useGraphStore.getState().view

    // 400×400 放进 1000×600 里留 64 边距 ⇒ 缩放 (600-128)/400 = 1.18
    expect(focusView.zoom).toBeCloseTo(1.18, 2)

    // 切到全库视图：同一份包围盒不再适用（它属于关系图），适应窗口回到全库
    useGraphStore.getState().setEgoBounds(null)
    useGraphStore.getState().setMode('vault')
    useGraphStore.getState().fitToWindow()
    expect(useGraphStore.getState().view).not.toEqual(focusView)
  })

  it('换视图会清掉焦点视图的包围盒（它属于上一个视图的几何）', () => {
    useGraphStore.getState().setEgoBounds({ x: 0, y: 0, width: 100, height: 100 })
    useGraphStore.getState().setMode('vault')

    expect(useGraphStore.getState().egoBounds).toBeNull()
  })
})

describe('Mock 侧的契约（浏览器预览也走这条路）', () => {
  it('`ipc.graphEgo` 的缺省与宿主一致：1 跳、最多 80 个节点', async () => {
    const data = await ipc.graphEgo('中心.md', 1)
    expect(data.nodes.length).toBeGreaterThan(0)
    expect(data.nodes.length).toBeLessThanOrEqual(80)
    expect(data.truncated).toBe(false)
  })
})

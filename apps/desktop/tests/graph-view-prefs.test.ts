// @vitest-environment jsdom
/**
 * 图谱的**视图偏好与卡片尺寸**（ADR-0023）：张力、连接线是否从 wiki link 引出、力导向预设、
 * 浮动态开关、每张卡片的手工尺寸、以及浮动笔记面板。
 *
 * 为什么这些断言落在 store 上：它们全都是**跨挂载/跨会话**的状态（画布切走会卸载组件），
 * 而且"哪些落盘、哪些不落盘"本身就是设计决定：
 * - 卡片尺寸与偏好**落盘**（换 Vault 要按 Vault 读回来，"我怎么看这一篇"是要留住的东西）；
 * - 浮动面板**不落盘**（下次打开还挂着一堆不知道从哪来的浮窗，比什么都没有更困惑）。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import {
  CARD_SIZE_KEY,
  DEFAULT_FORCE_PRESET,
  DEFAULT_TENSION,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  PREFS_KEY,
  clampCardHeight,
  clampCardWidth,
  clampTension,
  useGraphStore,
} from '@/state/graph-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\Mock\\Vault'
const OTHER_VAULT = 'C:\\Other\\Vault'

const NOTES = [
  { relPath: '中心.md', text: '# 中心\n\n[[甲]]\n' },
  { relPath: '甲.md', text: '# 甲\n\n正文。\n' },
]

function prefs(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>
}

function storedSizes(): Record<string, Record<string, { width: number; height: number | null }>> {
  return JSON.parse(window.localStorage.getItem(CARD_SIZE_KEY) ?? '{}') as Record<
    string,
    Record<string, { width: number; height: number | null }>
  >
}

beforeEach(async () => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: NOTES }))
  useGraphStore.setState({
    mode: 'focus',
    depth: 1,
    ego: null,
    egoStatus: 'idle',
    egoError: null,
    texts: new Map<string, string>(),
    egoBounds: null,
    selected: null,
    view: { x: 0, y: 0, zoom: 1 },
    fitKey: null,
    viewport: { width: 1000, height: 700, known: true },
    rootPath: null,
    cardSizes: new Map(),
    floatingPanes: [],
    tension: DEFAULT_TENSION,
    edgeFromLink: true,
    floating: true,
    forcePreset: DEFAULT_FORCE_PRESET,
  })
  await useVaultStore.getState().openVault(VAULT_ROOT)
  useGraphStore.setState({ rootPath: VAULT_ROOT })
})

describe('归一化', () => {
  it('卡片宽高与张力都夹在范围内', () => {
    expect(clampCardWidth(10)).toBe(MIN_CARD_WIDTH)
    expect(clampCardWidth(99999)).toBe(MAX_CARD_WIDTH)
    expect(clampCardWidth(Number.NaN)).toBe(MAX_CARD_WIDTH)
    expect(clampCardHeight(1)).toBe(MIN_CARD_HEIGHT)
    expect(clampCardHeight(99999)).toBe(MAX_CARD_HEIGHT)
    expect(clampTension(-1)).toBe(0)
    expect(clampTension(9)).toBe(1)
    expect(clampTension(Number.NaN)).toBe(DEFAULT_TENSION)
  })
})

describe('张力与浮动态的偏好', () => {
  it('改张力会落盘（下次打开还是这个手感）', () => {
    useGraphStore.getState().setTension(0.8)

    expect(useGraphStore.getState().tension).toBeCloseTo(0.8, 6)
    expect(prefs()['tension']).toBeCloseTo(0.8, 6)
  })

  it('张力相同时不重复写盘（拖动滑块会连着调很多次）', () => {
    useGraphStore.getState().setTension(0.5)
    const first = window.localStorage.getItem(PREFS_KEY)
    useGraphStore.getState().setTension(0.5)
    expect(window.localStorage.getItem(PREFS_KEY)).toBe(first)
  })

  it('关掉"从 wiki link 引出"也落盘（这条是默认开的）', () => {
    expect(useGraphStore.getState().edgeFromLink).toBe(true)
    useGraphStore.getState().setEdgeFromLink(false)

    expect(useGraphStore.getState().edgeFromLink).toBe(false)
    expect(prefs()['edgeFromLink']).toBe(false)
  })

  it('力导向预设与浮动态开关都落盘', () => {
    useGraphStore.getState().setForcePreset('airy')
    useGraphStore.getState().setFloating(false)

    expect(prefs()['forcePreset']).toBe('airy')
    expect(prefs()['floating']).toBe(false)
  })

  it('换视图 / 改跳数**不会**把别的偏好从落盘里抹掉（真实踩过的回归）', () => {
    /*
      为什么单独一条：`setMode` / `setDepth` 曾经只写 `{mode, depth}` 进 localStorage，
      于是"调好张力与预设 → 随手改一次深度 → 重启"之后，张力与预设悄悄回到默认值
      （内存里还在，所以当场看不出来）。现在它们全部经 `prefsOf` 落盘。
    */
    useGraphStore.getState().setTension(0.75)
    useGraphStore.getState().setForcePreset('floating')
    useGraphStore.getState().setEdgeFromLink(false)

    // 改跳数（会落盘）之后的偏好必须一个不少
    useGraphStore.getState().setDepth(3)
    expect(prefs()).toMatchObject({
      mode: 'focus',
      depth: 3,
      tension: 0.75,
      forcePreset: 'floating',
      edgeFromLink: false,
    })

    // 换视图同理
    useGraphStore.getState().setMode('vault')
    expect(prefs()).toMatchObject({ mode: 'vault', depth: 3, tension: 0.75, forcePreset: 'floating' })
  })
})

describe('卡片尺寸', () => {
  it('调宽度：夹住范围、落盘、并且把高度上限重置成自动', () => {
    useGraphStore.getState().setCardHeight('中心.md', 300)
    useGraphStore.getState().setCardWidth('中心.md', 480)

    const size = useGraphStore.getState().cardSizes.get('中心.md')
    expect(size?.width).toBe(480)
    // 宽度变了换行就变了，旧的高度上限会让"拉宽了反而看着更短"——因此重置成自动
    expect(size?.height).toBeNull()
    expect(storedSizes()[VAULT_ROOT]?.['中心.md']).toEqual({ width: 480, height: null })
  })

  it('调高度上限：是"上限"而不是固定高度', () => {
    useGraphStore.getState().setCardHeight('甲.md', 900)

    expect(useGraphStore.getState().cardSizes.get('甲.md')?.height).toBe(900)
    // 只调高度时宽度留 `null` = 默认宽度（不写死一个具体值：默认宽度属于布局层，不属于偏好）
    expect(useGraphStore.getState().cardSizes.get('甲.md')?.width).toBeNull()
  })

  it('重置一张 / 重置全部都会跟着落盘', () => {
    useGraphStore.getState().setCardWidth('中心.md', 400)
    useGraphStore.getState().setCardWidth('甲.md', 500)
    useGraphStore.getState().resetCardSize('中心.md')

    expect([...useGraphStore.getState().cardSizes.keys()]).toEqual(['甲.md'])
    expect(Object.keys(storedSizes()[VAULT_ROOT] ?? {})).toEqual(['甲.md'])

    useGraphStore.getState().resetCardSize()
    expect(useGraphStore.getState().cardSizes.size).toBe(0)
    expect(storedSizes()[VAULT_ROOT]).toEqual({})
  })

  it('换 Vault 时按 Vault 读回来（尺寸是布局的输入，不能每次重调）', async () => {
    useGraphStore.getState().setCardWidth('中心.md', 460)

    // 换到另一个 Vault：它的尺寸表是空的
    await useVaultStore.getState().openVault(OTHER_VAULT)
    useGraphStore.setState({ rootPath: OTHER_VAULT })
    await useGraphStore.getState().loadEgo('中心.md')
    expect(useGraphStore.getState().cardSizes.size).toBe(0)

    // 换回来：之前调过的宽度还在
    await useVaultStore.getState().openVault(VAULT_ROOT)
    useGraphStore.setState({ rootPath: VAULT_ROOT })
    await useGraphStore.getState().loadEgo('中心.md')
    expect(useGraphStore.getState().cardSizes.get('中心.md')?.width).toBe(460)
  })

  it('落盘里的脏数据不会破坏布局（越界值被夹回来、非法项被丢掉）', async () => {
    window.localStorage.setItem(
      CARD_SIZE_KEY,
      JSON.stringify({
        [VAULT_ROOT]: {
          '中心.md': { width: 99999, height: 1 },
          '甲.md': { width: 'wide', height: null },
          '坏数据.md': null,
        },
      }),
    )
    // 内存里清空，让下一次"非保留视角的加载"真的从落盘读回来（那就是用户换 Vault/改深度时走的路）
    useGraphStore.setState({ cardSizes: new Map(), ego: null })
    await useGraphStore.getState().loadEgo('中心.md')

    const loaded = useGraphStore.getState().cardSizes
    expect(loaded.get('中心.md')).toEqual({ width: MAX_CARD_WIDTH, height: MIN_CARD_HEIGHT })
    expect(loaded.has('甲.md')).toBe(false)
    expect(loaded.has('坏数据.md')).toBe(false)
  })
})

describe('浮动笔记面板', () => {
  it('打开一个：尺寸不超过视口，位置错开', () => {
    useGraphStore.getState().openFloating('中心.md')

    const pane = useGraphStore.getState().floatingPanes[0]
    expect(pane?.relPath).toBe('中心.md')
    expect(pane?.width).toBeLessThanOrEqual(1000)
    expect(pane?.height).toBeLessThanOrEqual(700)
    expect(pane?.x).toBeGreaterThanOrEqual(12)
    // 顶层
    expect(pane?.z).toBe(1)
  })

  it('同一篇再打开一次 = 置顶，不会开出第二个', () => {
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().openFloating('甲.md')
    useGraphStore.getState().openFloating('中心.md')

    const panes = useGraphStore.getState().floatingPanes
    expect(panes).toHaveLength(2)
    expect(panes.find((pane) => pane.relPath === '中心.md')?.z).toBeGreaterThan(
      panes.find((pane) => pane.relPath === '甲.md')?.z ?? 0,
    )
  })

  it('多开几个会错开位置（同一处叠着会让人以为只开了一个）', () => {
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().openFloating('甲.md')

    const [first, second] = useGraphStore.getState().floatingPanes
    expect(first?.x).not.toBe(second?.x)
  })

  it('移动与缩放：夹住最小尺寸', () => {
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().moveFloating('中心.md', { x: 40, y: 50, width: 10, height: 10 })

    const pane = useGraphStore.getState().floatingPanes[0]
    expect(pane?.x).toBe(40)
    expect(pane?.y).toBe(50)
    expect(pane?.width).toBe(MIN_FLOAT_WIDTH)
    expect(pane?.height).toBe(MIN_FLOAT_HEIGHT)
  })

  it('关闭一个 / 全部关闭', () => {
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().openFloating('甲.md')
    useGraphStore.getState().closeFloating('中心.md')
    expect(useGraphStore.getState().floatingPanes.map((pane) => pane.relPath)).toEqual(['甲.md'])

    useGraphStore.getState().closeAllFloating()
    expect(useGraphStore.getState().floatingPanes).toHaveLength(0)
  })

  it('`Esc`（`closePreview`）先关**最上面那个浮窗**，没有浮窗才关停靠预览', () => {
    // `Esc` 在用户心里的意思是"关掉最上面那层"：浮窗是后出现的、盖在停靠面板之上的东西。
    // 反过来（先关停靠面板）会让人觉得"浮窗还在，右下角那个却没了"。
    useGraphStore.getState().select('中心.md')
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().openFloating('甲.md')

    useGraphStore.getState().closePreview()
    // 关掉的是 z 最大的那个（甲.md），不是先开的那个
    expect(useGraphStore.getState().floatingPanes.map((pane) => pane.relPath)).toEqual(['中心.md'])
    expect(useGraphStore.getState().selected).toBe('中心.md')

    useGraphStore.getState().closePreview()
    expect(useGraphStore.getState().floatingPanes).toHaveLength(0)
    // 两个浮窗都关了、再按一次才轮到停靠预览
    expect(useGraphStore.getState().selected).toBe('中心.md')
    useGraphStore.getState().closePreview()
    expect(useGraphStore.getState().selected).toBeNull()
  })

  it('不落盘：浮动面板是临时的阅读姿势，跨会话不保留', () => {    useGraphStore.getState().openFloating('中心.md')

    const dump = JSON.stringify(window.localStorage)
    expect(dump).not.toContain('floatingPanes')
    expect(dump).not.toContain('"z":1')
  })

  it('换 Vault 会清掉浮动面板（旧 Vault 的笔记路径在新 Vault 里未必存在）', () => {
    useGraphStore.getState().openFloating('中心.md')
    useGraphStore.getState().clear()

    expect(useGraphStore.getState().floatingPanes).toHaveLength(0)
  })
})

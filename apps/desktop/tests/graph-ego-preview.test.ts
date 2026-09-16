// @vitest-environment jsdom
/**
 * "关系图的节点正面就是那篇笔记的**完整 Markdown 预览**" —— 这条链路的端到端证明
 * （store 取子图与正文 → 每篇排成卡片 → 摆成同心环 → 画到 canvas 上）。
 *
 * 为什么值得单独钉一条：这是用户这轮提的核心诉求，而它由四层拼起来
 * （`graph-store` 的 `loadEgo` / `canvas/measure` 的 `layoutCard` / `layout-ego` 的环 / `canvas/paint`）。
 * 任何一层把正文丢掉（比如只画标题、或者排版时用了空字符串），单元测试各自都还是绿的，
 * 而画布上会是"一堆只有标题的卡片"。所以这里从**真实的 Mock 子图**出发，一路画到一个记录型
 * 上下文里，然后直接检查"画出来的文字里有没有那篇笔记正文里那句话"。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { cardChrome, layoutCard, type CardLayout } from '@/features/graph/canvas/measure'
import { paletteFrom } from '@/features/graph/canvas/palette'
import { paintGraph, type PaintContext, type PaintNode } from '@/features/graph/canvas/paint'
import {
  DEFAULT_METRICS,
  type FontSpec,
  type MeasureText,
} from '@/features/graph/canvas/text-layout'
import { layoutEgo } from '@/features/graph/layout-ego'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useGraphStore } from '@/state/graph-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\Mock\\Vault'

/** 正文里那句独一无二的话（断言"它真的被画出来了"）。 */
const UNIQUE = '这段话只出现在中心这篇笔记里'

const NOTES = [
  {
    relPath: '中心.md',
    text: `# 中心\n\n${UNIQUE}。另外还提到 [[甲]]。\n\n- 列表项甲\n- 列表项乙\n\n> [!warning] 小心\n> 提示框里的正文。\n\n\`\`\`ts\nconst answer = 42\n\`\`\`\n`,
  },
  { relPath: '甲.md', text: '# 甲\n\n邻居的正文。\n' },
  { relPath: '乙.md', text: '[[中心]]\n' },
  { relPath: '无关.md', text: '谁也不连。\n' },
]

/** 单调的假量宽：汉字按字号的 0.58 倍算（只关心"有没有排下、排了几行"）。 */
const measure: MeasureText = (text: string, font: FontSpec) => text.length * font.size * 0.58

const palette = paletteFrom(() => null)

class RecordingContext implements PaintContext {
  font = ''
  fillStyle: string | CanvasGradient | CanvasPattern = ''
  strokeStyle: string | CanvasGradient | CanvasPattern = ''
  lineWidth = 1
  globalAlpha = 1
  textAlign = 'left'
  textBaseline = 'alphabetic'
  lineJoin = 'miter'
  lineDashOffset = 0
  readonly texts: string[] = []
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  beginPath(): void {}
  closePath(): void {}
  rect(): void {}
  clip(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  fillText(text: string): void {
    this.texts.push(text)
  }
  measureText(): { width: number } {
    return { width: 0 }
  }
  setLineDash(): void {}
}

function pretendOpenNote(relPath: string, text: string): void {
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
    viewport: { width: 1200, height: 800, known: true },
    rootPath: null,
  })
  await useVaultStore.getState().openVault(VAULT_ROOT)
  useGraphStore.setState({ rootPath: VAULT_ROOT })
})

/** 与画布组件里同一段逻辑：每篇正文排成卡片 → 摆同心环 → 转成画笔的节点。 */
function paintFocusView(): {
  context: RecordingContext
  layouts: Map<string, CardLayout>
  paths: string[]
} {
  const state = useGraphStore.getState()
  const ego = state.ego
  if (ego === null) throw new Error('没有加载到自我中心子图')

  const layouts = new Map<string, CardLayout>()
  const sizes = new Map<string, { width: number; height: number }>()
  for (const node of ego.data.nodes) {
    const text = state.texts.get(node.relPath)
    if (text === undefined) continue
    const card = layoutCard({
      relPath: node.relPath,
      title: node.title,
      text,
      width: 320,
      maxHeight: 420,
      measure,
    })
    layouts.set(node.relPath, card)
    sizes.set(node.relPath, { width: card.width, height: card.height })
  }

  const layout = layoutEgo({
    nodes: ego.data.nodes,
    edges: ego.data.edges,
    root: ego.root,
    depth: ego.depth,
    sizes,
    fallbackSize: { width: 320, height: 76 },
  })

  const nodes: PaintNode[] = layout.cards.map((card) => ({
    relPath: card.relPath,
    title: card.node.title,
    rect: card.rect,
    hop: card.hop,
    isRoot: card.relPath === ego.root,
    hasFocus: card.relPath === ego.root,
    layout: layouts.get(card.relPath) ?? null,
  }))

  const context = new RecordingContext()
  paintGraph(context, {
    // 视口开到很大**且把世界原点放在正中**：同心环会往上下左右各铺开一圈，
    // 原点贴左上角时负坐标那几张会被裁剪掉（画笔的裁剪是对的，只是这条用例不该考它）
    transform: { scale: 1, offsetX: 3000, offsetY: 3000, width: 6000, height: 6000 },
    nodes,
    // 连线由调用方算好后交给画笔（ADR-0036）；这条用例只关心卡片正文，因此没有连线
    edgeVisuals: [],
    palette,
    measure,
    mode: 'focus',
    selected: null,
    hovered: null,
  })
  return { context, layouts, paths: layout.cards.map((card) => card.relPath) }
}

describe('关系图的卡片正面是完整预览', () => {
  it('当前笔记的正文（段落 / 列表 / 提示框 / 代码）真的被画到了画布上', async () => {
    pretendOpenNote('中心.md', NOTES[0]?.text ?? '')
    await useGraphStore.getState().loadEgo('中心.md')

    const { context, layouts, paths } = paintFocusView()
    const drawn = context.texts.join('\n')

    // 三张卡片都在环上（圆心 + 甲 + 乙），一张都不少
    expect(paths).toHaveLength(3)
    // 排版结果里有它（说明 markdown 被解析成了块，而不是被丢掉）
    const card = layouts.get('中心.md')
    expect(card).toBeDefined()
    expect(card?.blocks.length).toBeGreaterThan(3)
    // 画出来的文字里也有它（说明整条链路一路走到了 fillText）
    expect(drawn).toContain(UNIQUE)
    expect(drawn).toContain('列表项甲')
    // 提示框：标题栏的文字与正文都在
    expect(drawn).toContain('小心')
    expect(drawn).toContain('提示框里的正文')
    // 代码块
    expect(drawn).toContain('const answer = 42')
  })

  it('frontmatter（YAML 头）不出现在卡片上：它是元数据，不是正文', async () => {
    /*
      真实观感问题：卡片正文直接从原始文件文本排版，于是 `---` / `tags: [项目]` 会在卡片顶上
      画出一条分隔线加几行 `key: value`。阅读视图、浮窗、导出件都在各自的入口处剥掉它，
      图谱这一侧的入口是 `layoutCard` —— 判据仍然只有 `domain/frontmatter.ts` 那一份。
    */
    setIpcAdapter(
      createMockAdapter({
        rootPath: VAULT_ROOT,
        notes: [
          {
            relPath: '中心.md',
            text: `---\ntags: [项目]\nstatus: 进行中\n---\n\n# 中心\n\n${UNIQUE}\n`,
          },
          { relPath: '甲.md', text: '# 甲\n\n[[中心]]\n' },
        ],
      }),
    )
    await useVaultStore.getState().openVault(VAULT_ROOT)
    pretendOpenNote('中心.md', `---\ntags: [项目]\nstatus: 进行中\n---\n\n# 中心\n\n${UNIQUE}\n`)
    await useGraphStore.getState().loadEgo('中心.md')

    const { context, layouts } = paintFocusView()
    const drawn = context.texts.join('\n')

    // 正文照常（"剥掉头"不等于"什么都没画"）
    expect(drawn).toContain(UNIQUE)
    expect(drawn).toContain('中心')
    // YAML 头一行都不在：键名、值与那两条 `---` 都不该被画出来
    expect(drawn).not.toContain('tags')
    expect(drawn).not.toContain('status')
    expect(drawn).not.toContain('进行中')
    expect(drawn).not.toContain('---')
    // 排版结果里也没有它（块清单里不该有 frontmatter 那一块）
    const card = layouts.get('中心.md')
    const blockTexts = (card?.blocks ?? []).flatMap((item) =>
      item.lines.map((line) => line.runs.map((run) => run.text).join('')),
    )
    expect(blockTexts.some((text) => text.includes('tags'))).toBe(false)
  })
  it('子图只包含"直接相关"的那一圈：无关笔记既没有卡片也没有正文', async () => {
    pretendOpenNote('中心.md', NOTES[0]?.text ?? '')
    await useGraphStore.getState().loadEgo('中心.md')

    const state = useGraphStore.getState()
    const egoPaths = (state.ego?.data.nodes ?? []).map((node) => node.relPath).sort()
    // 甲乙 双向都算（乙 指向中心也算一跳），无关那篇不在里面
    expect(egoPaths).toEqual(['中心.md', '乙.md', '甲.md'].sort())
    expect(state.texts.has('无关.md')).toBe(false)

    const { context, paths } = paintFocusView()
    expect(paths.sort()).toEqual(egoPaths)
    expect(context.texts.join('\n')).not.toContain('谁也不连')
  })

  it('深度调大之后新进来的笔记带着自己的正文一起出现', async () => {
    // 甲 → 丙 是第二跳：只有把深度调到 2 才该看到它
    setIpcAdapter(
      createMockAdapter({
        rootPath: VAULT_ROOT,
        notes: [
          ...NOTES,
          { relPath: '丙.md', text: '[[甲]]\n\n第二跳的正文。\n' },
        ],
      }),
    )
    pretendOpenNote('中心.md', NOTES[0]?.text ?? '')
    await useGraphStore.getState().loadEgo('中心.md')
    expect(useGraphStore.getState().texts.has('丙.md')).toBe(false)

    useGraphStore.getState().setDepth(2)
    await useGraphStore.getState().loadEgo('中心.md')

    expect(useGraphStore.getState().ego?.depth).toBe(2)
    expect(useGraphStore.getState().texts.get('丙.md')).toContain('第二跳的正文')
    const { context, paths } = paintFocusView()
    expect(paths).toContain('丙.md')
    expect(context.texts.join('\n')).toContain('第二跳的正文')
  })

  it('卡片高度确实由正文决定（同一篇笔记，正文越长卡片越高）', () => {
    const short = layoutCard({ relPath: 'a', title: 'a', text: '一句话。', width: 320, measure })
    const long = layoutCard({
      relPath: 'a',
      title: 'a',
      text: Array.from({ length: 12 }, (_unused, index) => `第 ${index + 1} 段正文。`).join('\n\n'),
      width: 320,
      measure,
    })

    expect(long.height).toBeGreaterThan(short.height)
    // 上限生效时标出来（画布上会补一行 `…`）。
    // 注意 `maxHeight` 限制的是**正文区**（卡片高度还要加上标题栏与内边距），
    // 所以这里跟"正文区上限 + 卡片壳"比，而不是直接与 420 比 —— 把两种口径混在一起
    // 会让这条用例在改内边距时莫名其妙地红。
    const uncapped = layoutCard({
      relPath: 'a',
      title: 'a',
      text: Array.from({ length: 200 }, (_unused, index) => `第 ${index + 1} 段正文。`).join('\n\n'),
      width: 320,
      measure,
    })
    const capped = layoutCard({
      relPath: 'a',
      title: 'a',
      text: Array.from({ length: 200 }, (_unused, index) => `第 ${index + 1} 段正文。`).join('\n\n'),
      width: 320,
      maxHeight: 420,
      measure,
    })
    const chrome = cardChrome(DEFAULT_METRICS)
    expect(capped.height).toBeLessThanOrEqual(chrome.bodyTop + 420)
    expect(capped.height).toBeLessThan(uncapped.height)
    expect(capped.truncated).toBe(true)
  })
})

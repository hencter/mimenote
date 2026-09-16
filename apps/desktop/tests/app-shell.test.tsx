// @vitest-environment jsdom
/**
 * 应用外壳：结构 + 布局契约测试。
 *
 * 背景（真实 bug）：外壳曾用位置化的 `grid-template-rows: auto auto 1fr auto` 排布，
 * 而冲突横幅在无冲突时返回 `null` —— 少一个子节点就让「主体」落到 auto 行、
 * 「状态栏」占掉 1fr 行，于是窗口下方留空，必须打开一篇笔记把内容撑高才"看起来对齐窗口"。
 *
 * jsdom 没有布局引擎，测不出真实像素，所以这里做两件事：
 * 1. **结构**：外壳各区域都渲染出来，且文件树在没有测量到高度时也必须有可见行；
 * 2. **契约**：外壳布局不得依赖子节点位置（列方向 flex，主体独占剩余高度）。
 *    真正的像素级验证留给 M5 的 Playwright。
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/**
 * 直接从磁盘读样式表。
 *
 * 不用 `import '@/styles/app.css?raw'`：vitest 默认不处理 CSS 导入，
 * 拿到的可能是空字符串，会让契约测试"永远通过"——比没有测试更糟。
 */
function readAppCss(): string {
  const candidates = [
    resolve(process.cwd(), 'src/styles/app.css'),
    resolve(process.cwd(), 'apps/desktop/src/styles/app.css'),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // 换下一个候选路径
    }
  }
  throw new Error(`找不到 app.css（尝试过：${candidates.join('、')}）`)
}

const appCss = readAppCss()

/** 取出某条规则的声明块（仅用于契约断言）。 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`样式表里找不到规则：${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

/**
 * 同上去声明块，但取**最后**一处匹配。
 *
 * 用途：选择器既出现在 `.a,\n.b,\n.c {` 这样的共用列表里、又有一条自己的规则时，
 * `ruleBody` 会命中列表末尾那一行 —— 想读"只属于 `.c` 的那条"就得从后往前找。
 */
function ownRuleBody(css: string, selector: string): string {
  const start = css.lastIndexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`样式表里找不到独立规则：${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  registerBuiltinCommands()
  window.localStorage.clear()
  useNoteStore.getState().close()
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('外壳渲染', () => {
  it('未打开 Vault 时显示门闸页', async () => {
    render(<App />)
    expect(await screen.findByText('打开文件夹作为 Vault')).toBeTruthy()
  })

  it('打开 Vault 后四个区域齐全，且文件树有可见行', async () => {
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')

    await waitFor(() => {
      expect(document.querySelector('.mn-titlebar')).not.toBeNull()
      expect(document.querySelector('.mn-body')).not.toBeNull()
      expect(document.querySelector('.mn-statusbar')).not.toBeNull()
    })

    // 主区域一次只渲染一个 pane（编辑 / 阅读 / 图谱三选一，见 ADR-0009 与 ADR-0010；
    // ADR-0035 之后它渲染在"当前文档所在的格子"里，默认布局下就是主叶）
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-pane').length).toBe(1)
    })
    expect(document.querySelector('.mn-pane--editor')).not.toBeNull()

    // 文件树必须有真实行（jsdom 里 clientHeight 恒为 0，靠兜底高度渲染）
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-tree-row').length).toBeGreaterThan(0)
    })
  })

  it('没有冲突横幅时，主体与状态栏仍然存在（横幅是可选的，不能影响布局）', async () => {
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')

    await waitFor(() => {
      expect(document.querySelector('.mn-conflict')).toBeNull()
      expect(document.querySelector('.mn-body')).not.toBeNull()
      expect(document.querySelector('.mn-statusbar')).not.toBeNull()
    })
  })

  it('标题栏分左/中/右三区：中区是纯拖动区，标签住在各自的格子里（ADR-0035）', async () => {
    /*
      这条用例的主题换过两次：路径进标题栏中区（ADR-0029）→ 中区改成文件标签栏
      （ADR-0034）→ 容器切割树（ADR-0035）让笔记标签住进了**每个格子自己的标签条**，
      中区回归纯拖动区。

      这里钉**结构**：三区都在、标签条在**叶子里**（不在标题栏）、"我在看什么"在状态栏。
      像素级的验证留给 Playwright（`e2e/ui.e2e.test.ts`）。
    */
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')

    await waitFor(() => {
      expect(document.querySelector('.mn-titlebar__left')).not.toBeNull()
      expect(document.querySelector('.mn-titlebar__center')).not.toBeNull()
      expect(document.querySelector('.mn-titlebar__right')).not.toBeNull()
    })

    // 中区是纯拖动区：标签栏**不在**标题栏里（它在叶子的标签条上）
    expect(document.querySelector('.mn-titlebar .mn-tabs')).toBeNull()
    // "我在看什么"在状态栏里，没有文档时整格不渲染
    expect(document.querySelector('.mn-statusbar [data-main-path]')).toBeNull()

    await openNote('项目/设计.md')

    await waitFor(() => {
      const shown = document.querySelector('.mn-statusbar [data-main-path]')
      // **可见文字**不带 `.md`（`displayPath`，ADR-0030），而 `data-main-path` 给真实路径：
      // 自动化认身份要读它，不能读可见文字（"项目/设计" 会误配 "项目/设计文档"）
      expect(shown?.textContent).toBe('项目/设计')
      expect(shown?.getAttribute('data-main-path')).toBe('项目/设计.md')
      expect(shown?.getAttribute('title')).toBe('项目/设计.md')
    })
    // 标签出现在**主叶的标签条**里（不在标题栏中区）
    await waitFor(() => {
      const mainLeaf = document.querySelector('[data-leaf-id="main"]')
      expect(mainLeaf?.querySelector('[data-tab-path="项目/设计.md"]')).not.toBeNull()
    })
    expect(document.querySelector('.mn-editor__path')).toBeNull()
  })

  it('打开第一篇笔记后编辑器真的被创建（回归：曾因 useEffect([]) 空转而空白）', async () => {
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-tree-row').length).toBeGreaterThan(0)
    })

    // 启动时没有文档：此时渲染的是占位符，承载编辑器的 div 还不存在
    expect(document.querySelector('.mn-editor__surface')).toBeNull()

    await openNote('README.md')

    // 笔记打开后，承载节点出现 → 编辑器必须被创建（回调 ref 负责）
    await waitFor(() => {
      expect(document.querySelector('.mn-editor__surface')).not.toBeNull()
      expect(document.querySelector('.cm-editor'), '编辑器实例没有被创建').not.toBeNull()
    })
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent ?? '').toContain('示例 Vault')
    })
  })
})

describe('链接面板（M2）', () => {
  it('打开笔记后可以查看反向链接，点击可跳转到来源笔记', async () => {
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')

    // 打开「设计」：它被「路线图」链接
    await openNote('项目/设计.md')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent ?? '').toContain('设计')
    })

    // 打开链接面板（状态栏按钮）
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="链接面板"]')?.click()
    })
    const panel = await waitFor(() => {
      const element = document.querySelector('.mn-links')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })

    // 反向链接里应出现「路线图」
    await waitFor(() => {
      const names = Array.from(panel.querySelectorAll('.mn-links__item-name')).map(
        (node) => node.textContent,
      )
      // 反链里的名字也不带 .md（ADR-0030）
      expect(names).toContain('路线图')
    })

    // 出链里应出现「细节」（已解析）与悬空项（在细节笔记里）
    const outboundTargets = Array.from(
      panel.querySelectorAll('[data-outbound-target]'),
    ).map((node) => node.getAttribute('data-outbound-target'))
    expect(outboundTargets).toContain('路线图')

    // 点击反向链接 → 打开来源笔记
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-backlink-from="项目/路线图.md"]')?.click()
    })
    await waitFor(() => {
      expect(
        document.querySelector('.mn-statusbar [data-main-path]')?.getAttribute('data-main-path'),
      ).toBe('项目/路线图.md')
    })
  })

  it('点击预览里的 wikilink 会打开目标笔记', async () => {
    // 预览现在只在"阅读"视图里渲染（编辑视图是所见即所得的，见 ADR-0009）
    useUiStore.getState().setViewMode('read')
    render(<App />)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openNote('项目/路线图.md')

    await waitFor(() => {
      expect(document.querySelector('a.mn-wikilink')).not.toBeNull()
    })

    // 等链接被宿主索引标记为"已解析"
    await waitFor(() => {
      const link = document.querySelector('a.mn-wikilink')
      expect(link?.getAttribute('data-rel-path')).toBe('项目/设计.md')
    })

    await act(async () => {
      document.querySelector<HTMLAnchorElement>('a.mn-wikilink')?.click()
    })
    // 点击 wikilink 走的是 `app/actions.openNote`，它必须真的把目标笔记打开。
    // 这里既能读 store、也能读标题栏中区的路径 —— 路径现在**在阅读视图里也在**（ADR-0029），
    // 从前它挂在编辑器工具栏上，这个视图里读不到，只能退回断言 store。
    await waitFor(() => {
      expect(useNoteStore.getState().doc?.relPath).toBe('项目/设计.md')
      expect(
        document.querySelector('.mn-statusbar [data-main-path]')?.getAttribute('data-main-path'),
      ).toBe('项目/设计.md')
    })
    expect(useVaultStore.getState().selected).toBe('项目/设计.md')
  })
})

describe('布局契约（防止再次出现"必须先选中笔记才对得齐窗口"）', () => {
  it('外壳用列方向 flex，不使用位置化的 grid-template-rows', () => {
    const app = ruleBody(appCss, '.mn-app')
    expect(app).toContain('flex-direction: column')
    expect(app).not.toContain('grid-template-rows')
  })

  it('主体独占剩余高度并允许内部滚动', () => {
    const body = ruleBody(appCss, '.mn-body')
    expect(body).toContain('flex: 1 1 auto')
    expect(body).toContain('min-height: 0')
  })

  it('标题栏与状态栏不参与剩余空间分配', () => {
    expect(ruleBody(appCss, '.mn-titlebar')).toContain('flex: 0 0 auto')
    expect(ruleBody(appCss, '.mn-statusbar')).toContain('flex: 0 0 auto')
    expect(ruleBody(appCss, '.mn-conflict')).toContain('flex: 0 0 auto')
  })

  it('标题栏三区列宽是 1fr / 2fr / 1fr（中区的"居中"是网格的性质，不是巧合）', () => {
    /*
      ADR-0029：路径要落在**窗口正中**。左右两条轨道等宽是这条性质的来源 ——
      用 flex + `margin: auto` 也能"看起来居中"，但那是"两边内容刚好一样宽"的巧合：
      库名一长、统计数字多一位，路径就会歪。中区是 2fr 而不是 auto，则是为了让一条
      长路径走省略号而不是把右区的窗口按钮顶出窗口。
    */
    const bar = ruleBody(appCss, '.mn-titlebar')
    expect(bar).toContain('display: grid')
    expect(bar).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)')
    // 纵向不写 align-items：三区撑满整行，窗口按钮的 align-self: stretch 才成立
    expect(bar).not.toContain('align-items')
    // 中区现在是**纯拖动区**（ADR-0035：标签进了各自的格子），保持左对齐即可
    expect(ownRuleBody(appCss, '.mn-titlebar__center')).toContain('justify-content: flex-start')
    expect(ownRuleBody(appCss, '.mn-titlebar__right')).toContain('justify-content: flex-end')
  })

  it('文件树显式允许收缩（contain: strict 让它没有固有高度）', () => {
    const tree = ruleBody(appCss, '.mn-tree')
    expect(tree).toContain('min-height: 0')
    expect(tree).toContain('contain: strict')
  })
})

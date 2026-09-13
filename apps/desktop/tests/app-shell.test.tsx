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

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
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

    // 分栏模式：编辑区 + 预览两个 pane
    await waitFor(() => {
      expect(document.querySelectorAll('.mn-pane').length).toBe(2)
    })

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

  it('文件树显式允许收缩（contain: strict 让它没有固有高度）', () => {
    const tree = ruleBody(appCss, '.mn-tree')
    expect(tree).toContain('min-height: 0')
    expect(tree).toContain('contain: strict')
  })
})

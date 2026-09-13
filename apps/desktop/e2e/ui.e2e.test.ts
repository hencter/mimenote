/**
 * UI 层 E2E：用**系统 Edge**（无需下载浏览器）跑真实 Chromium 布局，
 * 前端跑在构建产物 `dist/` 上、IPC 走内存 Mock 适配器。
 *
 * 这一层的价值：
 * - **真布局**：jsdom 测不出高度，这里能断言"主体吃掉剩余高度、状态栏贴底"，
 *   也就是"必须先选中笔记才对得齐窗口"那类问题的回归门禁；
 * - **快且可移植**：不需要 WebView2、不需要构建 release 二进制，适合放进 CI；
 * - 覆盖编辑器/预览/过滤/主题这些交互链路。
 *
 * 运行：`pnpm --filter @mimenote/desktop build && pnpm test:e2e:ui`
 */

import { join } from 'node:path'

import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { delay, findFreePort, packageRoot } from './support/harness'
import { startStaticServer, type StaticServer } from './support/static-server'

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`等待超时：${what}`)
}

/** 读取关键区域的实际布局。 */
function readLayout(page: Page) {
  return page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) throw new Error(`缺少元素：${selector}`)
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width }
    }
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      titlebar: rectOf('.mn-titlebar'),
      body: rectOf('.mn-body'),
      statusbar: rectOf('.mn-statusbar'),
      sidebar: rectOf('.mn-sidebar'),
      tree: rectOf('.mn-tree'),
      main: rectOf('.mn-main'),
    }
  })
}

describe('UI 层（Edge + dist + Mock Vault）', () => {
  let server: StaticServer
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const port = await findFreePort()
    server = await startStaticServer(join(packageRoot(), 'dist'), port)
    // channel: 'msedge' 直接用系统 Edge，避免下载 Playwright 自带浏览器
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.goto(server.url)
    await page.waitForSelector('.mn-gate', { state: 'visible' })
  }, 120_000)

  afterAll(async () => {
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (server !== undefined) await server.close()
  })

  it('门闸页 → 打开示例 Vault → 文件树出现', async () => {
    await page.getByText('打开文件夹作为 Vault').click()
    await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    expect(await page.locator('.mn-tree-row').count()).toBeGreaterThan(3)
    // 门闸消失、外壳出现
    expect(await page.locator('.mn-gate').count()).toBe(0)
    expect(await page.locator('.mn-app').count()).toBe(1)
  })

  it('未选中任何笔记时布局即铺满窗口（回归：不需要先选笔记）', async () => {
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height

    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.main.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(layout.tree.height).toBeGreaterThan(100)
    // 此时编辑器里没有文档
    expect(await page.locator('.cm-content').count()).toBe(0)
  })

  it('打开笔记后布局不变（编辑/预览是"填充"，不是"撑开"）', async () => {
    const before = await readLayout(page)

    await page.locator('[data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('文件层'),
      10_000,
      '预览渲染出笔记内容',
    )

    const after = await readLayout(page)
    expect(Math.abs(after.body.height - before.body.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.statusbar.bottom - after.innerHeight)).toBeLessThanOrEqual(1)
    // 编辑器与预览并排，且各自有宽度
    expect(after.main.width).toBeGreaterThan(600)
  })

  it('预览把 Markdown 渲染成结构化 HTML（表格 / 代码块 / 标题）', async () => {
    const html = (await page.locator('.mn-preview__body').innerHTML()) ?? ''
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<h1')

    // 切到带围栏代码块的笔记（先展开它的父目录）
    await page.locator('[data-rel-path="项目/子项目"]').click()
    await page.locator('[data-rel-path="项目/子项目/细节.md"]').click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').innerHTML()) ?? '').includes('<pre>'),
      10_000,
      '代码块被渲染为 pre',
    )
    const codeHtml = (await page.locator('.mn-preview__body').innerHTML()) ?? ''
    expect(codeHtml).toContain('export const answer = 42')
  })

  it('过滤框缩小可见行，并保留命中项的祖先目录', async () => {
    const total = await page.locator('.mn-tree-row').count()
    await page.locator('.mn-search-field__input').fill('2025')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) < total,
      5_000,
      '过滤后行数减少',
    )
    const paths = await page.locator('.mn-tree-row').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-rel-path')),
    )
    expect(paths).toContain('日记/2025-01-01.md')
    expect(paths).toContain('日记') // 祖先链被保留
    expect(paths).not.toContain('项目/设计.md')

    await page.locator('.mn-search-field__input').fill('')
  })

  it('切换主题即时生效（CSS 变量驱动，不重建编辑器）', async () => {
    // 先确保有一篇打开的笔记，才能验证"主题切换不会重建编辑器"
    await page.locator('[data-rel-path="随手记.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    const textBefore = (await page.locator('.mn-editor__path').textContent()) ?? ''

    const before = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--mn-bg').trim(),
    )
    await page.selectOption('.mn-statusbar select', 'mimenote-light')
    await waitUntil(
      async () =>
        (await page.evaluate(() => document.documentElement.dataset['theme'])) === 'mimenote-light',
      5_000,
      '主题切换为浅色',
    )
    const after = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--mn-bg').trim(),
    )
    expect(after).not.toBe(before)
    // 编辑器还在，且打开的仍是同一篇笔记（没有被重建/重置）
    expect(await page.locator('.cm-content').count()).toBe(1)
    expect((await page.locator('.mn-editor__path').textContent()) ?? '').toBe(textBefore)
    // 换回深色，避免影响后续用例
    await page.selectOption('.mn-statusbar select', 'mimenote-dark')
  })

  it('缩小窗口后布局立刻跟随（不需要任何点击）', async () => {
    await page.locator('[data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })

    await page.setViewportSize({ width: 1000, height: 620 })
    await waitUntil(
      async () => (await page.evaluate(() => window.innerHeight)) === 620,
      5_000,
      '视口高度变化生效',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    // 缩小后文件树仍然有实际高度（ResizeObserver 重新测量过）
    expect(layout.tree.height).toBeGreaterThan(100)

    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('视图模式切换：仅编辑 / 分栏 / 仅预览', async () => {
    // 状态栏三个视图按钮
    await page.locator('button[aria-label="仅预览"]').click()
    await waitUntil(
      async () => (await page.locator('.cm-content').count()) === 0,
      5_000,
      '进入仅预览模式',
    )
    expect(await page.locator('.mn-preview__body').count()).toBe(1)

    await page.locator('button[aria-label="仅编辑"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    expect(await page.locator('.mn-preview').count()).toBe(0)

    await page.locator('button[aria-label="分栏"]').click()
    await page.waitForSelector('.mn-preview', { state: 'visible' })
    expect(await page.locator('.cm-content').count()).toBe(1)
  })
})

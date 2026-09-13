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

/**
 * 文件树里的某一行。
 *
 * 注意必须限定在 `.mn-tree` 内：预览里的 wikilink 解析成功后也会带 `data-rel-path`，
 * 不加范围会命中两个元素（Playwright 严格模式会直接报错）。
 */
function treeRow(page: Page, relPath: string) {
  return page.locator(`.mn-tree [data-rel-path="${relPath}"]`)
}

/**
 * 确保文件树里某一行可见（必要时先展开父目录）。
 *
 * 为什么需要：用例之间会互相影响树的展开/选中状态（例如键盘导航用例按 Enter
 * 会折叠目录）。每条用例都应该自足，而不是依赖"上一条用例刚好把树留在什么状态"。
 */
async function ensureTreeRow(page: Page, relPath: string): Promise<void> {
  const row = treeRow(page, relPath)
  if ((await row.count()) === 0) {
    const index = relPath.lastIndexOf('/')
    if (index > 0) {
      const parent = relPath.slice(0, index)
      await ensureTreeRow(page, parent)
      await treeRow(page, parent).click()
    }
  }
  await row.waitFor({ state: 'visible', timeout: 10_000 })
}

/** 在文件树里打开某篇笔记，并等到编辑器确实载入它。 */
async function openNoteInTree(page: Page, relPath: string): Promise<void> {
  await ensureTreeRow(page, relPath)
  await treeRow(page, relPath).click()
  await waitUntil(
    async () =>
      ((await page.locator('.mn-editor__path').textContent()) ?? '').includes(relPath),
    10_000,
    `打开 ${relPath}`,
  )
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

    await page.locator('.mn-tree [data-rel-path="项目/设计.md"]').click()
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
    await page.locator('.mn-tree [data-rel-path="项目/子项目"]').click()
    await page.locator('.mn-tree [data-rel-path="项目/子项目/细节.md"]').click()
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
    await page.locator('.mn-tree [data-rel-path="随手记.md"]').click()
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
    await page.locator('.mn-tree [data-rel-path="项目/设计.md"]').click()
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

  it('文件树键盘导航：方向键移动选中项，Enter 打开笔记', async () => {
    await page.locator('.mn-tree [data-rel-path="随手记.md"]').click()
    await page.locator('.mn-tree').focus()

    const selectedPath = () =>
      page.locator('.mn-tree-row--selected').getAttribute('data-rel-path')

    await page.keyboard.press('ArrowDown')
    const afterDown = await selectedPath()
    expect(afterDown).not.toBeNull()

    await page.keyboard.press('ArrowUp')
    const afterUp = await selectedPath()
    expect(afterUp).not.toBeNull()
    expect(afterUp).not.toBe(afterDown)

    // Enter 打开当前选中项（目录则展开/折叠）
    await page.keyboard.press('Enter')
    // 选中项若为文件，编辑器应载入该文件
    const chosen = await selectedPath()
    if (chosen !== null && chosen.endsWith('.md')) {
      await waitUntil(
        async () =>
          ((await page.locator('.mn-editor__path').textContent()) ?? '').includes(chosen),
        8_000,
        `Enter 打开 ${chosen}`,
      )
    }
  })

  it('拖拽分隔条改变侧栏宽度，且布局仍然铺满', async () => {
    const before = await page.locator('.mn-sidebar').evaluate((el) => el.getBoundingClientRect().width)
    const handle = await page.locator('.mn-splitter').first().boundingBox()
    expect(handle).not.toBeNull()
    if (handle === null) return

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()

    await waitUntil(
      async () =>
        (await page.locator('.mn-sidebar').evaluate((el) => el.getBoundingClientRect().width)) >
        before + 60,
      5_000,
      '侧栏被拖宽',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
  })

  it('链接面板：显示反向链接，点击跳转到来源笔记', async () => {
    await openNoteInTree(page, '项目/设计.md')

    await page.locator('button[aria-label="链接面板"]').click()
    await page.waitForSelector('.mn-links', { state: 'visible' })

    // 反向链接里应出现「路线图.md」（它链接了「设计」）
    await waitUntil(
      async () =>
        (await page.locator('.mn-links__item-name').allTextContents()).includes('路线图.md'),
      10_000,
      '反向链接列表出现来源笔记',
    )

    // 出链里应有已解析的「路线图」
    const outbound = await page.locator('[data-outbound-target]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-outbound-target')),
    )
    expect(outbound).toContain('路线图')

    await page.locator('[data-backlink-from="项目/路线图.md"]').click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/路线图.md'),
      10_000,
      '点击反向链接后跳转到来源笔记',
    )

    await page.locator('button[aria-label="关闭链接面板"]').click()
    expect(await page.locator('.mn-links').count()).toBe(0)
  })

  it('预览里的 wikilink 可点击跳转，且布局仍然铺满', async () => {
    // 自足：先打开带 wikilink 的笔记（不依赖上一条用例留下的状态）
    await openNoteInTree(page, '项目/路线图.md')
    await page.waitForSelector('a.mn-wikilink', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('a.mn-wikilink').first().getAttribute('data-rel-path')) !== null,
      10_000,
      'wikilink 被标记为已解析',
    )

    await page.locator('a.mn-wikilink').first().click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/设计.md'),
      10_000,
      '点击 wikilink 后打开目标笔记',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
  })

  it('悬空 wikilink 标记为未解析', async () => {
    await openNoteInTree(page, '项目/子项目/细节.md')
    await page.waitForSelector('a.mn-wikilink--unresolved', { state: 'visible', timeout: 10_000 })
    const text = (await page.locator('a.mn-wikilink--unresolved').textContent()) ?? ''
    expect(text).toContain('还不存在的笔记')
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

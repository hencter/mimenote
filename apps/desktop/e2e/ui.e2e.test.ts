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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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

/** 在文件树里打开某篇笔记（编辑/阅读/图谱三种视图都能用）。 */
async function openNoteInTree(page: Page, relPath: string): Promise<void> {
  await ensureTreeRow(page, relPath)
  await treeRow(page, relPath).click()
  await waitUntil(
    async () => {
      // 编辑视图有编辑器工具栏（显示当前路径）；阅读/图谱视图没有，
      // 就用"树里这一行变成选中态"作为已切换的共同信号。
      if ((await page.locator('.mn-editor__path').count()) > 0) {
        return ((await page.locator('.mn-editor__path').textContent()) ?? '').includes(relPath)
      }
      const rowClass = (await treeRow(page, relPath).getAttribute('class')) ?? ''
      return rowClass.includes('mn-tree-row--selected')
    },
    10_000,
    `打开 ${relPath}`,
  )
}

/** 切到"编辑（所见即所得）"视图。 */
async function showEditView(page: Page): Promise<void> {
  await page.locator('button[aria-label="编辑（所见即所得）"]').click()
  await page.waitForSelector('.cm-content', { state: 'visible' })
}

/**
 * 关掉所有标签（回到"一篇都没打开"的空态）。
 *
 * 为什么需要：标签列表跨用例累积（同一页面 + 同一 Vault 根，还会写进 localStorage），
 * 需要断言"标签数量"的用例必须先垫一个已知的起点。刻意走 `×` 按钮而不是改 store：
 * 那才是用户路径，顺带覆盖了"关掉激活标签会自动接上相邻标签"。
 */
async function closeAllTabs(page: Page): Promise<void> {
  const tabs = page.locator('.mn-tabs__tab')
  for (let guard = 0; guard < 40; guard += 1) {
    const before = await tabs.count()
    if (before === 0) return
    await tabs.first().locator('.mn-tabs__close').click()
    await waitUntil(async () => (await tabs.count()) < before, 5_000, '关闭一个标签')
  }
  throw new Error('标签数量没有收敛到 0')
}

/**
 * 切到"阅读"视图（渲染后的正文）。
 *
 * 默认视图是**所见即所得编辑**（分栏已移除，见 ADR-0009），所以断言 `.mn-preview__body`
 * 之前必须先切到阅读视图；这一步就是点状态栏那个按钮。
 */
async function showReadView(page: Page): Promise<void> {
  await page.locator('button[aria-label="阅读（渲染后）"]').click()
  await page.waitForSelector('.mn-preview__body', { state: 'visible' })
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

  /**
   * 每个用例都从"编辑（所见即所得）"视图开始。
   *
   * 为什么需要：断言 `.mn-preview__body` 的用例会把视图切到"阅读"，而主区域一次只渲染
   * 一个 pane（分栏已移除，ADR-0009）—— 不重置的话，后面的用例会在阅读视图里找编辑器。
   */
  beforeEach(async () => {
    const editButton = page.locator('button[aria-label="编辑（所见即所得）"]')
    if ((await editButton.count()) > 0) await editButton.click()
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

  it('打开笔记后布局不变（编辑/阅读是"填充"，不是"撑开"）', async () => {
    const before = await readLayout(page)

    await page.locator('.mn-tree [data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await waitUntil(
      async () =>
        ((await page.locator('.cm-content').textContent()) ?? '').includes('文件层'),
      10_000,
      '编辑器载入笔记内容',
    )

    const after = await readLayout(page)
    expect(Math.abs(after.body.height - before.body.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.statusbar.bottom - after.innerHeight)).toBeLessThanOrEqual(1)
    // 主区域只有一个 pane（编辑 / 阅读 / 图谱三选一），且占满宽度
    expect(after.main.width).toBeGreaterThan(600)
    expect(await page.locator('.mn-pane').count()).toBe(1)
  })

  it('阅读视图把 Markdown 渲染成结构化 HTML（表格 / 代码块 / 标题）', async () => {
    await showReadView(page)
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

  it('阅读视图里的 wikilink 可点击跳转，且布局仍然铺满', async () => {
    // 自足：先打开带 wikilink 的笔记（不依赖上一条用例留下的状态）
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await page.waitForSelector('a.mn-wikilink', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('a.mn-wikilink').first().getAttribute('data-rel-path')) !== null,
      10_000,
      'wikilink 被标记为已解析',
    )

    await page.locator('a.mn-wikilink').first().click()
    // 跳转后仍停在阅读视图：用预览体里的标题确认换了一篇（编辑器在编辑视图才有）
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计'),
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
    await showReadView(page)
    await page.waitForSelector('a.mn-wikilink--unresolved', { state: 'visible', timeout: 10_000 })
    const text = (await page.locator('a.mn-wikilink--unresolved').textContent()) ?? ''
    expect(text).toContain('还不存在的笔记')
  })

  it('重命名笔记：F2 → 改名 → 指向它的链接跟着改（并验证可逆）', async () => {
    // 自足：先打开目标笔记，让树与编辑器状态确定（重命名对话框在编辑视图里用）
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')

    // F2 打开重命名对话框：文件名预填、扩展名单独显示（不进输入框）
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    expect(await page.getByLabel('新文件名').inputValue()).toBe('设计')

    await page.getByLabel('新文件名').fill('架构设计')
    await page.getByLabel('新文件名').press('Enter')

    // 树里的行真的换了：旧行消失、新行出现
    await ensureTreeRow(page, '项目/架构设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(0)

    // 正在编辑的笔记原地换路径（不重新读取、内容不变）
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/架构设计.md'),
      10_000,
      '编辑器切到新路径',
    )

    // 指向它的链接被改写：切到阅读视图看来源笔记，预览里不再是悬空链接
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('架构设计'),
      10_000,
      '链接被改写为新名字',
    )
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBe(0)

    // 改回去：既验证可逆，也让后续用例看到与初始一致的 Vault
    await openNoteInTree(page, '项目/架构设计.md')
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    await page.getByLabel('新文件名').fill('设计')
    await page.getByLabel('新文件名').press('Enter')

    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '项目/架构设计.md').count()).toBe(0)
    await openNoteInTree(page, '项目/路线图.md')
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计细节见 设计'),
      10_000,
      '链接改回原名',
    )
  })

  it('标签面板：Ctrl+Shift+T 显示标签与属性，点标签列出笔记并可打开', async () => {
    // 设计.md 末尾有一行 `#项目`（行内标签），与「标签示例.md」的 frontmatter 标签同名 ——
    // 正好用来验证"跨笔记的标签索引"与"点标签列出笔记"
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')

    await page.keyboard.press('Control+Shift+t')
    await page.waitForSelector('.mn-tags', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag="项目"]').count()) === 1,
      10_000,
      '本篇的行内标签出现在面板里',
    )

    // 点标签 → 列出含它的两篇笔记（本篇 + 标签示例）
    await page.locator('.mn-tags [data-tag="项目"]').click()
    await waitUntil(
      async () =>
        (await page.locator('.mn-tags [data-tag-note="项目/标签示例.md"]').count()) === 1 &&
        (await page.locator('.mn-tags [data-tag-note="项目/设计.md"]').count()) === 1,
      10_000,
      '列出含该标签的笔记',
    )

    // 点另一篇 → 打开它；面板跟着切到它的标签与属性
    await page.locator('.mn-tags [data-tag-note="项目/标签示例.md"]').click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/标签示例.md'),
      10_000,
      '点笔记后打开它',
    )
    for (const tag of ['项目', '进行中', '架构']) {
      await waitUntil(
        async () => (await page.locator(`.mn-tags [data-tag="${tag}"]`).count()) === 1,
        10_000,
        `切换笔记后面板显示标签 ${tag}`,
      )
    }
    // 属性表里有 frontmatter 字段
    const panelText = (await page.locator('.mn-tags').textContent()) ?? ''
    expect(panelText).toContain('title')
    expect(panelText).toContain('标签示例')

    // 阅读视图只渲染正文：frontmatter 不当正文渲染
    await showReadView(page)
    await waitUntil(
      async () => ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('演示'),
      10_000,
      '预览渲染正文',
    )
    const preview = (await page.locator('.mn-preview__body').textContent()) ?? ''
    expect(preview).not.toContain('title')

    await page.keyboard.press('Control+Shift+t')
    await waitUntil(async () => (await page.locator('.mn-tags').count()) === 0, 5_000, '面板收起')
  })

  it('全文搜索：Ctrl+Shift+F → 输入 → 回车打开命中的笔记', async () => {
    await page.keyboard.press('Control+Shift+f')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('全文搜索')

    // Mock 的搜索是逐行子串匹配（真实实现是 FTS5），"演示"只出现在标签示例那一篇里
    await page.locator('.mn-palette__input').fill('演示')
    await waitUntil(
      async () =>
        (await page.locator('.mn-palette [role="option"][data-rel-path="项目/标签示例.md"]').count()) ===
        1,
      10_000,
      '出现命中的笔记',
    )
    const optionText = (await page.locator('.mn-palette [role="option"][data-rel-path="项目/标签示例.md"]').textContent()) ?? ''
    expect(optionText).toContain('演示')
    // 结果行里带行号与片段
    expect(optionText).toMatch(/\d/)

    await page.locator('.mn-palette__input').press('Enter')
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/标签示例.md'),
      10_000,
      '回车打开命中的笔记',
    )
    expect(await page.locator('.mn-palette').count()).toBe(0)
  })

  it('知识图谱：卡片画布、文件夹成组、点卡片预览、入链虚线/出链实线', async () => {
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    expect(await page.locator('.mn-pane--graph').count()).toBe(1)

    // 卡片 = 笔记（Mock Vault 里每篇 Markdown 一张），文件夹自动成组
    await waitUntil(
      async () => (await page.locator('.mn-graph-card').count()) > 5,
      10_000,
      '画布上出现笔记卡片',
    )
    await page.waitForSelector('.mn-graph-card[data-rel-path="项目/设计.md"]', { state: 'visible' })
    await page.waitForSelector('.mn-graph-folder[data-folder="项目"]', { state: 'visible' })

    // 单击卡片 → 就地预览正文（不需要按 Ctrl、不需要悬停）
    await page.locator('.mn-graph-card[data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.mn-graph-preview', { state: 'visible' })
    await waitUntil(
      async () =>
        ((await page.locator('.mn-graph-preview').textContent()) ?? '').includes('文件层'),
      10_000,
      '预览里出现笔记正文',
    )

    // 入链虚线 / 出链实线：设计.md 既有入链（路线图 → 设计）也有出链（设计 → 路线图/细节）
    // 注意 SVG 元素的 `className` 是 `SVGAnimatedString` 对象，必须读属性
    const highlighted = await page
      .locator('.mn-graph-edge--highlight')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('class') ?? ''))
    expect(highlighted.some((name) => name.includes('mn-graph-edge--dashed'))).toBe(true)
    expect(highlighted.some((name) => !name.includes('mn-graph-edge--dashed'))).toBe(true)

    // Esc 关掉预览
    await page.locator('.mn-graph').press('Escape')
    await waitUntil(async () => (await page.locator('.mn-graph-preview').count()) === 0, 5_000, '预览关闭')

    // 文件夹可以收起（收起后它变成紧凑的文件夹卡片），再点展开
    const folder = page.locator('.mn-graph-folder[data-folder="项目"]')
    const before = await page.locator('.mn-graph-card').count()
    await folder.locator('button').first().click()
    await waitUntil(
      async () => (await page.locator('.mn-graph-card').count()) < before,
      5_000,
      '收起文件夹后内部卡片消失',
    )
    await folder.locator('button').first().click()
    await waitUntil(
      async () => (await page.locator('.mn-graph-card').count()) === before,
      5_000,
      '再点一次展开回来',
    )

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('全局快捷键赢过编辑器自己的绑定：焦点在编辑器里按 Ctrl+G 也是"打开图谱"', async () => {
    // 回归：CodeMirror 的 searchKeymap 把 Mod+G 绑成了"查找下一个"并会 preventDefault。
    // 全局快捷键如果装在冒泡阶段，事件到达它时已经被吃掉 —— 用户按下 Ctrl+G 的结果是
    // 编辑器跳到了下一个匹配，而图谱纹丝不动（应用层 E2E 抓到的真实缺陷）。
    await openNoteInTree(page, '项目/设计.md')
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+g')

    await page.waitForSelector('.mn-graph', { state: 'visible', timeout: 10_000 })
    expect(await page.locator('.mn-pane--graph').count()).toBe(1)

    // 同一件事对 Ctrl+Shift+T（标签面板）、Ctrl+B（侧栏）同样成立：它们都不该被编辑器吞掉
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await page.locator('.cm-content').click()
    const sidebarBefore = await page.locator('.mn-sidebar').count()
    await page.keyboard.press('Control+b')
    await waitUntil(
      async () => (await page.locator('.mn-sidebar').count()) !== sidebarBefore,
      5_000,
      'Ctrl+B 切换侧栏',
    )
    await page.keyboard.press('Control+b')
    await waitUntil(
      async () => (await page.locator('.mn-sidebar').count()) === sidebarBefore,
      5_000,
      '再按一次恢复侧栏',
    )
  })

  it('多标签页：打开多篇成标签、点击切换、关闭当前，且布局契约不变', async () => {
    // 标签列表是**跨用例累积**的（同一个页面、同一个 Vault 根，还写进了 localStorage），
    // 前面的用例已经开过好几篇笔记。所以这里必须先清空，否则"恰好两个标签"永远不会成立。
    await closeAllTabs(page)

    await openNoteInTree(page, '项目/设计.md')
    await openNoteInTree(page, '项目/路线图.md')
    await waitUntil(
      async () => (await page.locator('.mn-tabs__tab').count()) === 2,
      10_000,
      '两篇笔记成为两个标签',
    )
    // 激活项跟着当前文档
    expect(
      await page.locator('.mn-tabs__tab--active').getAttribute('data-tab-path'),
    ).toBe('项目/路线图.md')

    // 点第一个标签切回去（编辑器路径随之变化）
    await page.locator('.mn-tabs__tab[data-tab-path="项目/设计.md"]').click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/设计.md'),
      10_000,
      '点击标签后切到那篇笔记',
    )

    // 标签栏在主区域内部：主体/侧栏/状态栏的高度契约不受影响
    const after = await readLayout(page)
    const expectedBody = after.innerHeight - after.titlebar.height - after.statusbar.height
    expect(Math.abs(after.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(after.statusbar.bottom - after.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.sidebar.height - after.body.height)).toBeLessThanOrEqual(1)
    expect(await page.locator('.mn-main > .mn-tabs').count()).toBe(1)

    // 关闭当前标签 → 剩一个，且不会崩
    await page.locator('.mn-tabs__tab--active .mn-tabs__close').click()
    await waitUntil(async () => (await page.locator('.mn-tabs__tab').count()) === 1, 5_000, '标签被关闭')

    // 收尾：把状态还给后面的用例（只留一个标签、停在编辑视图）
    await openNoteInTree(page, '项目/设计.md')
  })

  it('命令面板：编辑器聚焦时 Ctrl+K 也能打开，过滤后回车执行命令', async () => {
    await openNoteInTree(page, '项目/设计.md')
    // 关键：焦点在编辑器里。CodeMirror 自己把 Ctrl+K 绑成了 deleteToLineEnd，
    // 面板必须在捕捉阶段抢在它前面，否则"打开面板"会变成"删掉半行"。
    await page.locator('.cm-content').click()

    const themeBefore = await page.locator('html').getAttribute('data-theme')
    await page.keyboard.press('Control+k')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('命令面板')
    expect(await page.locator('.mn-palette [role="option"]').count()).toBeGreaterThan(5)

    await page.locator('.mn-palette__input').fill('切换主题')
    await waitUntil(
      async () => (await page.locator('.mn-palette [role="option"]').count()) === 1,
      5_000,
      '过滤到唯一命令',
    )
    await page.locator('.mn-palette__input').press('Enter')

    await waitUntil(
      async () => (await page.locator('html').getAttribute('data-theme')) !== themeBefore,
      5_000,
      '命令被执行（主题真的切换了）',
    )
    expect(await page.locator('.mn-palette').count()).toBe(0)
  })

  it('快速切换：Ctrl+P 只列笔记、回车打开、Esc 关闭且不改动', async () => {
    await page.keyboard.press('Control+p')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('快速切换笔记')

    // 目录不出现在结果里（只列笔记文件）
    await page.locator('.mn-palette__input').fill('项目')
    await waitUntil(
      async () => (await page.locator('.mn-palette [role="option"]').count()) > 0,
      5_000,
      '有匹配结果',
    )
    const paths = await page
      .locator('.mn-palette [role="option"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-rel-path')))
    expect(paths).not.toContain('项目')

    await page.locator('.mn-palette__input').fill('路线图')
    await waitUntil(
      async () =>
        (await page.locator('.mn-palette [role="option"]').first().getAttribute('data-rel-path')) ===
        '项目/路线图.md',
      5_000,
      '第一条命中路线图',
    )
    await page.locator('.mn-palette__input').press('Enter')
    await waitUntil(
      async () =>
        ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/路线图.md'),
      10_000,
      '打开选中的笔记',
    )

    // Esc 只关闭面板，不打开别的笔记
    await page.keyboard.press('Control+p')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.mn-palette').count()) === 0, 5_000, 'Esc 关闭面板')
    expect(((await page.locator('.mn-editor__path').textContent()) ?? '')).toContain('项目/路线图.md')
  })

  it('视图模式切换：编辑 / 阅读 / 图谱（主区域只有一个 pane）', async () => {
    // 状态栏三个视图按钮
    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await waitUntil(
      async () => (await page.locator('.cm-content').count()) === 0,
      5_000,
      '进入阅读视图',
    )
    expect(await page.locator('.mn-preview__body').count()).toBe(1)
    expect(await page.locator('.mn-pane').count()).toBe(1)

    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    expect(await page.locator('.mn-preview').count()).toBe(0)
    expect(await page.locator('.mn-pane').count()).toBe(1)

    // 图谱视图：主区域换成画布（不再有编辑/预览并排 —— 分栏已移除）
    await page.locator('button[aria-label="知识图谱"]').click()
    await page.waitForSelector('.mn-pane--graph', { state: 'visible' })
    expect(await page.locator('.cm-content').count()).toBe(0)
    expect(await page.locator('.mn-preview').count()).toBe(0)

    // 布局不变式仍然成立
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)

    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('大纲面板：Ctrl+Shift+O 列出标题树，点一条跳到那一行（代码块里的伪标题不算）', async () => {
    await openNoteInTree(page, '项目/大纲.md')

    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await page.waitForSelector('.mn-outline', { state: 'visible' })

    // 标题树：层级正确、代码块里的 `# 伪标题` 不在里面
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      10_000,
      '渲染出四个标题',
    )
    const labels = await page.locator('.mn-outline__item').allTextContents()
    expect(labels).toEqual(['大纲示例', '第一节', '小节', '第二节'])

    // 点最后一条 → 光标落到那一行（读编辑器当前行的文本，而不是断言内部变量）
    await page.locator('.mn-outline__item[data-outline-line="15"]').click()
    await waitUntil(
      async () => ((await page.locator('.cm-activeLine').textContent()) ?? '').includes('第二节'),
      5_000,
      '光标落到第二节那一行',
    )

    // 阅读视图里点标题是"滚过去并高亮"（预览没有光标）
    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })
    await page.locator('.mn-outline__item[data-outline-line="5"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-preview__body .mn-outline-flash').count()) === 1,
      5_000,
      '阅读视图里对应标题被高亮',
    )
    expect(await page.locator('.mn-preview__body .mn-outline-flash').textContent()).toBe('第一节')

    // 再按一次收起面板
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await page.keyboard.press('Control+Shift+o')
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 5_000, '面板收起')
  })

  it('拖拽整理：把笔记拖到另一个文件夹，树与指向它的链接一起换（并能拖回来）', async () => {
    // 自足：这条用例**真的会改 Vault**，所以先把起点收拾成"设计.md 就在 项目/ 里"。
    // 收拾手段就是拖拽本身（拖回 项目 是幂等的：已经在 项目 里时是无效落点，什么都不会发生）。
    // 单独跑这一条时（`-t`）门闸还在，先把 Vault 打开 —— 整个文件跑时它已经开着，这里是空操作。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 切到编辑视图（与 `beforeEach` 同一条动作）：这里**不等** `.cm-content`，
    // 单独跑这一条时编辑器里可能一篇笔记都没打开（那种情况下也不该为它先开一篇）
    const editButton = page.locator('button[aria-label="编辑（所见即所得）"]')
    if ((await editButton.count()) > 0) await editButton.click()
    await page.locator('.mn-search-field__input').fill('')
    if ((await treeRow(page, '日记/设计.md').count()) > 0) {
      await treeRow(page, '项目').waitFor({ state: 'visible', timeout: 10_000 })
      await dispatchDrag(page, '日记/设计.md', '项目')
      await waitUntil(
        async () => (await treeRow(page, '项目/设计.md').count()) === 1,
        10_000,
        '设计.md 回到 项目/',
      )
    }
    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)

    // 1) 悬停反馈：拖到文件夹行上时给出明确的"落点在这里"
    await dispatchDrag(page, '项目/设计.md', '日记', 'hover')
    await waitUntil(
      async () => (await treeRow(page, '日记').getAttribute('data-drop-state')) === 'valid',
      10_000,
      '悬停时目标文件夹标成可放置',
    )
    expect((await treeRow(page, '日记').getAttribute('class')) ?? '').toContain(
      'mn-tree-row--drop-valid',
    )

    // 2) 落下：文件真的换了目录（Mock Vault 的"磁盘"就是唯一事实来源）
    await dispatchDrag(page, '项目/设计.md', '日记')
    await ensureTreeRow(page, '日记/设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(0)

    // 3) 全库指向它的链接被改写：路线图里的 `[[设计]]` → 相对新位置的 `[[../日记/设计]]`
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('日记/设计'),
      10_000,
      '预览里的链接已改写成新路径',
    )
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBe(0)

    // 4) 拖拽/移动不能破坏布局契约（标签栏仍在主区域里、主区域高度不变）
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(await page.locator('.mn-main > .mn-tabs').count()).toBe(1)

    // 5) 收尾：拖回 项目/，让 Vault 与用例开始时一致（后面的用例与手工验收都看到干净状态）
    await ensureTreeRow(page, '日记/设计.md')
    await dispatchDrag(page, '日记/设计.md', '项目')
    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '日记/设计.md').count()).toBe(0)
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计细节见 设计'),
      10_000,
      '链接改回原样',
    )
  })

  it('粘贴图片：写进附件目录，编辑器里出现图片、文件树里出现新附件', async () => {
    // 自足：单独跑这一条（`-t`）时门闸还在，先把 Vault 打开
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    await showEditView(page)
    await openNoteInTree(page, '随手记.md')
    // 焦点放进编辑器：粘贴事件的目标就是 contentDOM
    await page.locator('.cm-content').click()

    // 造一个**真实的**剪贴板事件：截图工具/浏览器复制图片给的正是 `DataTransfer.items`
    // 里的一份 file（`files` 在部分实现下是空的，产品代码两条路都覆盖）
    await page.evaluate(() => {
      const content = document.querySelector('.cm-content')
      if (content === null) throw new Error('编辑器未挂载')
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      content.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    })

    // 1) 编辑器里出现图片 widget（`![](相对路径)` 被装饰成图片）。
    //    Mock/浏览器预览模式没有 asset 协议 → 以**占位形态**渲染，`title` 上是被引用的
    //    Vault 相对路径；真实解码（naturalWidth > 0）由应用层 E2E 覆盖（ADR-0007/0013）。
    await page.waitForSelector('.cm-content .mn-md-image-placeholder', {
      state: 'visible',
      timeout: 10_000,
    })
    const widgetRel =
      (await page.locator('.cm-content .mn-md-image-placeholder').first().getAttribute('title')) ?? ''
    // 通用名 `image.png` 被换成带时间戳的名字（连续粘贴不会互相覆盖），并且落在附件目录里
    expect(widgetRel).toMatch(/^附件\/粘贴图片 \d{4}-\d{2}-\d{2} \d{6}\.png$/)

    // 2) 文件树里出现**同一个**附件（条目表是增量更新的，不需要重扫整个 Vault）
    if ((await page.locator('.mn-tree [data-rel-path^="附件/"]').count()) === 0) {
      await treeRow(page, '附件').click()
    }
    await waitUntil(
      async () => (await page.locator(`.mn-tree [data-rel-path="${widgetRel}"]`).count()) === 1,
      10_000,
      '文件树里出现新附件',
    )

    // 3) 收尾：把光标移开图片那一行（让 decoration 恢复成图片），保持编辑视图
    await page.locator('.cm-content').click()
    await showEditView(page)
  })
})

/**
 * 派发一次真实的 HTML5 拖拽（`dragstart` → `dragover` → `drop` → `dragend`）。
 *
 * 为什么不用 `page.dragAndDrop`：Playwright 的鼠标拖动对 HTML5 原生拖放不稳定
 * （浏览器要自己"发起"拖拽才算数），而这条用例要测的恰恰是**事件链路本身**
 * （在 `dragover` 上给反馈、在 `drop` 上落地）。`DataTransfer` 是真实构造的，
 * 与用户按住鼠标拖动时浏览器提供的是同一个接口。
 *
 * `phase: 'hover'` 只走到 `dragover`，用来断言"悬停时就有落点反馈"。
 * `toRel === null` 表示**树的空白区域**（等于 Vault 根目录）。
 */
async function dispatchDrag(
  page: Page,
  fromRel: string,
  toRel: string | null,
  phase: 'hover' | 'drop' = 'drop',
): Promise<void> {
  await page.evaluate(
    ({ fromRel, toRel, phase }) => {
      const source = document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${fromRel}"]`)
      const target =
        toRel === null
          ? document.querySelector<HTMLElement>('.mn-tree')
          : document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${toRel}"]`)
      if (source === null || target === null) {
        throw new Error(`拖拽元素缺失：${fromRel} → ${toRel ?? '（空白区域）'}`)
      }
      const dataTransfer = new DataTransfer()
      const fire = (node: Element, type: string, cancelable: boolean): void => {
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable, dataTransfer }))
      }
      fire(source, 'dragstart', false)
      fire(target, 'dragover', true)
      if (phase === 'drop') {
        fire(target, 'drop', true)
        fire(source, 'dragend', false)
      }
    },
    { fromRel, toRel, phase },
  )
}

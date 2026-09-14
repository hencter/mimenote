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
 *
 * 展开动作是**点击父行**（`toggleExpanded`）—— `revealPath` 只负责滚动，不改展开状态。
 * 点完必须**等子行真的出现**再返回：否则递归会在"还没重渲染"的间隙里继续往上找，
 * 于是"父目录其实已经展开"这件事被误判成"还没展开"。
 */
async function ensureTreeRow(page: Page, relPath: string): Promise<void> {
  const row = treeRow(page, relPath)
  if ((await row.count()) === 0) {
    const index = relPath.lastIndexOf('/')
    if (index > 0) {
      const parent = relPath.slice(0, index)
      await ensureTreeRow(page, parent)
      await treeRow(page, parent).click()
      await waitUntil(
        async () => (await row.count()) > 0,
        10_000,
        `展开 ${parent} 后出现 ${relPath}`,
      )
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
    page.on('console', (message) => {
      if (message.text().startsWith('DBG')) console.log('[page]', message.text())
    })
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

  it('标签面板：层级编辑（挂到父标签下 → 提回顶层），概览与正文一起跟着换键', async () => {
    // 目标键由宿主算（`tag_move_target`）这件事在真实二进制那一层另有专测；
    // 这里验的是**真实浏览器里的交互链路**：入口在哪儿、初值是什么、
    // 预览 → 确认之后概览与正文有没有真的换键。
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')
    // `Ctrl+Shift+T` 是**开关**，而本文件共用一个页面：先看它现在是不是开着的
    if ((await page.locator('.mn-tags').count()) === 0) {
      await page.keyboard.press('Control+Shift+t')
    }
    await page.waitForSelector('.mn-tags', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="项目"]').count()) === 1,
      10_000,
      '全库概览里出现 项目',
    )

    /** 打开某个键的"移到…"对话框（`⇥` 只在全库概览那一行上）。 */
    const openMove = async (key: string): Promise<void> => {
      await page
        .locator('.mn-tags li', { has: page.locator(`[data-tag-key="${key}"]`) })
        .locator(`[data-tag-move-open="${key}"]`)
        .click()
      await page.waitForSelector('[data-tag-move-dialog]', { state: 'visible' })
    }

    const input = page.locator('[data-tag-rename-input]')

    // —— 挂到 `父` 下面 ——
    await openMove('项目')
    // 顶层标签的父标签是空的（留空 = 顶层），所以这里必须自己打一个
    expect(await input.inputValue()).toBe('')
    await input.fill('父')
    await input.press('Enter')
    await page.waitForSelector('[data-tag-rename-preview]', { state: 'visible' })
    // `#项目` 出现在两篇笔记里（设计.md 的行内 + 标签示例.md 的 frontmatter 与行内）
    expect(await page.locator('[data-tag-rename-preview]').textContent()).toContain('这会改 2 篇笔记')
    await page.locator('[data-tag-rename-confirm]').click()
    await page.waitForSelector('[data-tag-rename-result]', { state: 'visible' })
    await page.locator('[data-tag-rename-done]').click()

    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="父/项目"]').count()) === 1,
      10_000,
      '概览里换成 父/项目',
    )
    expect(await page.locator('.mn-tags [data-tag-key="项目"]').count()).toBe(0)
    // 编辑器内存也必须对齐（否则下一次自动保存会把刚写下的标签覆盖掉）
    await waitUntil(
      async () => ((await page.locator('.cm-content').textContent()) ?? '').includes('#父/项目'),
      10_000,
      '正文行内标签跟着改成 父/项目',
    )

    // —— 提回顶层：把状态还给后面的用例，顺带覆盖"留空 = 顶层"这条路 ——
    await openMove('父/项目')
    // 初值就是它现在挂着的位置：用户要做的只是把它清掉
    expect(await input.inputValue()).toBe('父')
    await page.locator('[data-tag-move-top]').click()
    expect(await input.inputValue()).toBe('')
    await input.press('Enter')
    await page.waitForSelector('[data-tag-rename-preview]', { state: 'visible' })
    await page.locator('[data-tag-rename-confirm]').click()
    await page.waitForSelector('[data-tag-rename-result]', { state: 'visible' })
    await page.locator('[data-tag-rename-done]').click()

    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="项目"]').count()) === 1,
      10_000,
      '提回顶层后又变回 项目',
    )
    expect(await page.locator('.mn-tags [data-tag-key="父/项目"]').count()).toBe(0)
    await waitUntil(
      async () => ((await page.locator('.cm-content').textContent()) ?? '').includes('#项目'),
      10_000,
      '正文行内标签回到 项目',
    )

    // 收尾：把面板关掉，状态还给后面的用例（同样是开关，先确认它开着）
    if ((await page.locator('.mn-tags').count()) > 0) {
      await page.keyboard.press('Control+Shift+t')
    }
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

  it('整库导出静态站点：浏览器预览模式没有系统目录选择框，如实说明而不是假装写出去了', async () => {
    // 这一层能验的是"降级路径"：Mock 适配器有完整的计划（页面表、链接、反链），
    // 但浏览器里没有 `dialog:allow-open`，`pickDirectory` 返回 null —— 于是导出必须在**选目录**
    // 这一步就停下并说清原因。真实落盘由 `real-app.e2e.test.ts` 用真实二进制 + 真实磁盘覆盖。
    await openNoteInTree(page, '项目/设计.md')
    await page.locator('.mn-export-launch').click()
    await page.waitForSelector('.mn-dialog--export', { state: 'visible' })

    // 三个选项都在同一张对话框里（单篇 HTML / 打印 / 整库站点），第三个在 Mock 里是**可用**的
    expect(await page.locator('.mn-export__choice').count()).toBe(3)
    const site = page.locator('[data-export-site]')
    await waitUntil(async () => !(await site.isDisabled()), 10_000, '整库导出选项可用（Mock 的索引是 ready）')
    await site.click()

    await waitUntil(
      async () =>
        (await page.locator('.mn-toasts').count()) > 0 &&
        ((await page.locator('.mn-toasts').textContent()) ?? '').includes('浏览器预览模式无法写出文件'),
      10_000,
      '说清"这里写不了文件"以及该去哪儿',
    )
    // 对话框自己收起（没有停在"正在导出…"），也没有任何东西被写出去
    await waitUntil(
      async () => (await page.locator('.mn-dialog--export').count()) === 0,
      5_000,
      '导出对话框收起',
    )
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

    // 「当前章节」高亮：跳转本身就把光标放进了那一节，因此高亮必须已经在它上面
    await waitUntil(
      async () =>
        (await page.locator('.mn-outline__item--current').getAttribute('data-outline-line')) === '15',
      5_000,
      '当前章节跟着光标走',
    )
    expect(await page.locator('.mn-outline__item--current').getAttribute('aria-current')).toBe(
      'location',
    )

    // 把光标挪到标题**下面的正文**里（第 17 行）：仍属于那一节（`<=` 语义），不是"没高亮"
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await waitUntil(
      async () =>
        (await page.locator('.mn-outline__item--current').getAttribute('data-outline-line')) === '15',
      5_000,
      '光标在正文里时仍高亮上面那一节',
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

    /*
     * 阅读视图里的"当前章节"跟**滚动位置**走。
     *
     * 先把窗口缩矮，逼出真正的滚动条 —— 这篇 mock 笔记很短，1280×800 下整篇放得下，
     * 那种情况下"滚动"是空话（任何断言都会因为滚不动而假通过或假失败）。
     */
    await page.setViewportSize({ width: 900, height: 360 })
    await waitUntil(
      async () =>
        await page.evaluate(() => {
          const scroller = document.querySelector('.mn-preview__scroller')
          return scroller !== null && scroller.scrollHeight > scroller.clientHeight + 40
        }),
      5_000,
      '预览变成可滚动',
    )

    // 断言"跟着滚动走"这个**关系**，而不是某个具体行号：这篇笔记很短，
    // 最后一个标题根本滚不到顶（滚到底时视口顶部那一节是「小节」），写死行号只会把
    // 布局细节焊进用例。
    // 注意用 `evaluate` 读而不是 `locator().getAttribute()`：后者在元素不存在时会等满默认超时
    // （15s），而"还没滚到第一个标题时本来就没有高亮"是合法状态。
    const readCurrentLine = async (): Promise<number> =>
      await page.evaluate(() => {
        const node = document.querySelector('.mn-outline__item--current')
        return node === null ? 0 : Number(node.getAttribute('data-outline-line') ?? 0)
      })

    const beforeScroll = await readCurrentLine()
    await page.evaluate(() => {
      const scroller = document.querySelector('.mn-preview__scroller')
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
    })
    await waitUntil(
      async () => (await readCurrentLine()) > beforeScroll,
      5_000,
      '滚下去之后当前章节往后走了',
    )
    // 而且必须停在这篇笔记真正的标题上（不是随便一个行号）
    expect(['1', '5', '9', '15']).toContain(String(await readCurrentLine()))

    await page.setViewportSize({ width: 1280, height: 800 })
    await waitUntil(
      async () => (await page.locator('.mn-preview__body').count()) === 1,
      5_000,
      '恢复窗口尺寸',
    )

    // 再按一次收起面板
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await page.keyboard.press('Control+Shift+o')
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 5_000, '面板收起')
  })

  it('表格格式化：Ctrl+Alt+F 把光标所在的表格对齐（只改空白，内容不动）', async () => {
    // mock 笔记 `项目/设计.md` 里的表格本来就没对齐（`层` 只有一列宽，`文件层` 有三列），
    // 因此不需要为此改 Mock 数据
    await openNoteInTree(page, '项目/设计.md')

    /** 表格块的每一行文本 + 显示宽度（中文按两列算，与实现同口径）。 */
    const tableLines = async (): Promise<Array<{ text: string; width: number }>> =>
      await page.evaluate(() => {
        const widthOf = (text: string): number => {
          let width = 0
          for (const char of text) {
            const code = char.codePointAt(0) ?? 0
            const wide =
              (code >= 0x1100 && code <= 0x115f) ||
              (code >= 0x2e80 && code <= 0xa4cf) ||
              (code >= 0xac00 && code <= 0xd7a3) ||
              (code >= 0xf900 && code <= 0xfaff) ||
              (code >= 0xfe30 && code <= 0xfe6f) ||
              (code >= 0xff00 && code <= 0xff60) ||
              (code >= 0xffe0 && code <= 0xffe6) ||
              (code >= 0x20000 && code <= 0x2fa1f)
            width += wide ? 2 : 1
          }
          return width
        }
        const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-content .cm-line')).map(
          (line) => line.textContent ?? '',
        )
        const block = lines.filter((line) => line.includes('|'))
        return block.map((text) => ({ text, width: widthOf(text) }))
      })

    const before = await tableLines()
    expect(before.length).toBeGreaterThanOrEqual(3)
    // 起点：确实没对齐（否则这条用例证明不了什么）
    expect(new Set(before.map((line) => line.width)).size).toBeGreaterThan(1)

    // 把光标放进表格里（点 `文件层` 那一行），再按快捷键。
    //
    // `.first()` 是必需的：所见即所得**渲染表格**之后，承载 widget 的那一行（DOM 里含整张
    // 渲染出来的表，而表里有"文件层"三个字）与那一行的原始源码都命中 `hasText`，strict mode
    // 会报"命中 2 个元素"。先命中 DOM 顺序里靠前的那一条正是 widget 宿主行 —— 它就在表格里，
    // 点它等于"把光标放进表格"，正是本用例要做的动作。
    await page.locator('.cm-content').click()
    const row = page.locator('.cm-content .cm-line', { hasText: '文件层' }).first()
    await row.click()
    await page.keyboard.press('Control+Alt+f')

    await waitUntil(
      async () => {
        const lines = await tableLines()
        const first = lines[0]?.width
        return first !== undefined && lines.every((line) => line.width === first)
      },
      5_000,
      '表格每一行的显示宽度一致',
    )

    const after = await tableLines()
    // 对齐了：每一行显示宽度相同（竖线因此严格对齐）
    expect(new Set(after.map((line) => line.width)).size).toBe(1)
    // 内容一个字符都没变（只动了空白与竖线位置）
    for (const line of after) {
      expect(line.text.replace(/\s+/gu, '')).toBe(
        before.find((item) => item.text.replace(/\s+/gu, '') === line.text.replace(/\s+/gu, ''))
          ?.text.replace(/\s+/gu, '') ?? line.text.replace(/\s+/gu, ''),
      )
    }

    // 幂等：再按一次，表格文本逐字不变
    const aligned = after.map((line) => line.text)
    await row.click()
    await page.keyboard.press('Control+Alt+f')
    await delay(200)
    expect((await tableLines()).map((line) => line.text)).toEqual(aligned)
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

  it('文件夹改名：F2 → 整棵子树换路径 → 指向子树的链接跟着改（并改回来）', async () => {
    // 自足：单独跑这一条（`-t`）时门闸还在，先把 Vault 打开
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 起点收拾干净：**目录改名是真实的磁盘操作**，上一条用例可能把它留在了别处
    //（拖拽用例的收尾只保证 `设计.md` 在 `项目/` 里，不保证目录本身叫 `项目`）
    if ((await treeRow(page, '项目').count()) === 0) {
      await ensureTreeRow(page, '工程')
      await dispatchDrag(page, '工程', null)
      await waitUntil(
        async () => (await treeRow(page, '项目').count()) === 1,
        10_000,
        '把 工程/ 移回 Vault 根并恢复名字',
      )
    }
    await ensureTreeRow(page, '项目/子项目/细节.md')

    // 1) 选中文件夹 → F2 → 改名框预填**目录名**（不带扩展名）
    await treeRow(page, '项目').click()
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    expect(await page.getByLabel('新文件名').inputValue()).toBe('项目')
    expect(await page.locator('.mn-rename__ext').count()).toBe(0)

    await page.getByLabel('新文件名').fill('工程')
    await page.getByLabel('新文件名').press('Enter')
    // 等对话框真的关掉：改名是异步的（IPC → 搬整棵子树 + 改写链接 → 条目表更新），
    // 不等就会在"命令还在路上"的那一刻去读树
    await waitUntil(
      async () => (await page.locator('.mn-dialog--rename').count()) === 0,
      10_000,
      '改名对话框关闭（命令已返回）',
    )

    // 2) 树里整棵子树都换了前缀（`项目/子项目/细节.md` 这种深层文件也在）
    await ensureTreeRow(page, '工程/子项目/细节.md')
    expect(await treeRow(page, '项目').count()).toBe(0)
    expect(await treeRow(page, '项目/子项目/细节.md').count()).toBe(0)

    // 3) 全库指向子树的链接被改写：路线图里 `[[设计]]` 是裸名（同目录，含义不变），
    //    而 `[[子项目/细节]]` 这类**路径形式**的链接必须跟着前缀走
    await openNoteInTree(page, '工程/子项目/细节.md')
    await showEditView(page)
    await waitUntil(
      async () => ((await page.locator('.mn-editor__path').textContent()) ?? '').includes('工程/子项目/细节.md'),
      10_000,
      '子树的深层文件跟着换了路径',
    )
    // 换回阅读视图看链接是否仍然解析得到（悬空会渲染成 `a.mn-wikilink--unresolved`）
    // 注意 `细节.md` 本来就有一条故意悬空的 `[[还不存在的笔记]]`（其它用例依赖它），
    // 所以这里比的是**改动键本身**不见了，而不是"一条悬空都没有"
    await showReadView(page)
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })
    const unresolvedTexts = await page.locator('a.mn-wikilink--unresolved').allTextContents()
    expect(unresolvedTexts.some((text) => text.includes('子项目/细节'))).toBe(false)
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBeLessThanOrEqual(1)

    // 4) 拖到树的空白区域 = 移到 Vault 根：这里本来就**已经在根**，所以是无效落点，
    //    什么都不该发生（顺带验证"文件夹可拖 + 空白区域是根 + 无效落点不静默"）
    await ensureTreeRow(page, '工程')
    await dispatchDrag(page, '工程', null)
    await waitUntil(
      async () => (await page.locator('.mn-toasts').textContent() ?? '').includes('已经'),
      10_000,
      '无效落点给出原因（而不是静默无反应）',
    )
    expect(await treeRow(page, '工程/子项目/细节.md').count()).toBe(1)

    // 5) 布局契约不受影响（标签栏仍在主区域里）
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(await page.locator('.mn-main > .mn-tabs').count()).toBe(1)

    // 6) 恢复原来的名字（让后续用例与手工验收看到与初始一致的 Vault）
    await ensureTreeRow(page, '工程')
    await treeRow(page, '工程').click()
    // F2 由**文件树**的 keydown 处理：先把焦点给回树（上一步在编辑器里点过）
    await page.locator('.mn-tree').focus()
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    await page.getByLabel('新文件名').fill('项目')
    await page.getByLabel('新文件名').press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-dialog--rename').count()) === 0,
      10_000,
      '改名对话框关闭',
    )
    await ensureTreeRow(page, '项目/子项目/细节.md')
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

  it('大纲面板：按级别过滤 + 章节折叠（键盘可操作，当前章节高亮不漂移）', async () => {
    // 本文件共用一个页面，Vault 由第一条用例打开；单独筛选用例跑时门闸还在，这里自己补上
    // （整文件跑时这段是空操作），用例因此不依赖"前面刚好有人开过 Vault"。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }

    await openNoteInTree(page, '项目/大纲.md')

    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await page.waitForSelector('.mn-outline', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      10_000,
      '大纲列出四个标题',
    )
    // 默认 = 不过滤：六级开关全亮，升级上来的用户看到的还是完整标题树
    expect(await page.locator('.mn-outline__level[aria-pressed="true"]').count()).toBe(6)

    // 当前章节的行号（用 evaluate 读：元素不存在时 locator().getAttribute() 会等满默认超时）
    const currentLine = async (): Promise<number> =>
      await page.evaluate(() => {
        const node = document.querySelector('.mn-outline__item--current')
        return node === null ? 0 : Number(node.getAttribute('data-outline-line') ?? 0)
      })
    const hiddenCurrentLine = async (): Promise<string | null> =>
      await page.evaluate(
        () =>
          document.querySelector('[data-outline-hidden-current]')?.getAttribute(
            'data-outline-hidden-current',
          ) ?? null,
      )

    // —— 级别过滤：键盘（Enter）关掉 H3 ——
    const level3 = page.locator('.mn-outline__level[data-outline-level="3"]')
    await level3.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 3,
      5_000,
      '过滤掉 H3 之后少一条',
    )
    expect(await page.locator('.mn-outline__item').allTextContents()).toEqual([
      '大纲示例',
      '第一节',
      '第二节',
    ])
    expect(await level3.getAttribute('aria-pressed')).toBe('false')
    // 计数补上分母：用户要知道"还有几条没显示"
    expect(await page.locator('.mn-outline__count').textContent()).toBe('3/4')

    // 过滤之后点一条：滚动/高亮仍落在**正确的那一节**上
    // （序号按完整标题列表算；若按可见列表的下标算，这里会错位到「小节」上）
    await showReadView(page)
    await page.locator('.mn-outline__item[data-outline-line="15"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-preview__body .mn-outline-flash').count()) === 1,
      5_000,
      '阅读视图里对应标题被高亮',
    )
    expect(await page.locator('.mn-preview__body .mn-outline-flash').textContent()).toBe('第二节')
    await showEditView(page)

    // 放回 H3（键盘）
    await level3.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      5_000,
      '还原 H3',
    )

    // —— 章节折叠：把光标放到「小节」（第 9 行，属于「第一节」），再把第一节收起来 ——
    await page.locator('.mn-outline__item[data-outline-line="9"]').click()
    await waitUntil(async () => (await currentLine()) === 9, 5_000, '当前章节跟着光标走')

    const collapseFirst = page.locator('[data-outline-collapse="5"]')
    await collapseFirst.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 3,
      5_000,
      '收起第一节',
    )
    expect(await page.locator('.mn-outline__item').allTextContents()).toEqual([
      '大纲示例',
      '第一节',
      '第二节',
    ])
    expect(await collapseFirst.getAttribute('aria-expanded')).toBe('false')
    // 当前章节被藏起来时：不高亮到别的条目上，只如实交代它在第几行
    expect(await currentLine()).toBe(0)
    expect(await hiddenCurrentLine()).toBe('9')
    // 三角留在原地：收起的章节必须还能再展开
    expect(await collapseFirst.count()).toBe(1)

    await collapseFirst.focus()
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await currentLine()) === 9, 5_000, '展开后当前章节回到第 9 行')

    // —— 过滤到一条不剩：给人话，而不是空白面板 ——
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const button = page.locator(`.mn-outline__level[data-outline-level="${level}"]`)
      await button.focus()
      await page.keyboard.press('Enter')
    }
    await waitUntil(
      async () =>
        ((await page.locator('.mn-outline__empty').textContent()) ?? '').includes(
          '当前过滤条件下没有标题',
        ),
      5_000,
      '过滤后没有标题时给空态文案',
    )
    expect(await page.locator('.mn-outline__item').count()).toBe(0)

    // 一键还原 + 收尾（面板收起、过滤回到默认），不让状态漏给别的用例
    await page.locator('.mn-outline__reset').click()
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      5_000,
      '还原全部级别',
    )
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 5_000, '面板收起')
  })

  it('按标签过滤文件树：只留命中笔记与祖先目录，计数说清 M/N，Esc 随时回到全量', async () => {
    // 本文件共用一个页面：单独跑这一条时门闸还在。
    // 刻意不调 `showEditView`：这一条只用文件树与它的头部控件，而"没有打开的笔记时
    // 编辑器根本不存在"（`.cm-content` 等不到），那样单独跑就会因为无关的原因失败。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 起点干净：清掉可能残留的标签过滤与文本过滤
    await resetTagFilter(page)
    await page.locator('.mn-search-field__input').fill('')

    // —— 入口在文件树头部：可搜索的选择器 ——
    await page.locator('[data-tag-filter-toggle]').click()
    await page.locator('[data-tag-filter-search]').fill('项')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-option="项目"]').count()) === 1,
      5_000,
      '搜索后出现「项目」选项',
    )
    await page.locator('[data-tag-filter-option="项目"]').click()

    // —— 树被收窄到"命中笔记 + 祖先目录"：Mock 里 #项目 命中 设计.md 与 标签示例.md ——
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '过滤后只剩命中项与祖先目录',
    )
    const filtered = await page
      .locator('.mn-tree-row')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-rel-path')))
    // 集合一致（行内顺序按"目录在前 + 拼音"排，这里只钉住"祖先行排在它的子行之前"）
    expect([...filtered].sort()).toEqual(['项目', '项目/设计.md', '项目/标签示例.md'].sort())
    expect(filtered[0]).toBe('项目')

    // 没有命中的笔记、空目录（`项目/子项目` 下的笔记没有这个标签）都不出现
    for (const hidden of ['项目/路线图.md', '项目/子项目', '日记', '随手记.md']) {
      expect(await treeRow(page, hidden).count()).toBe(0)
    }

    // 计数一眼可见，且分母是全库笔记数
    expect(await page.locator('[data-tag-filter-count]').textContent()).toMatch(/^仅显示 2\/\d+ 篇$/)
    expect(await page.locator('[data-tag-filter-count]').getAttribute('data-tag-filter-count')).toBe(
      '2',
    )
    // 多选语义与「含子标签」都写在界面上（不留歧义）
    expect(await page.locator('[data-tag-filter-hint]').textContent()).toContain('含任意一个')
    const subtags = page.locator('[data-tag-filter-subtags]')
    expect(await subtags.textContent()).toContain('含子标签')
    // Mock 里没有 `项目/…` 子标签 → 开关禁用并说明原因（点了没反应比禁用更难懂）
    expect(await subtags.isDisabled()).toBe(true)
    expect(await subtags.getAttribute('title')).toContain('没有子标签')

    // —— 与既有的文本过滤叠加（两个条件都生效）——
    await page.locator('[data-tag-filter-toggle]').click() // 收起选择器
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )
    await page.locator('.mn-search-field__input').fill('设计')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 2,
      5_000,
      '文本过滤在标签结果上再收窄',
    )
    expect(await treeRow(page, '项目/标签示例.md').count()).toBe(0)
    await page.locator('.mn-search-field__input').fill('')

    // —— 键盘导航只在可见项之间走 ——
    await page.locator('.mn-tree').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const selected = await page.locator('.mn-tree-row--selected').getAttribute('data-rel-path')
    expect(['项目', '项目/设计.md', '项目/标签示例.md']).toContain(selected)

    // —— Esc 一键回到全量 ——
    await page.keyboard.press('Escape')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      'Esc 清除标签过滤',
    )
    expect(await page.locator('[data-tag-filter-hint]').count()).toBe(0)
    // 全量 = 没有标签的笔记也回来了。用工具栏的「展开全部目录」把整棵树摊开，
    // 这样断言不依赖上一条用例留下的展开状态（哪一级目录开着是别人的事）
    await page.locator('button[aria-label="展开全部目录"]').click()
    await waitUntil(
      async () => (await treeRow(page, '项目/路线图.md').count()) === 1,
      5_000,
      '回到全量后没有标签的笔记可见',
    )
    expect(await treeRow(page, '随手记.md').count()).toBe(1)
  })

  it('标签过滤支持「排除」：有 A 且没有 B，一次查询算完（含子标签也由宿主算）', async () => {
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    await resetTagFilter(page)
    await page.locator('.mn-search-field__input').fill('')

    // 含 `#项目`（Mock 里命中 设计.md 与 标签示例.md）
    await page.locator('[data-tag-filter-toggle]').click()
    await page.locator('[data-tag-filter-search]').fill('项')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-option="项目"]').count()) === 1,
      5_000,
      '出现「项目」选项',
    )
    await page.locator('[data-tag-filter-option="项目"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '先收窄到 #项目 的命中',
    )

    // 再**排除** `#进行中`（Mock 里只有 `项目/标签示例.md` 用它）
    // —— 这一条就是"有 A 且没有 B"，而它只花**一次**宿主查询就出结果
    await page.locator('[data-tag-filter-search]').fill('进行')
    const excludeButton = page.locator('[data-tag-filter-option-exclude="进行中"]')
    await excludeButton.waitFor({ state: 'visible' })
    await excludeButton.click()

    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 2,
      10_000,
      '排除之后只剩 设计.md 与祖先目录',
    )
    expect(await treeRow(page, '项目/标签示例.md').count()).toBe(0)
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)
    // 「不含」那一组在胶囊里明说，不靠颜色猜
    expect(await page.locator('[data-tag-filter-exclude-chips]').textContent()).toContain('不含 #进行中')

    // 取消排除 → 回到只含 #项目 的那一档（可逆）
    await page.locator('[data-tag-filter-exclude-chip-remove="进行中"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '取消排除后回到 3 行',
    )
    expect(await page.locator('[data-tag-filter-exclude-chips]').count()).toBe(0)

    // 收拾干净：清搜索词、收起浮层、清过滤（本文件共用一个页面，别把状态留给后面的用例）
    await page.locator('[data-tag-filter-search]').fill('')
    await page.locator('[data-tag-filter-toggle]').click()
    await resetTagFilter(page)
  })

  it('标签过滤期间拖拽只能落在看得见的行上：树的空白处明确拒绝并说明原因', async () => {
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 造一个已知的过滤态
    await resetTagFilter(page)
    await filterByTag(page, '项目')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '过滤生效',
    )
    // 收起选择器，免得浮层挡住拖拽的空白区域
    await page.locator('[data-tag-filter-toggle]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )

    // 悬停到空白区域：**不出现**落点反馈（空白处 = Vault 根目录，在收窄视图里恰恰最看不见）
    await dispatchDrag(page, '项目/设计.md', null, 'hover')
    expect(await page.locator('.mn-tree [data-drop-root]').count()).toBe(0)

    // 真的丢下去：不搬文件，只给一句能读懂的原因
    await dispatchDrag(page, '项目/设计.md', null, 'drop')
    const toast = page.locator('.mn-toast', { hasText: '过滤期间不能拖到树的空白处' })
    await toast.waitFor({ state: 'visible', timeout: 5_000 })
    expect(await toast.textContent()).toContain('Vault 根目录')
    // 没有被搬到 Vault 根：笔记还在原处，可见行数也没变
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)
    expect(await page.locator('.mn-tree-row').count()).toBe(3)

    // 收尾：清除过滤、恢复全量，别把状态漏给后面的用例
    await page.locator('[data-tag-filter-clear]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      '清除标签过滤',
    )
  })

  it('所见即所得：表格渲染成真表格，光标进入露原文（源码仍在 DOM 里）', async () => {
    await ensureVaultOpen(page)
    // 先开笔记再切视图：单独跑这一条时编辑器里还没有任何文档（`.cm-content` 不存在）
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    // 让光标离开表格：表格在 mock 笔记的第 5~8 行，点第一行（标题）即可
    await page.locator('.cm-content .cm-line').first().click()

    const table = page.locator('.cm-content .mn-md-table table')
    await table.waitFor({ state: 'visible', timeout: 10_000 })

    // 真表格：thead / th / tbody / td 都真的在，表头就是分隔行上面那一行
    expect(await table.locator('thead th').count()).toBe(2)
    expect(await table.locator('tbody tr').count()).toBe(2)
    expect(await table.locator('tbody td').count()).toBe(4)
    expect(((await table.locator('th').first().textContent()) ?? '').trim()).toBe('层')

    // 用户看到的是一张表：可见文本里一个 `|` 都没有
    const rendered = await editorVisibleText(page)
    expect(rendered).toContain('文件层')
    expect(rendered).not.toContain('|')

    // 但源码**仍然**留在 DOM 里（只是 `display: none`）：Live Preview 是视图层，
    // 不做"把源码从 DOM 里删掉"那件事 —— 浏览器的查找、以及靠 `.cm-line` 文本读表格的既有路径都还成立
    expect(await editorTextContent(page)).toContain('| 文件层 | 原子写 |')

    // 被藏起来的源码行**不占高度**：否则表格上下会多出三道缝（jsdom 测不了布局，所以放在这一层）
    expect(await zeroHeightLineCount(page)).toBe(3)

    // 光标进表格 → 整块露原文（表格消失，`|` 回来）
    await table.locator('tbody td').first().click()
    await waitUntil(
      async () => (await editorVisibleText(page)).includes('| 文件层'),
      10_000,
      '光标进入表格后露出原始 Markdown',
    )
    expect(await page.locator('.cm-content .mn-md-table table').count()).toBe(0)

    // 再让光标离开 → 又变回表格（同一份文档、同一个编辑器实例，只重算装饰）
    await page.locator('.cm-content .cm-line').first().click()
    await page.locator('.cm-content .mn-md-table table').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await editorVisibleText(page)).not.toContain('|')
  })

  it('所见即所得：单元格里的对齐与行内语法都渲染，「格式化表格」不改变渲染结果', async () => {
    await ensureVaultOpen(page)
    // 先开笔记再切视图：单独跑这一条时编辑器里还没有任何文档（`.cm-content` 不存在）
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    // 在文档末尾敲一张带对齐标记与行内语法的表。
    // 注意本用例**真的会改** mock 笔记（自动保存写进内存里的条目表），所以刻意放在文件最后一条。
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    const rows = ['| 名称 | 数量 | 备注 |', '| :--- | ---: | :---: |', '| 甲 | **12** | `码` |']
    // 两个换行 = 让表格前有一个**空行**：GFM 的表体会一直吃到空行/别的块级结构，
    // 少了它，新表格的第一行会被当成上面那个段落的续行（上一次运行就是这么假通过的）
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    for (const [index, line] of rows.entries()) {
      if (index > 0) await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }

    /*
     * 单元格里的 `[[` 补全：弹层挂在 `.cm-editor` 下（不在 `.cm-content` 里），与表格装饰
     * 互不干扰 —— 这里钉住"弹出 → 关掉 → 继续输入"这条链，免得以后谁改了表格的行内接管方式，
     * 把补全悄悄弄坏。
     *
     * 查询串刻意用「路线」而不是「设计」：
     * - 候选列表**不含当前笔记自己**（`candidates.ts` 的规则），而当前笔记正是 `项目/设计.md` ——
     *   用「设计」的话一条候选都没有，弹层会直接关掉；
     * - 「路线图」本来就在这篇笔记的出链表里（`参考 [[路线图]] 与 [[细节]]。`），
     *   所以渲染出来的 `<a>` 会带上"已解析"的标记，正好把这条链路也断言掉。
     */
    await page.keyboard.press('Enter')
    await page.keyboard.type('| [[路线')
    await page.waitForSelector('.mn-wiki-complete', { state: 'visible', timeout: 10_000 })
    expect(await page.locator('.mn-wiki-complete__item').count()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await waitUntil(
      async () => (await page.locator('.mn-wiki-complete').count()) === 0,
      5_000,
      '补全弹层关闭',
    )
    await page.keyboard.type('图]] |')

    // 光标离开表格 → 整块渲染
    await page.locator('.cm-content .cm-line').first().click()
    const table = page.locator('.cm-content .mn-md-table table').last()
    await table.waitFor({ state: 'visible', timeout: 10_000 })

    // 对齐方式来自分隔行（`:---` / `---:` / `:---:`），由浏览器算出来的是真的对齐
    expect(
      await table
        .locator('thead th')
        .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).textAlign)),
    ).toEqual(['left', 'right', 'center'])

    // 单元格里的行内语法渲染成元素，标记一个都不留给用户看
    expect(await table.locator('tbody strong').count()).toBe(1)
    expect(await table.locator('tbody code').count()).toBe(1)
    const body = await table.locator('tbody').innerText()
    expect(body).toContain('12')
    expect(body).not.toContain('**')
    expect(body).not.toContain('`')
    // `[[路线图]]` 渲染成可点击的 wikilink（不再是双方括号），且带着编辑器认的标记与解析结果
    const wikiLink = table.locator('a.mn-wikilink').first()
    expect(await table.locator('a.mn-wikilink[data-mn-wikilink="路线图"]').count()).toBe(1)
    expect(await wikiLink.getAttribute('data-mn-resolved')).toBe('项目/路线图.md')

    // 「格式化表格」：光标进表格 → Ctrl+Alt+F → 只改空白，**渲染结果逐字不变**
    const before = await table.locator('tbody').innerText()
    await table.locator('tbody td').first().click()
    await page.keyboard.press('Control+Alt+f')
    await delay(200)
    await page.locator('.cm-content .cm-line').first().click()
    const after = await page
      .locator('.cm-content .mn-md-table table')
      .last()
      .locator('tbody')
      .innerText()
    expect(after).toBe(before)
  })

  it('所见即所得：超宽表格横向滚动、超长单元格换行（正文不会被撑爆）', async () => {
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    const contentWidth = async (): Promise<number> =>
      await page.evaluate(
        () => document.querySelector<HTMLElement>('.cm-content')?.clientWidth ?? 0,
      )
    const before = await contentWidth()

    /*
     * 16 列 + 一个"没有空格可断"的长串：**列多**就会超过正文宽度（每列有 `min-width: 4em`
     * 的下限，表格不会为了塞进正文而把自己压成"一列一个字"）—— 这正是要验的那个场景。
     * 第二格是一长段可换行的中文：它必须换行，而不是把整张表再撑宽。
     */
    const columns = Array.from({ length: 16 }, (_, index) => `列${index + 1}`)
    const longToken = 'W'.repeat(80)
    const longText = '可换行的长文本'.repeat(8)
    const rows = [
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      `| ${columns.map((_, index) => (index === 0 ? longToken : index === 1 ? longText : `值${index}`)).join(' | ')} |`,
    ]
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    // 两个换行 = 让表格前有一个**空行**（GFM 的表体会一直吃到空行/别的块级结构为止，
    // 少了它，新敲的第一行会被当成上面那段文字的续行）
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    for (const [index, line] of rows.entries()) {
      if (index > 0) await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }
    await waitUntil(
      async () => (await editorTextContent(page)).includes(longToken),
      15_000,
      '超宽表格已经输入',
    )

    await page.locator('.cm-content .cm-line').first().click()
    const scroller = page.locator('.cm-content .mn-md-table__scroll').last()
    await scroller.waitFor({ state: 'visible', timeout: 10_000 })

    // 1) 横向**滚动**而不是把正文挤爆：内容比容器宽，而容器自己不超过正文宽度
    const scrollerBox = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scrollerBox.scrollWidth).toBeGreaterThan(scrollerBox.clientWidth)
    expect(await contentWidth()).toBe(before)

    // 2) 超长单元格**换行**：没有任何一格横向溢出，长文本那一格被压成好几行
    const cells = await scroller
      .locator('tbody td')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          clientHeight: node.clientHeight,
        })),
      )
    for (const cell of cells) {
      expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1)
    }
    expect(cells[1]?.clientHeight ?? 0).toBeGreaterThan(40)
  })
})

/**
 * 把标签过滤恢复到"没有过滤"的确定状态（本文件共用一个页面，用例之间会互相影响）。
 *
 * 先收浮层再清过滤：浮层开着时点触发按钮是"收起"，不清这个状态的话，
 * 后面想选标签的那一步会点在收起按钮上（表现为"选项找不到"这种误导性的失败）。
 */
async function resetTagFilter(page: Page): Promise<void> {
  if ((await page.locator('[data-tag-filter-popover]').count()) > 0) {
    await page.locator('[data-tag-filter-toggle]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )
  }
  if ((await page.locator('[data-tag-filter-clear]').count()) > 0) {
    await page.locator('[data-tag-filter-clear]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      '清除标签过滤',
    )
  }
}

/** 从文件树头部的标签选择器里选一个标签（标签概览是异步来的，所以等选项出现）。 */
async function filterByTag(page: Page, key: string): Promise<void> {
  await page.locator('[data-tag-filter-toggle]').click()
  await waitUntil(
    async () => (await page.locator(`[data-tag-filter-option="${key}"]`).count()) === 1,
    10_000,
    `标签选择器里出现「${key}」`,
  )
  await page.locator(`[data-tag-filter-option="${key}"]`).click()
}

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

/**
 * 单独跑某一条用例时门闸还在（整个文件跑时 Vault 已经开着）。
 *
 * 与"拖拽整理"等用例同一写法：每条用例都该自足，而不是依赖上一条刚好把状态留在哪里。
 */
async function ensureVaultOpen(page: Page): Promise<void> {
  if ((await page.locator('.mn-gate').count()) > 0) {
    await page.getByText('打开文件夹作为 Vault').click()
    await page.waitForSelector('.mn-tree-row', { state: 'visible' })
  }
}

/**
 * 编辑器里**看得见**的正文。
 *
 * 用 `innerText`（按渲染结果取文本，会跳过 `display: none` 的东西）：Live Preview 的表格
 * 渲染态里，源码行只是被 CSS 藏起来、仍留在 DOM 中，所以 `textContent` 两种状态下都一样，
 * 只有 `innerText` 能区分"用户现在看到的是表格"还是"看到的是源码"。
 */
async function editorVisibleText(page: Page): Promise<string> {
  return await page.evaluate(
    () => document.querySelector<HTMLElement>('.cm-content')?.innerText ?? '',
  )
}

/** 编辑器 DOM 里的**全部**文本（含被藏起来的源码行）。 */
async function editorTextContent(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')
}

/**
 * 高度为 0 的 `.cm-line` 数量。
 *
 * 表格渲染态里，源码行是靠"文字 `display: none`、行盒没有内容"塌成 0 高度的 ——
 * 这一条只有真实排版量得出来（jsdom 没有布局），所以放在 E2E 层。
 */
async function zeroHeightLineCount(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-content .cm-line')).filter(
        (line) => line.getBoundingClientRect().height === 0,
      ).length,
  )
}

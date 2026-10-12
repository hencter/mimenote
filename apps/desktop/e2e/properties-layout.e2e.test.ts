/**
 * 属性区的**真实排版**门禁（Edge + dist + Mock Vault）。
 *
 * 这里钉四件 jsdom 测不出来的事 —— 它们全都是用户肉眼报出来的"细节"，
 * 而"细节"必须用可量的数字钉住，否则下次重构又会悄悄歪掉：
 *
 * 1. **类型图标对齐**：三行（文本 / 标签 / 单选）的图标墨迹中心与它所在的 24px 槽中心
 *    重合，且三行之间互差 ≤ 0.5px。曾经它整体左偏 2px（`.mn-select` 的
 *    `justify-content:space-between` + 不对称内边距），jsdom 里量不出来。
 * 2. **图标光学校大小**：`dot` 字形在 14px 档下只有 1.2px 墨迹宽，那一行看起来像"少了图标"
 *    （用户报的就是这一列）。现在单选用 `circleDot`，最小墨迹宽有下限。
 * 3. **显隐控制悬浮才出现**：默认 `opacity:0`，鼠标移到属性区才浮出来；但它**必须保留盒**
 *    （否则收起态下既看不见又碰不到，面板再也打不开）。
 * 4. **从"没有 frontmatter 的笔记"切回"有 frontmatter 的笔记"，面板要自动展开**：
 *    非当前分栏的正文是挂载之后才读到的，早先只看挂载态 → 面板停在折叠态。
 */

import { join } from 'node:path'

import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { findFreePort, packageRoot } from './support/harness'
import { startStaticServer, type StaticServer } from './support/static-server'

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`等待超时：${what}`)
}

/** 每行类型图标的几何：槽、触发器、SVG，以及 SVG 自己报出来的**墨迹**范围。 */
const MEASURE = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, w: r.width, cx: r.x + r.width / 2 }
  }
  return Array.from(document.querySelectorAll('.mn-metadata__row')).map((row) => {
    const slot = row.querySelector('.mn-metadata__type')
    const svg = slot?.querySelector('svg')
    let inkCx = null
    let inkW = null
    if (svg) {
      const b = svg.getBBox()
      const vb = svg.viewBox.baseVal
      const s = svg.getBoundingClientRect()
      const scale = s.width / (vb.width || 24)
      inkCx = s.x + (b.x + b.width / 2) * scale
      inkW = b.width * scale
    }
    return { name: row.querySelector('.mn-metadata__key input')?.value ?? '?', slot: box(slot), inkCx, inkW }
  })
})()`

describe('属性区排版（Edge + dist + Mock Vault）', () => {
  let server: StaticServer
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const port = await findFreePort()
    server = await startStaticServer(join(packageRoot(), 'dist'), port)
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await page.goto(server.url)
    await page.waitForSelector('.mn-gate', { state: 'visible' })
  }, 120_000)

  afterAll(async () => {
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (server !== undefined) await server.close()
  })

  /** 打开一篇笔记（必要时先在树里找到它）。 */
  async function open(relPath: string): Promise<void> {
    const row = page.locator(`.mn-tree [data-rel-path="${relPath}"]`)
    await row.waitFor({ state: 'visible', timeout: 10_000 })
    await row.click()
    await waitUntil(
      async () => (await page.locator('[data-main-path]').getAttribute('data-main-path')) === relPath,
      10_000,
      `打开 ${relPath}`,
    )
  }

  test('类型图标列：三行墨迹中心与槽中心重合，且互相对齐', async () => {
    await page.getByText('打开文件夹作为 Vault').click()
    await page.waitForSelector('.mn-tree-row', { state: 'visible' })

    // 这篇的 frontmatter 是 title + tags（与用户截图同一对）
    await open('项目/标签示例.md')
    await page.waitForSelector('.mn-metadata__row', { state: 'visible' })

    // 用界面加第三条属性：select（用户截图里它是那个几乎看不见的小圆点）
    await page.getByRole('button', { name: '添加笔记属性' }).click()
    await page.getByLabel('新属性名称').fill('select')
    await page.getByLabel('新属性名称').press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-metadata__row').count()) === 3,
      10_000,
      '新增第三条属性',
    )

    // 三条属性各配一种类型：文本 / 标签 / 单选 —— 正好复现截图里的 T、tag、点
    const root = await page.evaluate(() => {
      const raw = localStorage.getItem('mimenote.tabs.v1')
      if (raw === null) return null
      return Object.keys(JSON.parse(raw) as Record<string, unknown>)[0] ?? null
    })
    await page.evaluate((vaultRoot) => {
      const put = (name: string, cfg: unknown) => {
        localStorage.setItem(
          `mimenote.property.config.v1:${JSON.stringify([vaultRoot, name])}`,
          JSON.stringify(cfg),
        )
      }
      put('title', { type: 'text', options: [] })
      put('tags', { type: 'tags', options: ['项目'] })
      put('select', { type: 'single', options: ['Test'] })
    }, root)

    // 类型配置只在属性行挂载时读一次 —— 切走再切回来
    await open('README.md')
    await open('项目/标签示例.md')
    await page.waitForSelector('.mn-metadata__row', { state: 'visible' })

    const rows = (await page.evaluate(MEASURE)) as { name: string; slot: { cx: number }; inkCx: number; inkW: number }[]
    expect(rows.map((row) => row.name)).toEqual(['title', 'tags', 'select'])

    // ① 每个图标的墨迹中心 == 它所在 24px 槽的中心（左偏 2px 的旧毛病）
    for (const row of rows) {
      expect(Math.abs(row.inkCx - row.slot.cx), `${row.name} 的图标没有落在槽中心`).toBeLessThanOrEqual(0.5)
    }
    // ② 三行互相对齐（曾经它们是"对齐的"，所以这条是防回归，不是主诉）
    const centers = rows.map((row) => row.inkCx)
    expect(Math.max(...centers) - Math.min(...centers), '三行图标中心互差').toBeLessThanOrEqual(0.5)
    // ③ 光学校大小：不再有"1.2px 的点"混在 10px 的图标里
    expect(Math.min(...rows.map((row) => row.inkW)), '最小墨迹宽').toBeGreaterThanOrEqual(8)
  }, 120_000)

  test('显隐控制悬浮才出现，但收起态下仍然可点得到', async () => {
    const toggle = page.locator('.mn-metadata__toggle')
    const opacity = () => toggle.evaluate((el) => getComputedStyle(el).opacity)

    // 先把鼠标挪开（上一条用例结束时它可能停在属性区上）
    await page.mouse.move(5, 5)
    await waitUntil(async () => (await opacity()) === '0', 5_000, '显隐控制自己隐回去')
    // 关键：隐形但**占位**（宽高不是 0），否则收起之后再也点不开
    const box = await toggle.boundingBox()
    expect(box, '显隐控制不该被 display:none').not.toBeNull()
    expect(box?.width ?? 0).toBeGreaterThan(20)

    await page.locator('.mn-metadata').hover()
    await waitUntil(async () => (await opacity()) === '1', 5_000, '鼠标移上去后控制出现')
  }, 60_000)

  test('从没有 frontmatter 的笔记切回来，属性面板自动展开', async () => {
    // README 没有 frontmatter：切过去时面板收起是**正确**的
    await open('README.md')
    await waitUntil(
      async () => (await page.locator('.mn-metadata__row').count()) === 0,
      10_000,
      'README 本来就没有属性区',
    )
    // 切回来：面板必须自己展开，而不是停在上一次的折叠态
    await open('项目/标签示例.md')
    await waitUntil(
      async () => (await page.locator('.mn-metadata__row').count()) > 0,
      10_000,
      '切回有 frontmatter 的笔记后面板自动展开',
    )
  }, 60_000)

  test('功能面板自带隐藏入口：文件树与大纲', async () => {
    // 文件树：点面板头上的隐藏按钮 → 格子收缩；再用同一条开关（Ctrl+B）放回来
    const hideTree = page.locator('[aria-label="隐藏文件树面板"]')
    await hideTree.waitFor({ state: 'visible', timeout: 10_000 })
    await hideTree.click()
    await waitUntil(async () => (await page.locator('.mn-tree').count()) === 0, 10_000, '文件树被隐藏')
    await page.keyboard.press('Control+Shift+b')
    await page.waitForSelector('.mn-tree', { state: 'visible' })

    // 大纲：先按它的开关让它露面，再点它自己的隐藏按钮
    await page.keyboard.press('Control+Shift+O')
    await page.waitForSelector('.mn-outline', { state: 'visible' })
    await page.locator('[aria-label="隐藏大纲面板"]').click()
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 10_000, '大纲被隐藏')
  }, 60_000)
})

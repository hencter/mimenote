/**
 * 真实应用 smoke E2E —— **本地发布前手动跑**的最小主路径集。
 *
 * 覆盖发布门禁清单（五条主路径，共用一个应用实例，不重复构建二进制）：
 * 1. 打开 Vault（命令行参数 → 文件树渲染）
 * 2. 打开笔记（文件树 → 编辑器载入磁盘内容）
 * 3. 编辑并保存（输入 → 防抖落盘 → 断言真实文件字节）
 * 4. 搜索（真实 FTS5：命中 → 回车打开那一篇 —— 兼作导航主路径）
 * 5. 链接导航（阅读视图里点已解析的 wikilink 跳到目标笔记）
 *
 * 与 `real-app.e2e.test.ts` 共用同一个底座（`support/harness.ts`）；
 * 完整功能回归仍在 `real-app.e2e.test.ts`，这里只做"能不能走通主路径"的门禁。
 *
 * 运行：
 * ```bash
 * pnpm --filter @mimenote/desktop exec tauri build --no-bundle   # 先产出 release 二进制
 * pnpm test:e2e:app:smoke
 * ```
 *
 * 平台限制与 `real-app.e2e.test.ts` 相同：WebView2 远程调试只在 Windows 上存在，
 * 其它平台显式跳过（不假装通过）。
 */

import type { Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  actUntil,
  createTempVault,
  delay,
  launchApp,
  saveFailureScreenshot,
  waitForFileContent,
  type LaunchedApp,
  type TempVault,
} from './support/harness'

const supported = process.platform === 'win32'

const NOTE_HELLO = 'notes/hello.md'
const NOTE_WORLD = 'notes/world.md'

/** 轮询条件成立（与 real-app.e2e.test.ts 同款，两层各自留一份）。 */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(150)
  }
  throw new Error(`等待超时：${what}`)
}

/** 标题栏中区的当前笔记路径（三种视图里都在）；未打开时元素不渲染，返回 `null`。 */
async function currentMainPath(page: Page): Promise<string | null> {
  const node = page.locator('[data-main-path]')
  if ((await node.count()) === 0) return null
  return node.getAttribute('data-main-path')
}

describe.skipIf(!supported)('真实应用 smoke：主路径门禁（本地发布前手动跑）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      [NOTE_HELLO]: '# 你好\n\n这是 smoke 笔记。\n\n链接到 [[world]]。\n',
      [NOTE_WORLD]: '# 世界\n\nsmoke 搜索关键词：灯塔。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
  }, 120_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && app !== undefined) {
      await saveFailureScreenshot(app.page, task.name)
    }
  })

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('打开 Vault：命令行参数指定的 Vault 被自动打开，文件树渲染出条目', async () => {
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
    expect(await app.page.locator('.mn-tree-row').count()).toBeGreaterThanOrEqual(2)
    await app.page
      .locator('.mn-tree [data-rel-path="notes"]')
      .waitFor({ state: 'visible', timeout: 5_000 })
    expect(await app.page.locator('.mn-gate').count()).toBe(0)
  })

  it('打开笔记：文件树点选后编辑器载入磁盘内容', async () => {
    await app.page.locator(`.mn-tree [data-rel-path="${NOTE_HELLO}"]`).click()
    await app.page.waitForSelector('.cm-content', { state: 'visible', timeout: 15_000 })
    await waitUntil(
      async () => ((await app.page.locator('.cm-content').textContent()) ?? '').includes('这是 smoke 笔记'),
      15_000,
      '编辑器载入笔记内容',
    )
    expect(await currentMainPath(app.page)).toBe(NOTE_HELLO)
  })

  it('编辑并保存：输入的标记经防抖后写回真实磁盘', async () => {
    await app.page.waitForSelector('.cm-content', { state: 'visible', timeout: 15_000 })
    const marker = `smoke-标记-${Date.now()}`
    await app.page.locator('.cm-content').click()
    await app.page.keyboard.press('Control+End')
    await app.page.keyboard.type(`\n${marker}\n`)

    const content = await waitForFileContent(vault, NOTE_HELLO, (text) => text.includes(marker), 20_000)
    expect(content).toContain('这是 smoke 笔记')
    expect(content).toContain(marker)
    await waitUntil(
      async () => ((await app.page.locator('.mn-statusbar').textContent()) ?? '').includes('已保存'),
      8_000,
      '状态栏显示已保存',
    )
  })

  it('搜索：全文搜索命中 → 回车打开那一篇（真实 FTS5）', async () => {
    await app.page.keyboard.press('Control+Shift+F')
    await app.page.waitForSelector('.mn-palette', { state: 'visible', timeout: 10_000 })
    expect(await app.page.locator('.mn-palette').getAttribute('aria-label')).toBe('全文搜索')

    // 索引在 vault_open 之后后台构建；"灯塔" 只出现在 world.md 里，等结果出现即可
    await app.page.locator('.mn-palette__input').fill('灯塔')
    await waitUntil(
      async () =>
        (await app.page.locator(`.mn-palette [role="option"][data-rel-path="${NOTE_WORLD}"]`).count()) === 1,
      25_000,
      '真实索引返回命中',
    )
    const text =
      (await app.page.locator(`.mn-palette [role="option"][data-rel-path="${NOTE_WORLD}"]`).textContent()) ?? ''
    expect(text).toContain('灯塔')

    await app.page.locator('.mn-palette__input').press('Enter')
    await waitUntil(async () => (await currentMainPath(app.page)) === NOTE_WORLD, 15_000, '回车打开命中的笔记')
    expect(await app.page.locator('.mn-palette').count()).toBe(0)
  })

  it('链接导航：阅读视图里点已解析的 wikilink 跳到目标笔记', async () => {
    // 自足：从 hello.md 出发（不依赖上一条用例留下的视图状态）
    const editButton = app.page.locator('button[aria-label="编辑（所见即所得）"]')
    if ((await editButton.count()) > 0) await editButton.click()
    await app.page.locator(`.mn-tree [data-rel-path="${NOTE_HELLO}"]`).click()
    await waitUntil(async () => (await currentMainPath(app.page)) === NOTE_HELLO, 15_000, '打开 hello.md')

    await app.page.locator('button[aria-label="阅读（渲染后）"]').click()
    await app.page.waitForSelector('.mn-preview__body a.mn-wikilink', { state: 'visible', timeout: 10_000 })
    // wikilink 解析依赖后台索引：等到它被标记上目标路径再点
    await waitUntil(
      async () =>
        (await app.page.locator('.mn-preview__body a.mn-wikilink').first().getAttribute('data-rel-path')) !== null,
      25_000,
      'wikilink 被标记为已解析',
    )

    await actUntil(
      async () => {
        await app.page.locator('.mn-preview__body a.mn-wikilink').first().click()
      },
      async () => (await currentMainPath(app.page)) === NOTE_WORLD,
      '点击 wikilink 跳到 world.md',
    )
  })
})

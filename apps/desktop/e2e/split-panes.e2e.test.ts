/**
 * 分栏两格**各自可写** + **两边同时显示属性区**（用户需求，真实 Edge + dist + Mock Vault）。
 *
 * 这一层要钉的是 jsdom 测不出来的东西，也正是用户报的那两件：
 *
 * 1. **属性面板每一格都有**：从前它只在"当前文档那一格"渲染（`relPath === activePath`），
 *    非当前那格连 frontmatter 都看不见 —— 它在编辑器里默认折叠成装饰，而唤出它的入口
 *    只长在那个面板里；
 * 2. **每一格都能编辑**：每格一个 CodeMirror 实例、各自绑定自己的文档。写错目标的后果是
 *    "A 的正文盖到 B 上"，所以这里断言的是**互相不串**：在右栏打字，左栏一字不动；
 *    在左栏打字，右栏保留自己的内容；
 * 3. **脏标记按篇**：右栏改了，● 出现在右栏那条标签上（不是"当前文档"那条）；
 * 4. **落盘真的落在那一篇上**：等自动保存把 ● 消掉，关掉右栏标签（**不该弹未保存确认**），
 *    再从文件树重新打开它 —— 打进去的字还在（这一读是走磁盘的）。
 */

import { join } from 'node:path'

import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { findFreePort, packageRoot } from './support/harness'
import { startStaticServer, type StaticServer } from './support/static-server'

/** Mock Vault 的根（`mock-adapter` 的固定常量）。 */
const MOCK_ROOT = 'C:\\MockVault'
const LEFT_NOTE = '项目/标签示例.md'
const RIGHT_NOTE = 'README.md'
/** 在右栏正文里打进去的记号（够独特，不会与 Mock 正文撞上）。 */
const RIGHT_MARK = '右栏专属标记ZZ9'

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

function pane(page: Page, leafId: string) {
  return page.locator(`[data-leaf-id="${leafId}"]`)
}

describe('分栏：两格各自可写、各自显示属性区（Edge + dist + Mock Vault）', () => {
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

  test('两格各自可写、两边同时显示属性区', async () => {
    /*
     * 注入一个"左树 + 中间两格"的布局：主叶放 `标签示例.md`（有 frontmatter），
     * 右格放 `README.md`（本来没有 frontmatter —— 稍后**从右栏自己**加一条属性，
     * 这既是"两边同时显示属性区"的证据，也是"非当前那格可写"的证据）。
     *
     * ⚠️ 必须走 `addInitScript`（**页面脚本跑之前**就写好）：正在运行的实例会持续把
     * 内存里的布局写回 `mimenote.ui.v1`，在 `evaluate` 与 `reload` 之间把它覆盖掉 ——
     * 那样重载后拿到的其实是旧布局（实测：两篇笔记都被并进主叶）。
     */
    await page.addInitScript(
      ({ root, left, right }) => {
        const leaf = (id: string, items: string[], active: string | null) => ({ kind: 'leaf', id, items, active })
        localStorage.setItem(
          'mimenote.ui.v1',
          JSON.stringify({
            layout: {
              kind: 'split',
              id: 'root',
              axis: 'row',
              ratio: 0.22,
              a: leaf('left-tree', ['tree'], 'tree'),
              b: {
                kind: 'split',
                id: 's1',
                axis: 'row',
                ratio: 0.5,
                a: leaf('main', [`note:${left}`], `note:${left}`),
                b: leaf('right-pane', [`note:${right}`], `note:${right}`),
              },
            },
          }),
        )
        localStorage.setItem(
          'mimenote.tabs.v1',
          JSON.stringify({ [root]: { tabs: [left, right], active: left } }),
        )
      },
      { root: MOCK_ROOT, left: LEFT_NOTE, right: RIGHT_NOTE },
    )
    await page.reload()
    // 单独跑时重载会回到门闸；整套跑时 Vault 已恢复 —— 两种都接住
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }

    // 两格各自渲染出自己的编辑器，且内容正确（不是同一篇）
    await waitUntil(
      async () =>
        (await pane(page, 'main').locator('.cm-content').count()) === 1 &&
        (await pane(page, 'right-pane').locator('.cm-content').count()) === 1,
      15_000,
      '两格各有一个编辑器',
    )
    await waitUntil(
      async () =>
        ((await pane(page, 'main').locator('.cm-content').textContent()) ?? '').includes('这一段用来演示') &&
        ((await pane(page, 'right-pane').locator('.cm-content').textContent()) ?? '').includes('示例 Vault'),
      15_000,
      '两格各自显示自己的正文',
    )
    // 当前文档仍是左栏那一篇（右栏新出现的格子**不抢**当前文档）
    expect(await page.locator('[data-main-path]').getAttribute('data-main-path')).toBe(LEFT_NOTE)

    // 左栏有 frontmatter → 属性区本来就该在（这是"当前文档那一格"的旧行为，不能退化）
    await waitUntil(
      async () => (await pane(page, 'main').locator('.mn-metadata__row').count()) >= 1,
      10_000,
      '左栏显示属性区',
    )
    // 右栏本来没有 frontmatter：从**右栏自己**加一条属性（非当前那格必须可写）
    const rightMeta = pane(page, 'right-pane').locator('.mn-metadata')
    await rightMeta.hover()
    await pane(page, 'right-pane').locator('.mn-metadata__toggle').click()
    await pane(page, 'right-pane').getByRole('button', { name: '添加笔记属性' }).click()
    await pane(page, 'right-pane').getByLabel('新属性名称').fill('select')
    await pane(page, 'right-pane').getByLabel('新属性名称').press('Enter')
    await waitUntil(
      async () => (await pane(page, 'right-pane').locator('.mn-metadata__row').count()) >= 1,
      10_000,
      '右栏出现属性行（新增的那条）',
    )
    // 两边同时看得到属性区 —— 这正是用户最初报的那件事
    expect(await pane(page, 'main').locator('.mn-metadata').count()).toBe(1)
    expect(await pane(page, 'right-pane').locator('.mn-metadata').count()).toBe(1)

    // ---- 在右栏打字：只有右栏那一篇变，左栏一字不动 --------------------------------
    await pane(page, 'right-pane').locator('.cm-content').click()
    await page.keyboard.type(RIGHT_MARK)
    await waitUntil(
      async () =>
        ((await pane(page, 'right-pane').locator('.cm-content').textContent()) ?? '').includes(RIGHT_MARK),
      10_000,
      '右栏正文里出现刚打的字',
    )
    expect(
      (await pane(page, 'main').locator('.cm-content').textContent()) ?? '',
      '左栏不该出现右栏打的字',
    ).not.toContain(RIGHT_MARK)
    // 脏标记挂在**右栏那条标签**上（不是当前文档那条）
    await waitUntil(
      async () =>
        (await pane(page, 'right-pane').locator(`[data-tab-path="${RIGHT_NOTE}"] .mn-tabs__mark--dirty`).count()) === 1,
      5_000,
      '右栏标签出现未保存标记',
    )

    // ---- 等自动保存把 ● 消掉（这一篇自己的防抖保存） --------------------------------
    await waitUntil(
      async () =>
        (await pane(page, 'right-pane').locator(`[data-tab-path="${RIGHT_NOTE}"] .mn-tabs__mark`).count()) === 0,
      15_000,
      '右栏的未保存标记消失（已落盘）',
    )

    // ---- 在左栏打字：左栏有自己的文档，右栏的内容不许被动 --------------------------
    await pane(page, 'main').locator('.cm-content').click()
    await page.keyboard.type(' 左栏专属标记ZZ8')
    await waitUntil(
      async () =>
        ((await pane(page, 'main').locator('.cm-content').textContent()) ?? '').includes('左栏专属标记ZZ8'),
      10_000,
      '左栏正文里出现刚打的字',
    )
    expect(
      (await pane(page, 'right-pane').locator('.cm-content').textContent()) ?? '',
      '右栏不该出现左栏打的字',
    ).not.toContain('左栏专属标记ZZ8')
    expect(
      (await pane(page, 'right-pane').locator('.cm-content').textContent()) ?? '',
      '右栏自己的内容还在',
    ).toContain(RIGHT_MARK)

    // ---- 关掉右栏标签（不该弹"未保存"确认）→ 重新打开 → 打进去的字还在（走磁盘）----
    await pane(page, 'right-pane').locator(`[data-tab-path="${RIGHT_NOTE}"] .mn-tabs__close`).click()
    await delay(300)
    expect(await page.locator('.mn-overlay').count(), '刚保存过，不该弹未保存确认').toBe(0)

    const row = page.locator(`.mn-tree [data-rel-path="${RIGHT_NOTE}"]`)
    await row.waitFor({ state: 'visible', timeout: 10_000 })
    await row.click()
    await waitUntil(
      async () => (await page.locator('[data-main-path]').getAttribute('data-main-path')) === RIGHT_NOTE,
      10_000,
      `重新打开 ${RIGHT_NOTE}`,
    )
    // 重新打开是**读盘**的（刚才 closeDoc 已经把内存那一份收掉了）—— 打进去的字必须还在
    await waitUntil(
      async () =>
        ((await page.locator('[data-leaf-id="main"] .cm-content').textContent()) ?? '').includes(RIGHT_MARK),
      15_000,
      '重新打开后从磁盘读回刚才打的字',
    )
  }, 180_000)
})

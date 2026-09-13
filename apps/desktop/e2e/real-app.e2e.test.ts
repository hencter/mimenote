/**
 * 真实应用 E2E：Playwright 通过 CDP 接管 release 二进制的 WebView2。
 *
 * 覆盖 M1 的三步闭环（打开 Vault → 编辑 → 保存），并且**验证真实文件 IO**：
 * 断言的是磁盘上的内容，而不是 mock 内存。
 *
 * 运行：
 * ```bash
 * pnpm --filter @mimenote/desktop exec tauri build --no-bundle   # 先产出 release 二进制
 * pnpm test:e2e:app
 * ```
 *
 * 平台限制：WebView2 的远程调试只在 Windows 上存在。其它平台会跳过（不假装通过）。
 */

import { existsSync, readdirSync } from 'node:fs'

import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createTempVault,
  delay,
  launchApp,
  waitForFileContent,
  type LaunchedApp,
  type TempVault,
} from './support/harness'

const NOTE_MAIN = 'notes/hello.md'
const NOTE_CONFLICT = 'notes/conflict.md'

const supported = process.platform === 'win32'

/** 轮询条件成立（避免依赖 Playwright 的 expect 匹配器 —— 那是 @playwright/test 的，不在 core 里）。 */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(150)
  }
  throw new Error(`等待超时：${what}`)
}

/** 文件树里的某一行（限定在 `.mn-tree` 内：预览里的 wikilink 也会带 data-rel-path）。 */
function treeRow(page: Page, relPath: string) {
  return page.locator(`.mn-tree [data-rel-path="${relPath}"]`)
}

/**
 * 确保文件树里某一行可见。
 *
 * ⚠️ **只在行不存在时**才去点父目录展开它。先前这里无条件点父目录，
 * 而顶层目录默认就是展开的 —— 那一下反而把它折叠了，子行随即消失（用例因此超时）。
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

/** 打开某篇笔记（自足：不依赖上一条用例留下的树/面板状态）。 */
async function openNoteInTree(page: Page, relPath: string): Promise<void> {
  await ensureTreeRow(page, relPath)
  await treeRow(page, relPath).click()
  await waitUntil(
    async () => ((await page.locator('.mn-editor__path').textContent()) ?? '').includes(relPath),
    15_000,
    `打开 ${relPath}`,
  )
}

/** 确保链接面板已打开。 */
async function ensureLinksPanel(page: Page): Promise<void> {
  if ((await page.locator('.mn-links').count()) === 0) {
    await page.locator('button[aria-label="链接面板"]').click()
  }
  await page.waitForSelector('.mn-links', { state: 'visible', timeout: 10_000 })
}

describe.skipIf(!supported)('真实应用：启动与布局（不打开任何笔记）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      'README.md': '# 欢迎\n',
      [NOTE_MAIN]: '# 你好\n\n这是 E2E 用的笔记。\n',
      'notes/plain.md': '# 无冲突\n',
    })
    app = await launchApp({ vaultPath: vault.path })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('命令行参数指定的 Vault 被自动打开，文件树渲染出条目', async () => {
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
    expect(await app.page.locator('.mn-tree-row').count()).toBeGreaterThanOrEqual(3)
    // 目录节点也在（notes 目录）
    await app.page.locator('.mn-tree [data-rel-path="notes"]').waitFor({ state: 'visible', timeout: 5_000 })
    // 门闸页不应该还在
    expect(await app.page.locator('.mn-gate').count()).toBe(0)
  })

  it('布局铺满窗口：主体吃掉剩余高度、状态栏贴在底部、文件树有实际高度', async () => {
    const metrics = await app.page.evaluate(() => {
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
      }
    })

    // 主体高度 = 窗口高度 - 标题栏 - 状态栏（允许 2px 边框/取整误差）
    const expectedBody = metrics.innerHeight - metrics.titlebar.height - metrics.statusbar.height
    expect(Math.abs(metrics.body.height - expectedBody)).toBeLessThanOrEqual(2)

    // 状态栏贴在窗口底部（而不是浮在中间）
    expect(Math.abs(metrics.statusbar.bottom - metrics.innerHeight)).toBeLessThanOrEqual(1)

    // 侧栏与主体等高
    expect(Math.abs(metrics.sidebar.height - metrics.body.height)).toBeLessThanOrEqual(1)

    // 文件树真的占了空间（contain: strict 下若忘了 min-height: 0 会被压成 0）
    expect(metrics.tree.height).toBeGreaterThan(100)

    // 这一条是今天那个 bug 的回归门禁：**没有选中笔记**时也必须铺满
    expect(await app.page.locator('.cm-content').count()).toBe(0)
  })

  // 说明：这里**不**测"拖动窗口大小后布局跟随"。
  // WebView2 的 CDP 只暴露部分域，`Emulation.setDeviceMetricsOverride` 不存在，
  // 无法在应用层改变窗口尺寸。缩放场景放在 UI 层（真实 Chromium，支持视口切换）验证，
  // 见 e2e/ui.e2e.test.ts 的"缩小窗口后布局跟随"。
})

describe.skipIf(!supported)('真实应用：链接索引（真实 wikilink 解析）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      '笔记/甲.md': '# 甲\n\n见 [[乙]] 与 [[丙]]，还有一个还没写的 [[丁]]。\n',
      '笔记/乙.md': '# 乙\n\n回到 [[甲]]。\n',
      '笔记/丙.md': '# 丙\n\n没有出链。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('后台索引完成后，面板里能看到出链与反向链接', async () => {
    await openNoteInTree(app.page, '笔记/甲.md')
    await ensureLinksPanel(app.page)

    // 索引在后台跑，状态标签会从"索引中"变为"已索引"
    await waitUntil(
      async () => ((await app.page.locator('.mn-links__status').textContent()) ?? '').includes('已索引'),
      30_000,
      '后台索引完成',
    )

    // 出链：乙、丙（已解析）+ 丁（悬空）
    const outbound = await app.page.locator('[data-outbound-target]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-outbound-target')),
    )
    expect(outbound).toContain('乙')
    expect(outbound).toContain('丙')
    expect(outbound).toContain('丁')

    // 反向链接：乙指向甲
    await waitUntil(
      async () => (await app.page.locator('[data-backlink-from="笔记/乙.md"]').count()) === 1,
      15_000,
      '反向链接里出现乙',
    )
  })

  it('点击反向链接跳转，点击悬空链接创建真实文件', async () => {
    // 自足：不依赖上一条用例留下的树/面板状态
    await openNoteInTree(app.page, '笔记/甲.md')
    await ensureLinksPanel(app.page)
    await waitUntil(
      async () => (await app.page.locator('[data-backlink-from="笔记/乙.md"]').count()) === 1,
      30_000,
      '反向链接里出现乙',
    )

    // 点反向链接 → 打开乙
    await app.page.locator('[data-backlink-from="笔记/乙.md"]').click()
    await waitUntil(
      async () => ((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes('笔记/乙.md'),
      15_000,
      '跳转到乙',
    )
    // 乙 的反向链接里应有甲
    await waitUntil(
      async () => (await app.page.locator('[data-backlink-from="笔记/甲.md"]').count()) === 1,
      15_000,
      '乙的反向链接里出现甲',
    )

    // 回到甲，点悬空链接「丁」→ 真的在磁盘上创建笔记
    await openNoteInTree(app.page, '笔记/甲.md')
    await waitUntil(
      async () => (await app.page.locator('[data-outbound-target="丁"]').count()) === 1,
      15_000,
      '甲 的出链里出现丁',
    )
    expect(existsSync(vault.absolute('笔记/丁.md'))).toBe(false)

    await app.page.locator('[data-outbound-target="丁"]').click()
    await waitUntil(() => Promise.resolve(existsSync(vault.absolute('笔记/丁.md'))), 15_000, '丁.md 被创建')
    await waitUntil(
      async () => ((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes('笔记/丁.md'),
      15_000,
      '创建后自动打开丁',
    )
    // 新笔记里应写入标题
    const created = await vault.read('笔记/丁.md')
    expect(created).toContain('丁')
  })
})

describe.skipIf(!supported)('真实应用：编辑与保存（真实磁盘）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      [NOTE_MAIN]: '# 你好\n\n这是 E2E 用的笔记。\n',
      [NOTE_CONFLICT]: '# 冲突测试\n\n初始内容。\n',
      'notes/to-delete.md': '# 待删除\n\n这篇会被移入回收站。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('打开笔记 → 编辑器载入磁盘内容 → 输入 → 自动保存写回磁盘', async () => {
    await app.page.locator(`.mn-tree [data-rel-path="${NOTE_MAIN}"]`).click()
    await app.page.waitForSelector('.cm-content', { state: 'visible', timeout: 15_000 })

    await waitUntil(
      async () =>
        ((await app.page.locator('.cm-content').textContent()) ?? '').includes('这是 E2E 用的笔记'),
      15_000,
      '编辑器载入笔记内容',
    )

    const marker = `E2E-标记-${Date.now()}`
    await app.page.locator('.cm-content').click()
    await app.page.keyboard.press('Control+End')
    await app.page.keyboard.type(`\n${marker}\n`)

    // 防抖 600ms + 原子写落盘
    const content = await waitForFileContent(vault, NOTE_MAIN, (text) => text.includes(marker), 20_000)
    expect(content).toContain('这是 E2E 用的笔记')
    expect(content).toContain(marker)

    // 状态栏应显示"已保存"
    await waitUntil(
      async () => ((await app.page.locator('.mn-statusbar').textContent()) ?? '').includes('已保存'),
      8_000,
      '状态栏显示已保存',
    )
  })

  it('文件被外部修改 → 冲突横幅 → 不覆盖磁盘 → 重新加载恢复', async () => {
    await app.page.locator(`.mn-tree [data-rel-path="${NOTE_CONFLICT}"]`).click()
    await app.page.waitForSelector('.cm-content', { state: 'visible', timeout: 15_000 })
    await waitUntil(
      async () => ((await app.page.locator('.cm-content').textContent()) ?? '').includes('初始内容'),
      15_000,
      '编辑器载入冲突测试笔记',
    )

    // 外部程序改写（间隔一点时间，保证 mtime 令牌一定变化）
    await delay(60)
    await vault.write(NOTE_CONFLICT, '# 冲突测试\n\n外部版本。\n')
    await delay(60)

    // 在编辑器里输入 → 自动保存 → 应检测到冲突而不是覆盖
    await app.page.locator('.cm-content').click()
    await app.page.keyboard.press('Control+End')
    await app.page.keyboard.type('\n我的改动\n')

    await app.page.waitForSelector('.mn-conflict', { state: 'visible', timeout: 15_000 })
    const banner = (await app.page.locator('.mn-conflict').textContent()) ?? ''
    expect(banner).toContain('已被外部修改')

    // 关键安全断言：磁盘上仍是外部版本，我的改动没有被写进去
    await delay(1_000)
    const onDisk = await vault.read(NOTE_CONFLICT)
    expect(onDisk).toContain('外部版本')
    expect(onDisk).not.toContain('我的改动')

    // 选择"丢弃我的修改并重新加载"
    await app.page.getByText('丢弃我的修改并重新加载').click()
    await waitUntil(
      async () => ((await app.page.locator('.cm-content').textContent()) ?? '').includes('外部版本'),
      15_000,
      '编辑器恢复为磁盘内容',
    )
    expect(await app.page.locator('.mn-conflict').count()).toBe(0)
  })

  it('删除到回收站：需要二次确认，文件真的进 .mimenote/trash', async () => {
    const target = 'notes/to-delete.md'
    const absolute = vault.absolute(target)
    expect(existsSync(absolute)).toBe(true)

    // 选中该笔记（顺带验证点开后编辑器载入）
    await app.page.locator(`.mn-tree [data-rel-path="${target}"]`).click()
    await app.page.waitForSelector('.cm-content', { state: 'visible', timeout: 15_000 })

    // 在文件树上按 Delete → 出现二次确认
    await app.page.locator('.mn-tree').focus()
    await app.page.keyboard.press('Delete')
    await app.page.waitForSelector('.mn-dialog', { state: 'visible', timeout: 10_000 })
    const dialogText = (await app.page.locator('.mn-dialog').textContent()) ?? ''
    expect(dialogText).toContain('移入回收站')
    expect(dialogText).toContain('.mimenote/trash')

    await app.page.locator('.mn-dialog button', { hasText: '移入回收站' }).click()

    // 原位置消失、树里的行消失
    await waitUntil(async () => !existsSync(absolute), 10_000, '原文件被移走')
    await waitUntil(
      async () => (await app.page.locator(`.mn-tree [data-rel-path="${target}"]`).count()) === 0,
      10_000,
      '文件树中的行消失',
    )

    // 回收站里有它，且有台账
    const trashDir = vault.absolute('.mimenote/trash')
    expect(existsSync(trashDir)).toBe(true)
    const trashed = readdirSync(trashDir).filter((name) => name.endsWith('__to-delete.md'))
    expect(trashed.length).toBe(1)
    const index = await vault.read('.mimenote/index.jsonl')
    expect(index).toContain('notes/to-delete.md')
  })
})

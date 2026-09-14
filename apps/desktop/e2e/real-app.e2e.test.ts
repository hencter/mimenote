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
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

/**
 * M3 的三块新功能：所见即所得编辑、知识图谱、设置页 —— 真实二进制 + 真实 IPC。
 *
 * 这一层能抓到单元测试抓不到的东西：装饰在真实 WebView 里是否真的生效、图谱的
 * `graph_data` 真实往返是否返回了卡片、设置页是否真的能打开并改到东西。
 */
describe.skipIf(!supported)('真实应用：所见即所得 / 知识图谱 / 设置（M3）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      '甲.md': '# 甲\n\n这是**粗体**与 `代码`，还有 [[乙]]。\n',
      '乙.md': '# 乙\n\n指向 [[甲]] 与 [[还不存在的丙]]。\n',
      '子/丙.md': '# 丙\n\n正文。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('所见即所得：标题与行内标记在编辑器里被渲染，光标进入该行才露出原文', async () => {
    await openNoteInTree(app.page, '甲.md')
    await app.page.waitForSelector('.cm-content', { state: 'visible' })

    // 标题行：live preview 会给行加 `mn-md-h1` 一类的类名（不再是裸 `# 甲`）
    await waitUntil(
      async () => (await app.page.locator('.cm-line.mn-md-h1').count()) >= 1,
      10_000,
      '标题行被装饰',
    )
    // `**粗体**` 的标记被隐藏（视觉上只留"粗体"），但光标不在那一行时原文仍在 doc 里
    await waitUntil(
      async () => (await app.page.locator('.mn-md-strong').count()) >= 1,
      10_000,
      '粗体被装饰',
    )
    // 把光标放进标题行 → 露出 `#`
    await app.page.locator('.cm-line.mn-md-h1').first().click()
    await waitUntil(
      async () =>
        ((await app.page.locator('.cm-content').textContent()) ?? '').includes('# 甲'),
      10_000,
      '光标进入标题行后露出原文',
    )
  })

  it('知识图谱：真实 graph_data 渲染卡片、文件夹成组、点卡片就地预览', async () => {
    await app.page.keyboard.press('Control+g')
    await app.page.waitForSelector('.mn-graph', { state: 'visible' })
    await waitUntil(
      async () => (await app.page.locator('.mn-graph-card').count()) >= 3,
      15_000,
      '图谱渲染出卡片',
    )
    await app.page.waitForSelector('.mn-graph-card[data-rel-path="甲.md"]', { state: 'visible' })
    // 子目录自动成组
    await app.page.waitForSelector('.mn-graph-folder[data-folder="子"]', { state: 'visible' })

    // 悬空链接的目标名字直接标出来（toRawTarget）
    await waitUntil(
      async () =>
        ((await app.page.locator('.mn-graph').textContent()) ?? '').includes('还不存在的丙'),
      15_000,
      '悬空链接标出用户写下的目标名',
    )

    // 单击卡片 → 就地预览正文（不需要按 Ctrl）
    await app.page.locator('.mn-graph-card[data-rel-path="甲.md"]').click()
    await app.page.waitForSelector('.mn-graph-preview', { state: 'visible' })
    await waitUntil(
      async () =>
        ((await app.page.locator('.mn-graph-preview').textContent()) ?? '').includes('粗体'),
      15_000,
      '预览里出现笔记正文',
    )
    // 入链虚线、出链实线（甲 有出链到乙，也有入链来自乙）
    const classes = await app.page
      .locator('.mn-graph-edge--highlight')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('class') ?? ''))
    expect(classes.some((name) => name.includes('mn-graph-edge--dashed'))).toBe(true)
    expect(classes.some((name) => !name.includes('mn-graph-edge--dashed'))).toBe(true)

    await app.page.keyboard.press('Escape')
    await waitUntil(async () => (await app.page.locator('.mn-graph-preview').count()) === 0, 5_000, '预览关闭')
  })

  it('设置页：Ctrl+, 打开、显示版本与 Vault 统计，Esc 关闭', async () => {
    await resetToEditView(app.page)
    await app.page.keyboard.press('Control+,')
    await app.page.waitForSelector('.mn-settings', { state: 'visible', timeout: 10_000 })

    const text = (await app.page.locator('.mn-settings').textContent()) ?? ''
    expect(text).toContain('外观')
    expect(text).toContain('关于')

    await app.page.keyboard.press('Escape')
    await waitUntil(async () => (await app.page.locator('.mn-settings').count()) === 0, 5_000, '设置页关闭')
  })

  it('应用菜单：标题栏菜单列出命令并可直接执行', async () => {
    await app.page.locator('button[aria-label="应用菜单"]').click()
    await app.page.waitForSelector('[role="menu"]', { state: 'visible', timeout: 5_000 })
    const items = await app.page.locator('[role="menuitem"]').allTextContents()
    expect(items.length).toBeGreaterThan(5)
    // 点"知识图谱"那条命令 → 切到图谱视图
    await app.page.locator('[role="menuitem"]', { hasText: '视图：知识图谱' }).click()
    await app.page.waitForSelector('.mn-graph', { state: 'visible', timeout: 5_000 })
  })
})

/** 打开某篇笔记（自足：不依赖上一条用例留下的树/面板/视图状态）。 */
async function openNoteInTree(page: Page, relPath: string): Promise<void> {
  // 上一个用例可能把视图留在"阅读"里（主区域一次只渲染一个 pane），先回到编辑视图
  await resetToEditView(page)
  await ensureTreeRow(page, relPath)
  await treeRow(page, relPath).click()
  await waitUntil(
    async () => {
      // 编辑视图有编辑器工具栏；阅读/图谱视图没有 → 用"树里这一行被选中"作为共同信号
      if ((await page.locator('.mn-editor__path').count()) > 0) {
        return ((await page.locator('.mn-editor__path').textContent()) ?? '').includes(relPath)
      }
      const rowClass = (await treeRow(page, relPath).getAttribute('class')) ?? ''
      return rowClass.includes('mn-tree-row--selected')
    },
    15_000,
    `打开 ${relPath}`,
  )
}

/** 切到"阅读"（渲染后）视图：默认是所见即所得编辑，分栏已移除（ADR-0009）。 */
async function showReadView(page: Page): Promise<void> {
  await page.locator('button[aria-label="阅读（渲染后）"]').click()
  await page.waitForSelector('.mn-preview__body', { state: 'visible', timeout: 10_000 })
}

/**
 * 每个用例都从"编辑"视图开始（阅读视图的断言会把视图切走，
 * 而主区域一次只渲染一个 pane —— 不重置后面的用例就找不到编辑器）。
 */
async function resetToEditView(page: Page): Promise<void> {
  const editButton = page.locator('button[aria-label="编辑（所见即所得）"]')
  if ((await editButton.count()) > 0) await editButton.click()
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

/**
 * 本地图片渲染（M2，ADR-0007）：真实二进制 + 真实磁盘 + 真实 asset 协议。
 *
 * 这是唯一能证明"图片真的被解码出来"的层：断言 `naturalWidth > 0`（占位元素没有这个属性，
 * 裂图的 naturalWidth 是 0）。同时验证安全边界：越界引用与**符号链接逃逸**都必须留在占位态。
 */
describe.skipIf(!supported)('真实应用：本地图片（asset 协议逐文件授权）', () => {
  let app: LaunchedApp
  let vault: TempVault

  // 1×1 的透明 PNG（真实字节，能被 WebView2 解码）
  const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  )

  /** 等预览里出现一张**真的解码成功**的图片。 */
  async function waitForLoadedImage(): Promise<number> {
    let width = 0
    await waitUntil(
      async () => {
        width = await app.page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>(
            '.mn-preview__body img.mn-image',
          )
          return image?.naturalWidth ?? 0
        })
        return width > 0
      },
      20_000,
      '预览里的图片被真实解码',
    )
    return width
  }

  beforeAll(async () => {
    vault = await createTempVault({
      '笔记/图片.md': [
        '# 图片',
        '',
        '正常引用：',
        '',
        '![图](../附件/图.png)',
        '',
        '越界引用（不该渲染）：',
        '',
        '![越界](../../外部.png)',
        '',
        '符号链接引用（不该渲染）：',
        '',
        '![链接](链接.png)',
        '',
      ].join('\n'),
    })

    // 真实图片（Vault 内）
    await mkdir(vault.absolute('附件'), { recursive: true })
    await writeFile(vault.absolute('附件/图.png'), ONE_PIXEL_PNG)
    // Vault 外的图片：越界引用即使指向真实存在的文件也不该被读到
    await writeFile(join(dirname(vault.path), `外部-${basename(vault.path)}.png`), ONE_PIXEL_PNG)
    // Vault 内指向外部的符号链接：前端看不出区别，**只有宿主的 path_guard 能拦**
    try {
      await symlink(
        join(dirname(vault.path), `外部-${basename(vault.path)}.png`),
        vault.absolute('链接.png'),
        'file',
      )
    } catch (cause) {
      // Windows 上创建符号链接需要开发者模式/管理员权限：拿不到就只跳过这一条断言
      console.warn('[e2e] 无法创建符号链接，跳过该项断言：', cause)
    }

    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) {
      await rm(join(dirname(vault.path), `外部-${basename(vault.path)}.png`), { force: true }).catch(
        () => undefined,
      )
      await vault.cleanup()
    }
  })

  it('Vault 内的图片被真实渲染（而不是占位元素）', async () => {
    await openNoteInTree(app.page, '笔记/图片.md')
    await showReadView(app.page)

    const width = await waitForLoadedImage()
    expect(width).toBeGreaterThan(0)

    // 相对路径被解析成了 Vault 内的绝对路径（asset URL 里带着它）
    const src = await app.page.evaluate(
      () => document.querySelector<HTMLImageElement>('.mn-preview__body img.mn-image')?.src ?? '',
    )
    expect(src.toLowerCase()).toContain('asset')
    expect(decodeURIComponent(src)).toContain('图.png')

    // 越界与符号链接那两张仍然是占位元素（没有被授权）
    const images = await app.page.locator('.mn-preview__body img.mn-image').count()
    expect(images).toBe(1)
    const placeholders = await app.page.locator('.mn-preview__body .mn-image-placeholder').count()
    expect(placeholders).toBeGreaterThanOrEqual(1)
  })

  it('编辑器（所见即所得）里的图片也能点开放大 —— 这是默认视图', async () => {
    await openNoteInTree(app.page, '笔记/图片.md')
    // 默认就是编辑视图；把光标放到文档开头，图片所在行不在光标处 ⇒ 渲染成图片 widget
    const editorImage = app.page.locator('.cm-content img.mn-md-image')
    await waitUntil(async () => (await editorImage.count()) === 1, 15_000, '编辑器里渲染出图片 widget')

    await editorImage.click()
    await app.page.waitForSelector('.mn-lightbox', { state: 'visible', timeout: 5_000 })
    // 真的显示的是这张图（灯箱里的大图已被解码）
    const decoded = await app.page.evaluate(
      () => document.querySelector<HTMLImageElement>('.mn-lightbox__image')?.naturalWidth ?? 0,
    )
    expect(decoded).toBeGreaterThan(0)

    await app.page.keyboard.press('Escape')
    await waitUntil(
      async () => (await app.page.locator('.mn-lightbox').count()) === 0,
      5_000,
      'Esc 关闭灯箱',
    )
    // 关掉之后编辑器里的图片还在（放大不改文档）
    expect(await editorImage.count()).toBe(1)
  })
})

/**
 * 标签与属性面板（M2）：真实 IPC（`note_tags` / `tags_list` / `tag_notes`）+ 真实磁盘。
 *
 * Mock 层的抽取规则由 `tests/tags.test.tsx` 覆盖，这里验证"合起来在真实二进制里成立"：
 * 标签索引是否真的在保存/打开后建立、点标签能否列出笔记、以及**预览不再渲染 frontmatter**。
 */
describe.skipIf(!supported)('真实应用：标签与属性面板（真实 IPC）', () => {
  let app: LaunchedApp
  let vault: TempVault

  beforeAll(async () => {
    vault = await createTempVault({
      // 注意 `#标签` 前面必须是**空白或行首**（与 Obsidian 同口径）：`段落。#架构` 里的
      // `#` 前面是全角句号，按规则不算标签 —— 用例里刻意留了空格
      '项目/设计.md': '---\ntitle: 设计\ntags: [项目, 进行中]\n---\n\n正文段落。 #架构 与 #项目。\n',
      '项目/路线图.md': '# 路线图\n\n标签： #项目\n',
      '随手记.md': '# 随手记\n\n这一篇没有标签。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('面板显示 frontmatter 与行内标签、属性表，预览不再渲染 frontmatter', async () => {
    await openNoteInTree(app.page, '项目/设计.md')
    await showReadView(app.page)

    // 预览只渲染正文：frontmatter 的键值不应该出现在预览里
    await waitUntil(
      async () => ((await app.page.locator('.mn-preview__body').textContent()) ?? '').includes('正文段落'),
      15_000,
      '预览渲染正文',
    )
    const preview = (await app.page.locator('.mn-preview__body').textContent()) ?? ''
    expect(preview).not.toContain('title')
    expect(preview).not.toContain('进行中')

    await app.page.keyboard.press('Control+Shift+T')
    await app.page.waitForSelector('.mn-tags', { state: 'visible', timeout: 10_000 })

    // frontmatter 的 tags（数组）与正文行内的 #标签 都要出现（按去重后的键，保留首次写法）
    for (const tag of ['项目', '进行中', '架构']) {
      await waitUntil(
        async () => (await app.page.locator(`.mn-tags [data-tag="${tag}"]`).count()) === 1,
        15_000,
        `标签 ${tag} 出现在面板里`,
      )
    }
    // 属性表显示 frontmatter 字段
    const panelText = (await app.page.locator('.mn-tags').textContent()) ?? ''
    expect(panelText).toContain('title')
    expect(panelText).toContain('设计')
  })

  it('全文搜索（真实 FTS5）：搜到命中 → 回车打开那一篇', async () => {
    // 上一条用例把视图留在"阅读"里：先回到编辑视图（回车打开后要断言编辑器路径）
    await resetToEditView(app.page)
    // 索引在 vault_open 之后后台构建，小 Vault 很快就好；这里等结果出现即可
    await app.page.keyboard.press('Control+Shift+F')
    await app.page.waitForSelector('.mn-palette', { state: 'visible', timeout: 10_000 })
    expect(await app.page.locator('.mn-palette').getAttribute('aria-label')).toBe('全文搜索')

    await app.page.locator('.mn-palette__input').fill('正文段落')
    await waitUntil(
      async () =>
        (await app.page
          .locator('.mn-palette [role="option"][data-rel-path="项目/设计.md"]')
          .count()) === 1,
      25_000,
      '真实索引返回命中',
    )
    const text =
      (await app.page
        .locator('.mn-palette [role="option"][data-rel-path="项目/设计.md"]')
        .textContent()) ?? ''
    expect(text).toContain('正文段落')
    // 结果行里有行号（`行: 片段` 的形态）
    expect(text).toMatch(/\d/)

    await app.page.locator('.mn-palette__input').press('Enter')
    await waitUntil(
      async () =>
        ((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/设计.md'),
      15_000,
      '回车打开命中的笔记',
    )
    expect(await app.page.locator('.mn-palette').count()).toBe(0)
  })

  it('点标签 → 列出含它的笔记 → 点笔记打开它；再按快捷键收起面板', async () => {
    await resetToEditView(app.page)
    await app.page.locator('.mn-tags [data-tag="项目"]').click()
    await waitUntil(
      async () => (await app.page.locator('.mn-tags [data-tag-note]').count()) === 2,
      15_000,
      '该标签下有两篇笔记',
    )
    const paths = await app.page
      .locator('.mn-tags [data-tag-note]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tag-note')))
    expect(paths).toContain('项目/设计.md')
    expect(paths).toContain('项目/路线图.md')

    await app.page.locator('.mn-tags [data-tag-note="项目/路线图.md"]').click()
    await waitUntil(
      async () =>
        ((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes('项目/路线图.md'),
      15_000,
      '点击后打开了路线图',
    )

    await app.page.keyboard.press('Control+Shift+T')
    await waitUntil(async () => (await app.page.locator('.mn-tags').count()) === 0, 10_000, '面板收起')
  })
})

/**
 * 重命名 + 全库链接改写（M2）。
 *
 * 这一条**只信磁盘**：断言的是被改写文件的真实字节 —— 精确 span 改写（不改错相邻的同前缀链接）、
 * 跨目录相对路径、别名与锚点保留、代码块/行内代码不被动、CRLF 保真。
 * Mock 适配器与 Rust 单测都覆盖了各自的那一半，这里验证"合起来在真实二进制里成立"。
 */
describe.skipIf(!supported)('真实应用：重命名与全库链接改写（真实磁盘）', () => {
  let app: LaunchedApp
  let vault: TempVault

  const OLD = 'notes/beta.md'
  const NEW = 'notes/beta-renamed.md'
  const NEW_TITLE = 'beta-renamed'

  beforeAll(async () => {
    vault = await createTempVault({
      'README.md': '# 欢迎\n',
      [OLD]: '# Beta\n\n正文。\n',
      // 同目录：裸名 wikilink + 带 `.md` 的 Markdown 链接
      'notes/alpha.md': '# Alpha\n\n见 [[beta]] 与 [带扩展名](beta.md)。\n',
      // 前缀陷阱：`[[beta-extra]]` 指向另一篇，绝不能被误改
      'notes/beta-extra.md': '# Beta extra\n\n另一篇。\n',
      'notes/prefix.md': '# 前缀陷阱\n\n[[beta]] 与 [[beta-extra]] 同时出现。\n',
      // 跨目录：相对路径 + 锚点 + 别名
      'other/gamma.md': '# Gamma\n\n跨目录引用 [[../notes/beta#小节|贝塔]]。\n',
      // 代码块与行内代码里的链接不参与改写
      'notes/code.md': '# 代码\n\n```\n[[beta]]\n```\n\n行内 `[[beta]]` 也不算。\n',
      // 换行保真：CRLF 文件被改写后必须仍是 CRLF
      'notes/crlf.md': '# CRLF\r\n\r\n链接 [[beta]] 保持换行。\r\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('F2 改名后：文件名变了、全库链接精确改写、代码块与换行不受影响', async () => {
    await openNoteInTree(app.page, OLD)

    await app.page.locator('.mn-tree').focus()
    await app.page.keyboard.press('F2')
    await app.page.waitForSelector('.mn-dialog--rename', { state: 'visible', timeout: 10_000 })
    expect(await app.page.getByLabel('新文件名').inputValue()).toBe('beta')

    await app.page.getByLabel('新文件名').fill(NEW_TITLE)
    await app.page.getByLabel('新文件名').press('Enter')

    // 文件真的改名了（真实磁盘）
    await waitUntil(() => Promise.resolve(existsSync(vault.absolute(NEW))), 15_000, '新文件名出现在磁盘上')
    expect(existsSync(vault.absolute(OLD))).toBe(false)

    // 正在编辑的笔记原地跟到新路径（内容不变）
    await waitUntil(
      async () =>
        ((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes(NEW),
      15_000,
      '编辑器切到新路径',
    )
    expect(await app.page.locator(`.mn-tree [data-rel-path="${NEW}"]`).count()).toBe(1)
    expect(await app.page.locator(`.mn-tree [data-rel-path="${OLD}"]`).count()).toBe(0)

    // 同目录裸名链接 → 新裸名；Markdown 链接保留 `.md`
    const alpha = await vault.read('notes/alpha.md')
    expect(alpha).toContain('[[beta-renamed]]')
    expect(alpha).toContain('[带扩展名](beta-renamed.md)')
    expect(alpha).not.toContain('[[beta]]')

    // 前缀陷阱：只改真正指向 beta 的那一条
    const prefix = await vault.read('notes/prefix.md')
    expect(prefix).toContain('[[beta-renamed]]')
    expect(prefix).toContain('[[beta-extra]]')

    // 跨目录：相对路径 + 锚点 + 别名都保留
    const gamma = await vault.read('other/gamma.md')
    expect(gamma).toContain('[[../notes/beta-renamed#小节|贝塔]]')

    // 代码块与行内代码里的 `[[beta]]` 一个字都不能动
    const code = await vault.read('notes/code.md')
    expect(code).toContain('```\n[[beta]]\n```')
    expect(code).toContain('`[[beta]]`')
    expect(code).not.toContain('beta-renamed')

    // 换行保真：仍然是 CRLF，没有被"顺手"改成 LF
    const crlf = await vault.read('notes/crlf.md')
    expect(crlf).toContain('[[beta-renamed]]')
    expect(crlf).toContain('\r\n')
    expect(/[^\r]\n/.test(crlf)).toBe(false)
  })

  it('索引同步：改写后的链接立刻能解析（不必重扫 Vault）', async () => {
    await openNoteInTree(app.page, 'notes/alpha.md')
    await showReadView(app.page)
    // 阅读视图里的 wikilink 应解析到新文件（没有未解析标记）
    await waitUntil(
      async () =>
        (await app.page.locator('.mn-preview__body a.mn-wikilink').count()) >= 1,
      15_000,
      '预览里出现 wikilink',
    )
    await waitUntil(
      async () => (await app.page.locator('a.mn-wikilink--unresolved').count()) === 0,
      15_000,
      'wikilink 全部解析成功',
    )

    // 反向链接面板：新名字的笔记应看到来源 notes/alpha.md
    await openNoteInTree(app.page, NEW)
    await ensureLinksPanel(app.page)
    await waitUntil(
      async () =>
        (await app.page.locator('.mn-links__item-name').allTextContents()).includes('alpha.md'),
      15_000,
      '新笔记的反向链接里出现来源笔记',
    )
  })
})

/**
 * 全文搜索跳转（真实 FTS5 + 真实编辑器 + 真实布局）。
 *
 * 为什么必须在这一层验：命中行号由宿主给出、光标与视口由编辑器给出，而"滚动到视口中间"
 * 是**像素事实** —— jsdom 没有布局（高度恒为 0），Mock 层也测不出"到底滚到哪儿了"。
 * 所以断言全部落在真实 WebView 里可观察的现象上：`.cm-activeLine` 的内容、
 * 那一行在滚动容器里的相对位置、滚动条真的动过、焦点真的在编辑器里。
 */
describe.skipIf(!supported)('真实应用：搜索命中跳转（真实 FTS5）', () => {
  let app: LaunchedApp
  let vault: TempVault

  const NOTE = '长文.md'
  /** 命中行刻意放在文档深处：不滚动的话它根本不在视口里。 */
  const HIT_LINE = 90
  const MARKER = '海市蜃楼标记'

  /** 140 行的普通正文，只有第 {@link HIT_LINE} 行含关键词。 */
  function longNote(): string {
    const lines = Array.from(
      { length: 140 },
      (_, index) => `第 ${index + 1} 行：撑高文档用的普通段落。`,
    )
    lines[HIT_LINE - 1] = `第 ${HIT_LINE} 行：${MARKER}。`
    return `${lines.join('\n')}\n`
  }

  beforeAll(async () => {
    vault = await createTempVault({ [NOTE]: longNote() })
    app = await launchApp({ vaultPath: vault.path })
    // 用例从"什么都没有打开"的干净页面开始：编辑器要在跳转时才被挂载
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('回车打开命中笔记，光标与视口落在命中行（而不是文档开头，也不贴边）', async () => {
    await resetToEditView(app.page)
    await app.page.keyboard.press('Control+Shift+F')
    await app.page.waitForSelector('.mn-palette', { state: 'visible', timeout: 10_000 })
    await app.page.locator('.mn-palette__input').fill(MARKER)

    const option = app.page.locator(`.mn-palette [role="option"][data-rel-path="${NOTE}"]`)
    await waitUntil(async () => (await option.count()) === 1, 25_000, '真实 FTS5 返回命中')
    // 结果行里的行号就是宿主给的那一行
    expect(await option.getAttribute('data-line')).toBe(String(HIT_LINE))
    expect((await option.textContent()) ?? '').toContain(MARKER)

    await app.page.locator('.mn-palette__input').press('Enter')

    // 跳转在"新文档进了编辑器"之后才落地（下一帧），所以这里轮询到条件成立为止
    await waitUntil(
      async () => {
        const probe = await app.page.evaluate(() => {
          const line = document.querySelector('.cm-activeLine')
          const scroller = document.querySelector('.cm-scroller')
          if (line === null || scroller === null) return null
          const lineRect = line.getBoundingClientRect()
          const scrollerRect = scroller.getBoundingClientRect()
          return {
            text: line.textContent ?? '',
            offsetInViewport: lineRect.top - scrollerRect.top,
            viewportHeight: scrollerRect.height,
            scrollTop: scroller.scrollTop,
            focusedInEditor:
              document.activeElement !== null && document.activeElement.closest('.cm-editor') !== null,
          }
        })
        if (probe === null) return false
        return (
          probe.text.includes(MARKER) &&
          probe.scrollTop > 0 &&
          probe.offsetInViewport > probe.viewportHeight * 0.2 &&
          probe.offsetInViewport < probe.viewportHeight * 0.8 &&
          probe.focusedInEditor
        )
      },
      15_000,
      '命中行成为光标所在行、被滚到视口中部、且焦点在编辑器里',
    )

    // 打开的是命中那一篇
    expect(((await app.page.locator('.mn-editor__path').textContent()) ?? '').includes(NOTE)).toBe(
      true,
    )
    // 跳转只是"看"：磁盘上一个字节都没变（没有为了定位往正文里插标记）
    expect(await vault.read(NOTE)).toBe(longNote())
  })
})

/**
 * `[[` 笔记自动补全（真实编辑器 + 真实磁盘）。
 *
 * 为什么必须在这一层验：补全的"最后一公里"是**写进文件的那一串字符**。jsdom 里能断言
 * 弹层与插入的文本，但"按一次确认到底往磁盘上写了几个 `]]`"只有真实二进制 + 真实磁盘能证明；
 * 另外"焦点离开编辑器后弹层自动关闭"依赖真实 DOM 焦点，jsdom 复现不可靠。
 */
describe.skipIf(!supported)('真实应用：[[ 笔记自动补全（真实磁盘）', () => {
  let app: LaunchedApp
  let vault: TempVault

  const MAIN = '甲.md'
  const TARGET = '乙.md'

  beforeAll(async () => {
    vault = await createTempVault({
      [MAIN]: '# 甲\n\n正文一段。\n',
      [TARGET]: '# 乙\n\n目标笔记。\n',
    })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('输入 [[ 弹出候选，回车补全并把链接写进磁盘（只写一个 ]]）', async () => {
    await openNoteInTree(app.page, MAIN)
    await app.page.locator('.cm-content').click()

    await app.page.keyboard.type('[[')
    await app.page.waitForSelector('.mn-wiki-complete [role="option"]', {
      state: 'visible',
      timeout: 10_000,
    })
    // 恰好一个选项是"当前高亮"（ARIA 的硬要求，也保证 Enter 有明确目标）
    await waitUntil(
      async () =>
        (await app.page.locator('.mn-wiki-complete [role="option"][aria-selected="true"]').count()) ===
        1,
      10_000,
      '恰好一个高亮候选',
    )

    // 继续输入即过滤到目标那一篇
    await app.page.keyboard.type('乙')
    await waitUntil(
      async () => (await app.page.locator('.mn-wiki-complete [role="option"]').count()) === 1,
      10_000,
      '过滤到唯一候选',
    )

    await app.page.keyboard.press('Enter')
    await waitUntil(
      async () => ((await app.page.locator('.cm-content').textContent()) ?? '').includes('[[乙]]'),
      10_000,
      '编辑器里出现补全后的链接',
    )

    // 真磁盘：链接只写了一遍，且 `]]` 只有一个（补全最容易出的错就是多写一个 `]]`）
    await waitForFileContent(vault, MAIN, (text) => text.includes('[[乙]]'))
    const written = await vault.read(MAIN)
    expect(written.match(/\[\[乙\]\]/gu)?.length).toBe(1)
    expect(written.match(/\]\]/gu)?.length).toBe(1)
  })

  it('Esc 取消不改文档；点文件树让焦点离开编辑器后弹层自动关闭', async () => {
    const before = await vault.read(MAIN)

    await app.page.locator('.cm-content').click()
    await app.page.keyboard.press('Control+End')
    await app.page.keyboard.type('\n[[')
    await app.page.waitForSelector('.mn-wiki-complete', { state: 'visible', timeout: 10_000 })

    await app.page.keyboard.press('Escape')
    await waitUntil(
      async () => (await app.page.locator('.mn-wiki-complete').count()) === 0,
      5_000,
      'Esc 关闭弹层',
    )

    // 关掉弹层后 Enter 回到"普通换行"的既有语义（弹层关着时它一律不接管按键）
    await app.page.keyboard.press('Enter')
    await app.page.keyboard.type('普通一行')
    await waitUntil(
      async () => ((await vault.read(MAIN)) ?? '').includes('普通一行'),
      10_000,
      '弹层关闭后输入照旧落盘',
    )
    expect(await vault.read(MAIN)).not.toBe(before)

    // 焦点离开编辑器 → 弹层必须自己收起（否则它会留在屏幕上骗人）
    await app.page.locator('.cm-content').click()
    await app.page.keyboard.press('Control+End')
    await app.page.keyboard.type('\n[[')
    await app.page.waitForSelector('.mn-wiki-complete', { state: 'visible', timeout: 10_000 })
    await treeRow(app.page, TARGET).click()
    await waitUntil(
      async () => (await app.page.locator('.mn-wiki-complete').count()) === 0,
      5_000,
      '焦点离开编辑器后弹层关闭',
    )
  })
})

/**
 * 标签面板**增删标签**（真实二进制 + 真实磁盘）。
 *
 * 为什么必须在这一层验：面板上点一下，改的是磁盘上**哪一行**、以及"其余内容是否逐字不变"，
 * 只有真实宿主 + 真实文件系统能证明 —— Mock 适配器里的 frontmatter 改写是简化镜像。
 * 这里用 CRLF + 行尾注释 + 一个未知键（`draft`）来钉住保真：加一个标签之后，
 * 磁盘内容必须**恰好**等于原文把 `[甲]` 换成 `[甲, 乙]`，一个字节都不能多。
 * 用例起点自足：先加再删，跑完回到原始磁盘内容。
 */
describe.skipIf(!supported)('真实应用：标签面板增删标签（真实磁盘）', () => {
  let app: LaunchedApp
  let vault: TempVault

  const NOTE = '标签.md'
  /** CRLF、行尾注释、未知键、正文行内标签：一篇文章里把几种保真点都放上。 */
  const BEFORE =
    '---\r\ntitle: 标签示例\r\ntags: [甲]\r\ndraft: false # 未完成\r\n---\r\n# 标题\r\n\r\n正文里的 #行内 标签。\r\n'
  const AFTER = BEFORE.replace('tags: [甲]', 'tags: [甲, 乙]')

  beforeAll(async () => {
    vault = await createTempVault({ [NOTE]: BEFORE })
    app = await launchApp({ vaultPath: vault.path })
    await app.page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
    if (vault !== undefined) await vault.cleanup()
  })

  it('加标签 → 磁盘上真的多了一项（其余逐字不变）→ 面板与全库标签跟着更新 → 删掉恢复原样', async () => {
    await openNoteInTree(app.page, NOTE)
    await app.page.keyboard.press('Control+Shift+t')
    await app.page.waitForSelector('.mn-tags', { state: 'visible', timeout: 10_000 })
    await waitUntil(
      async () => (await app.page.locator(`.mn-tags [data-tag="甲"]`).count()) === 1,
      10_000,
      '面板显示 frontmatter 标签',
    )
    // 正文里的 `#行内` 只读：必须带来源角标（真实 DOM 里也要标出来，不能只在测试替身里标）
    await waitUntil(
      async () => (await app.page.locator('.mn-tags [data-tag="行内"][data-tag-source="inline"]').count()) === 1,
      10_000,
      '行内标签带「正文」来源',
    )

    // 输入框里回车提交（隐式的表单提交是浏览器行为，jsdom 里验不了）
    const input = app.page.getByLabel('添加标签')
    await input.fill('乙')
    await input.press('Enter')

    await waitForFileContent(vault, NOTE, (text) => text.includes('tags: [甲, 乙]'))
    // 逐字比对：CRLF、行尾注释、未知键与正文都必须原样（只多了 `, 乙`）
    expect(await vault.read(NOTE)).toBe(AFTER)

    // 面板与全库标签立刻跟着更新（索引是增量同步的，不需要重扫）
    await waitUntil(
      async () => (await app.page.locator('.mn-tags [data-tag="乙"]').count()) === 1,
      10_000,
      '本篇标签出现 乙',
    )
    await waitUntil(
      async () => (await app.page.locator('.mn-tags [data-tag-key="乙"]').count()) === 1,
      10_000,
      '全库标签概览出现 乙',
    )
    // 编辑器里的文本必须与磁盘一致，否则下一次自动保存会把刚写的标签覆盖掉
    await waitUntil(
      async () => ((await app.page.locator('.cm-content').textContent()) ?? '').includes('tags: [甲, 乙]'),
      10_000,
      '编辑器文本与磁盘对齐',
    )

    // 再删掉：磁盘逐字节回到原样，面板上也消失
    await app.page.locator('.mn-tags [data-tag-remove="乙"]').click()
    await waitForFileContent(vault, NOTE, (text) => !text.includes('乙'))
    expect(await vault.read(NOTE)).toBe(BEFORE)
    await waitUntil(
      async () => (await app.page.locator('.mn-tags [data-tag="乙"]').count()) === 0,
      10_000,
      '面板上 乙 消失',
    )
    // 行内那个标签从头到尾没被碰过（面板只改 frontmatter）
    expect(await vault.read(NOTE)).toContain('正文里的 #行内 标签。')
  }, 90_000)
})


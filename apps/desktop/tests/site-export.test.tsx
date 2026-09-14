// @vitest-environment jsdom
/**
 * 整库导出静态站点（ADR-0019）的端到端链路测试（jsdom + Mock 适配器 + 桩掉系统目录选择框）。
 *
 * 断言的重心是**产出的那些字符串**与**写出去的那些路径**：整库导出的可验证交付就是
 * "一个能直接打开、链接能点、图片在的目录"。所以这里逐条钉住：
 *
 * 1. 页面是一份完整 HTML，正文里 frontmatter 不进正文、标题来自计划（与图谱卡片同口径）；
 * 2. `[[双链]]` 变成**指向另一份 HTML 的相对链接**，悬空的变成不可点的文字（不是死链）；
 * 3. 图片引用的是 `assets/…` 的相对地址，**绝不内嵌 `data:`**（那是单篇导出的做法）；
 * 4. 共享样式表被写出来、每页按自身深度引用它（目录形态允许引一份样式表）；
 * 5. 索引页列出每一篇、以及需要让人知道的问题（悬空链接、没导出的、撞名的、上次残留的）；
 * 6. **同一个 Vault 导出两次逐字节相同**（页面里不含时间戳）—— 这是同步盘用户的硬需求；
 * 7. 取消：**不写索引页与标记文件**（目录里不会有任何"自称导出一份完整站点"的东西）；
 * 8. 把输出目录选在 Vault 里 → 被拒绝，一个文件都不写。
 *
 * Rust 侧的落盘安全（`..`、ADS、保留设备名、符号链接逃逸、扩展名白名单）由
 * `cargo test -p mimenote` 与真实应用 E2E 覆盖 —— 那一层是宿主的能力边界，jsdom 里没有文件系统。
 */

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setDirectoryPicker } from '@/app/dialogs'
import { openNote } from '@/app/actions'
import { ExportDialog } from '@/features/export/ExportDialog'
import { requestExportKind } from '@/features/export/export-events'
import { exportVaultSite, SITE_EXPORT_BATCH } from '@/features/export/site-export'
import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { MimenoteError } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

const IMAGE_TEXT = 'PNGDATA'

const NOTES = [
  {
    relPath: '笔记/甲.md',
    text: [
      '---',
      'title: 甲的标题',
      '---',
      '',
      '# 正文里的 H1 不该当标题',
      '',
      '指向 [[乙]] 与 [[笔记/丙|丙的别名]] 与 [[还不存在的笔记]]。',
      '',
      '![图](../附件/图.png)',
      '',
    ].join('\n'),
  },
  { relPath: '笔记/乙.md', text: '# 乙\n\n回到 [[甲]]，并跳到 [[甲#小节]]。\n' },
  // 丙 没有链接（索引/反链的用例依赖这一点），但它带着两个 callout：
  // 静态站点是 callout 的第四个渲染面（ADR-0022），结构与颜色都要与阅读视图一致。
  // 刻意**不新增一篇笔记**：这个文件的几条用例逐字断言了"共 N 篇""每篇读一次"这类计数。
  {
    relPath: '笔记/丙.md',
    text: '丙没有任何链接。\n\n> [!warning] 小心\n> 提示框的正文。\n\n> [!摘录]\n> 未知类型。\n',
  },
  { relPath: '附件/图.png', text: IMAGE_TEXT },
]

/** 记录站点相关的 IPC 调用，其余原样转发给 Mock。 */
interface SiteSpy {
  adapter: IpcAdapter
  /** 每次 `export_site_write_pages` 的一批文件（批内顺序有意义，所以按批记）。 */
  batches: Array<Array<{ relPath: string; text: string }>>
  /** 复制过的图片。 */
  copied: string[]
  /** `export_site_plan` 收到的输出目录。 */
  planDirs: Array<string | null>
  /** 每次 `notes_read_batch` 的规模。 */
  readSizes: number[]
}

function spyOnSite(base: MockAdapter, options: { failWrite?: boolean } = {}): SiteSpy {
  const batches: Array<Array<{ relPath: string; text: string }>> = []
  const copied: string[] = []
  const planDirs: Array<string | null> = []
  const readSizes: number[] = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method === 'export_site_plan') {
        planDirs.push((args?.outputDir as string | null | undefined) ?? null)
      }
      if (method === 'notes_read_batch') {
        readSizes.push(((args?.relPaths as string[] | undefined) ?? []).length)
      }
      if (method === 'export_site_write_pages') {
        if (options.failWrite === true) {
          throw new MimenoteError({
            code: 'IO',
            message: '磁盘已满',
            detail: null,
            currentMtimeMs: null,
          })
        }
        batches.push(
          ((args?.files as Array<{ relPath: string; text: string }> | undefined) ?? []).map(
            (file) => ({ relPath: file.relPath, text: file.text }),
          ),
        )
      }
      if (method === 'export_site_copy_assets') {
        for (const item of (args?.assets as Array<{ vaultRelPath: string }> | undefined) ?? []) {
          copied.push(item.vaultRelPath)
        }
      }
      return base.invoke<T>(method, args)
    },
  }
  return { adapter, batches, copied, planDirs, readSizes }
}

/** 所有批次里的文件摊平（大多数断言只关心"最终写了什么"）。 */
function writtenFiles(spy: SiteSpy): Map<string, string> {
  const all = new Map<string, string>()
  for (const batch of spy.batches) {
    for (const file of batch) all.set(file.relPath, file.text)
  }
  return all
}

function stubTauriRuntime(): void {
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
}

function resetStores(): void {
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
  })
  useLinksStore.setState({
    status: { phase: 'ready', indexed: 0, total: 0, durationMs: 0, links: 0 },
    links: null,
    loading: false,
    error: null,
  })
  useToastStore.getState().clear()
}

async function setup(options: { failWrite?: boolean } = {}): Promise<SiteSpy> {
  const base = createMockAdapter({ notes: NOTES })
  const spy = spyOnSite(base, options)
  setIpcAdapter(spy.adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
  await openNote('笔记/甲.md')
  return spy
}

beforeEach(() => {
  stubTauriRuntime()
  setDirectoryPicker(async () => 'D:\\导出的站点')
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
  setDirectoryPicker(null)
  vi.restoreAllMocks()
})

describe('整库导出：写出来的目录里到底有什么', () => {
  it('每篇一个 HTML：正文渲染、frontmatter 不进正文、标题来自计划', async () => {
    const spy = await setup()

    const result = await exportVaultSite()

    expect(result).not.toBeNull()
    expect(result?.pages).toBe(3)
    const files = writtenFiles(spy)

    const page = files.get('笔记/甲.html')
    expect(page).toBeDefined()
    expect(page).toContain('<!doctype html>')
    expect(page).toContain('<meta charset="utf-8" />')
    // 标题取的是 frontmatter 的 `title`（与图谱卡片同口径），**不是**正文里的 H1
    expect(page).toContain('<title>甲的标题 · MockVault</title>')
    expect(page).not.toContain('title: 甲的标题')
    // 正文里的 H1 照常渲染（它只是"内容"）
    expect(page).toContain('正文里的 H1 不该当标题')
    expect(files.has('笔记/乙.html')).toBe(true)
    expect(files.has('笔记/丙.html')).toBe(true)
  })

  it('`[[双链]]` 变成指向另一份 HTML 的相对链接，悬空的变成不可点的文字', async () => {
    const spy = await setup()
    await exportVaultSite()

    const page = writtenFiles(spy).get('笔记/甲.html') ?? ''
    // 同目录：只有文件名（编码后）
    expect(page).toContain('href="%E4%B9%99.html"')
    // 带路径与别名：别名是显示文本，href 指向那一页
    expect(page).toContain('href="%E4%B8%99.html"')
    expect(page).toContain('丙的别名')
    // 悬空：**不是 `<a>`**，而是不可点的文字（站点里没有"点击创建"这条路）
    expect(page).toContain('class="mn-wikilink mn-wikilink--dangling"')
    expect(page).toContain('还不存在的笔记：还不存在的笔记')
    expect(page).not.toContain('href="#mn-wikilink"')
  })

  it('锚点：`[[甲#小节]]` 的链接带上片段，且标题真的生成了 id（否则点下去只是回到页首）', async () => {
    const spy = await setup()
    await exportVaultSite()

    const files = writtenFiles(spy)
    const fromYi = files.get('笔记/乙.html') ?? ''
    const jia = files.get('笔记/甲.html') ?? ''
    expect(fromYi).toContain('href="%E7%94%B2.html#%E5%B0%8F%E8%8A%82"')
    expect(jia).toContain('id="正文里的 H1 不该当标题"')
  })

  it('图片引用站内相对地址，**绝不内嵌 data:**', async () => {
    const spy = await setup()
    const result = await exportVaultSite()

    const page = writtenFiles(spy).get('笔记/甲.html') ?? ''
    expect(page).toContain('src="../assets/%E9%99%84%E4%BB%B6/%E5%9B%BE.png"')
    expect(page).not.toContain('data:image/')
    // 图片字节由宿主复制（不经过 IPC 的 base64 通道），这里只报了路径
    expect(spy.copied).toEqual(['附件/图.png'])
    expect(result?.assets).toBe(1)
  })

  it('callout 也进了静态站点：结构同构、颜色仍在内联样式里（ADR-0022 的第四处渲染面）', async () => {
    const spy = await setup()
    await exportVaultSite()

    const files = writtenFiles(spy)
    const page = files.get('笔记/丙.html') ?? ''
    const css = files.get('assets/site.css') ?? ''

    // 1) 页面里的结构就是阅读视图那一套（同一条渲染管线）
    expect(page).toContain('class="mn-callout mn-callout--warning"')
    expect(page).toContain('mn-callout__title')
    expect(page).toContain('mn-callout__label">小心<')
    // 2) 未知类型照样渲染、名字保留用户写的，并带上那个痕迹类名
    expect(page).toContain('mn-callout--unknown')
    expect(page).toContain('mn-callout__label">摘录<')
    // 3) 样式在整站共享的那份 CSS 里（站点不开外网、也没有 app.css）
    expect(css).toContain('.mn-callout')
    expect(css).toContain('.mn-callout--warning')
    expect(css).not.toContain('asset:')
  })

  it('共享样式表：整站一份，每页按自身深度引用它', async () => {
    const spy = await setup()
    await exportVaultSite()

    const files = writtenFiles(spy)
    const css = files.get('assets/site.css') ?? ''
    expect(css).toContain('.mn-export')  // 与单篇导出共用同一份正文排版
    expect(css).toContain('.mn-site-nav') // 站点外壳
    expect(files.get('笔记/甲.html')).toContain('href="../assets/site.css"')
    expect(files.get('index.html')).toContain('href="assets/site.css"')
  })

  it('索引页列出每一篇，并把需要让人知道的问题点名', async () => {
    const spy = await setup()
    await exportVaultSite()

    const index = writtenFiles(spy).get('index.html') ?? ''
    expect(index).toContain('共 3 篇笔记')
    expect(index).toContain('href="%E7%AC%94%E8%AE%B0/%E7%94%B2.html"')
    expect(index).toContain('甲的标题')
    expect(index).toContain('<details')
    // 悬空链接必须被点名（"指向不存在的笔记"是要让人知道的事实）
    expect(index).toContain('还不存在的笔记')
    expect(index).not.toContain('src="assets')  // 索引页不引图片
  })

  it('标记文件最后写，内容含这次写出去的全部文件（下次据此算残留）', async () => {
    const spy = await setup()
    await exportVaultSite()

    const lastBatch = spy.batches[spy.batches.length - 1] ?? []
    expect(lastBatch.map((file) => file.relPath)).toEqual(['mimenote-export.json'])
    const marker = JSON.parse(lastBatch[0]?.text ?? '{}') as {
      tool: string
      files: string[]
      exportedAtMs: number
    }
    expect(marker.tool).toBe('mimenote')
    expect(marker.files).toContain('index.html')
    expect(marker.files).toContain('assets/site.css')
    expect(marker.files).toContain('笔记/甲.html')
    expect(typeof marker.exportedAtMs).toBe('number')
  })

  it('一批一批地读（进度与"让出主线程"都建立在这上面）', async () => {
    const spy = await setup()
    await exportVaultSite()

    expect(spy.readSizes).toEqual([3])
    expect(spy.readSizes.every((size) => size <= SITE_EXPORT_BATCH)).toBe(true)
  })

  it('读不到的笔记跳过并如实汇报（不因为一篇坏笔记让整库白跑）', async () => {
    const spy = await setup()
    // 计划里多出一页，但它在 Vault 里并不存在（模拟"计划生成之后文件被删了"）
    const base = spy.adapter
    const patched: IpcAdapter = {
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        const result = await base.invoke<T>(method, args)
        if (method === 'export_site_plan') {
          const plan = result as { pages: Array<Record<string, unknown>>; outputDir: string | null }
          return {
            ...plan,
            pages: [
              ...plan.pages,
              {
                relPath: '已经删掉.md',
                pagePath: '已经删掉.html',
                urlPath: '%E5%B7%B2%E7%BB%8F%E5%88%A0%E6%8E%89.html',
                title: '已经删掉',
                tags: [],
                links: [],
                backlinks: [],
              },
            ],
          } as T
        }
        return result
      },
    }
    setIpcAdapter(patched)

    const result = await exportVaultSite()

    const files = writtenFiles(spy)
    expect(files.has('已经删掉.html')).toBe(false)
    expect(result?.skipped.map((item) => item.relPath)).toEqual(['已经删掉.md'])
    // 索引页把没导出的那篇点名（"没有静默丢掉的东西"）
    const index = files.get('index.html') ?? ''
    expect(index).toContain('已经删掉.md')
    expect(index).toContain('没能导出')
  })

  it('上次导出留下、这次没写的文件如实点名（我们从不删除）', async () => {
    const spy = await setup()
    const base = spy.adapter
    const patched: IpcAdapter = {
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        const result = await base.invoke<T>(method, args)
        if (method === 'export_site_plan' && args?.outputDir !== null) {
          const plan = result as Record<string, unknown>
          return {
            ...plan,
            previous: {
              exportedAtMs: 1_700_000_000_000,
              vaultName: 'MockVault',
              files: ['index.html', 'assets/site.css', '笔记/甲.html', '笔记/已经删掉的.md.html'],
            },
          } as T
        }
        return result
      },
    }
    setIpcAdapter(patched)

    const result = await exportVaultSite()

    // 只该报真正"上次有、这次没有"的那一个 —— `index.html` 与 `assets/site.css`
    // 每次都会写，不能把它们报成残留
    expect(result?.stale).toEqual(['笔记/已经删掉的.md.html'])
    const index = writtenFiles(spy).get('index.html') ?? ''
    expect(index).toContain('笔记/已经删掉的.md.html')
    expect(index).toContain('没有再写')
  })
})

describe('确定性与取消', () => {
  it('同一个 Vault 导出两次：页面与索引页逐字节相同（只有标记里的时间戳会变）', async () => {
    const first = await setup()
    await exportVaultSite()
    const firstFiles = writtenFiles(first)

    const second = await setup()
    await exportVaultSite()
    const secondFiles = writtenFiles(second)

    // 页面里**不含时间戳**，所以逐字节可比 —— 这是同步盘用户的硬需求
    // （否则每次重导出都会让几千个文件全部重新上传）
    for (const [relPath, text] of firstFiles) {
      if (relPath === 'mimenote-export.json') continue
      expect(secondFiles.get(relPath), `${relPath} 应当逐字节相同`).toBe(text)
    }
    expect(firstFiles.get('index.html')).toBe(secondFiles.get('index.html'))
  })

  it('取消：不写索引页与标记文件（目录里没有任何东西自称"导出完成"）', async () => {
    const spy = await setup()
    const result = await exportVaultSite({ shouldContinue: () => false })

    const files = writtenFiles(spy)
    expect(files.has('index.html')).toBe(false)
    expect(files.has('mimenote-export.json')).toBe(false)
    expect(result?.files).toBe(0)
    // 弹的是"已取消"而不是"已导出"
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((toast) => toast.message === '导出已取消')).toBe(true)
  })

  it('写盘失败：一条错误提示，且不写标记文件（不谎报完成）', async () => {
    const spy = await setup({ failWrite: true })

    const result = await exportVaultSite()

    expect(result).toBeNull()
    expect(spy.batches).toHaveLength(0)
    expect(
      useToastStore.getState().toasts.some((toast) => toast.kind === 'error'),
    ).toBe(true)
  })
})

describe('前置条件与拒绝', () => {
  it('输出目录选在 Vault 里面 → 被拒绝，一个文件都不写', async () => {
    const spy = await setup()
    setDirectoryPicker(async () => 'C:\\MockVault\\站点')

    const result = await exportVaultSite()

    expect(result).toBeNull()
    expect(spy.batches).toHaveLength(0)
    const error = useToastStore.getState().toasts.find((toast) => toast.kind === 'error')
    expect(error?.message).toContain('不能放在 Vault 里面')
  })

  it('链接索引还没就绪 → 在选目录之前就拦下（不浪费用户一次选择）', async () => {
    const spy = await setup()
    useLinksStore.setState({
      status: { phase: 'building', indexed: 10, total: 100, durationMs: 0, links: 0 },
    })

    expect(await exportVaultSite()).toBeNull()
    expect(spy.planDirs).toHaveLength(0)
    expect(
      useToastStore.getState().toasts.some((toast) => toast.message === '链接索引还在构建'),
    ).toBe(true)
  })

  it('用户取消目录选择 → 什么都不做（浏览器预览模式还要说明为什么）', async () => {
    const spy = await setup()
    setDirectoryPicker(async () => null)

    expect(await exportVaultSite()).toBeNull()
    expect(spy.batches).toHaveLength(0)
  })

  it('没有打开 Vault → 明确拒绝', async () => {
    resetStores()
    const base = createMockAdapter({ notes: NOTES })
    const spy = spyOnSite(base)
    setIpcAdapter(spy.adapter)

    expect(await exportVaultSite()).toBeNull()
    expect(
      useToastStore.getState().toasts.some((toast) => toast.message === '还没有打开 Vault'),
    ).toBe(true)
  })

  it('Vault 里一篇 Markdown 都没有 → 说清楚而不是导出一个空站点', async () => {
    const base = createMockAdapter({ notes: [{ relPath: '附件/说明.txt', text: '不是笔记' }] })
    const spy = spyOnSite(base)
    setIpcAdapter(spy.adapter)
    resetStores()
    await useVaultStore.getState().openVault('C:\\MockVault')

    expect(await exportVaultSite()).toBeNull()
    expect(
      useToastStore.getState().toasts.some(
        (toast) => toast.message === '这个 Vault 里没有可导出的笔记',
      ),
    ).toBe(true)
  })
})

describe('界面入口', () => {
  it('导出对话框里有第三个选项（整个 Vault → 静态站点），索引没就绪时置灰并说明原因', async () => {
    await setup()
    useLinksStore.setState({
      status: { phase: 'building', indexed: 3, total: 10, durationMs: 0, links: 0 },
    })
    render(<ExportDialog />)
    requestExportKind('site')

    // 用属性选择器而不是文字：标题里有一个图标元素，文字被拆成多个节点
    const choice = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('[data-export-site]')
      expect(found).not.toBeNull()
      return found
    })
    expect(choice?.disabled).toBe(true)
    expect(choice?.textContent).toContain('链接索引还在构建')

    // 索引建好之后自动可用（不需要重开对话框）
    useLinksStore.setState({
      status: { phase: 'ready', indexed: 10, total: 10, durationMs: 5, links: 3 },
    })
    await waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('[data-export-site]')?.disabled).toBe(false)
    })
  })
})

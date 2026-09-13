// @vitest-environment jsdom
/**
 * 导出（M3）：自包含 HTML / 打印为 PDF。
 *
 * 断言的重心是**产出的那个字符串**：导出件的可验证交付就是"一个能在浏览器里打开的 HTML 文件"
 * （见 `docs/milestones.md` 的 M3 行），所以这里把"文件里到底写了什么"逐条钉死：
 *
 * - 是一份完整文档（`<!doctype html>` / `<meta charset="utf-8">` / `<title>`）；
 * - 正文里有笔记里的词，且 frontmatter 不进正文；
 * - Vault 内图片被内嵌成 `<img src="data:image/...">`（字节由 Mock 的 `asset_read_base64` 给）；
 * - **不含** `asset:` 或任何外部资源引用 —— 这是"拿到任何地方都能看"的全部含义；
 * - 主题令牌取成静态值写进 `<style>`（不引外部样式表、不引字体文件）。
 *
 * 另外覆盖：空态（没有 Vault / 没有笔记）、写盘失败时的可见反馈、取消保存对话框、
 * 以及打印路径（`window.print` 被调用，打印容器在打印时存在、打印后被清理）。
 *
 * 与 `preview-images.test.tsx` 同样的手法：jsdom 里没有真实 WebView，所以**桩掉
 * `window.__TAURI_INTERNALS__`**（`isTauriRuntime()` 就是看它）—— 导出在非 Tauri 运行时
 * 不会去请求图片字节，也不会弹保存对话框，那是浏览器预览模式的降级路径（另有单独用例）。
 *
 * Rust 侧的路径校验、扩展名白名单、base64 与原子写由 `cargo test -p mimenote` 与应用层 E2E 覆盖。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote } from '@/app/actions'
import { ExportButton } from '@/features/export/ExportButton'
import { ExportDialog } from '@/features/export/ExportDialog'
import { requestExport, requestExportKind } from '@/features/export/export-events'
import { PRINT_ROOT_ID, PRINT_STYLE_ID, buildPrintCss } from '@/features/export/export-html'
import { exportNoteHtml, printNote } from '@/features/export/export-note'
import { setSavePathPicker } from '@/features/export/export-save'
import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { MimenoteError } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

/** 图片文件的"内容"：Mock 里图片也是文本文件（它只镜像契约形状，不解析真实图片）。 */
const IMAGE_TEXT = 'PNGDATA'
/** 上面那几个字节的 base64（Mock 的 `asset_read_base64` 会算出来，这里用来对断言）。 */
const IMAGE_BASE64 = 'UE5HREFUQQ=='

const NOTES = [
  {
    relPath: '笔记/导出.md',
    text: [
      '# 导出测试',
      '',
      '这一段里有 **关键词甲**，还有一条 [[双链]]。',
      '',
      '![图](../附件/图.png)',
      '',
      '```ts',
      'export const answer = 42',
      '```',
      '',
    ].join('\n'),
  },
  // 标题来自 frontmatter 的 `title`（优先于正文 H1）
  { relPath: '笔记/带属性.md', text: '---\ntitle: 前端属性标题\ntags: [导出]\n---\n\n正文。\n' },
  // 外部图片：不该被内嵌，也不该在导出件里留下任何可发起请求的地址
  {
    relPath: '笔记/外链图.md',
    text: '# 外链图\n\n![外部](https://example.com/x.png)\n\n![越界](../../外部.png)\n',
  },
  // 图片：Mock 的条目表里有它，`createAssetResolver` 才能按相对路径解析到
  { relPath: '附件/图.png', text: IMAGE_TEXT },
]

/** 记录导出相关的 IPC 调用，其余命令原样转发给 Mock。 */
interface ExportSpy {
  adapter: IpcAdapter
  /** 每次 `asset_read_base64` 请求的图片路径。 */
  imageRequests: string[][]
  /** 每次 `export_write_html` 的入参（path + 完整的 HTML 字符串）。 */
  writes: Array<{ path: string; html: string }>
}

function spyOnExport(base: MockAdapter, failWrite = false): ExportSpy {
  const imageRequests: string[][] = []
  const writes: Array<{ path: string; html: string }> = []
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method === 'asset_read_base64') {
        imageRequests.push((args?.relPaths as string[] | undefined) ?? [])
      }
      if (method === 'export_write_html') {
        if (failWrite) {
          throw new MimenoteError({
            code: 'IO',
            message: '磁盘读写失败（磁盘已满）',
            detail: null,
            currentMtimeMs: null,
          })
        }
        writes.push({ path: String(args?.path ?? ''), html: String(args?.html ?? '') })
      }
      return base.invoke<T>(method, args)
    },
  }
  return { adapter, imageRequests, writes }
}

/** 桩掉 Tauri 运行时（导出在真实应用里就走这条路径）。 */
function stubTauriRuntime(): void {
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
}

function removeTauriRuntime(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
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
  useToastStore.getState().clear()
}

async function setup(relPath: string | null, failWrite = false): Promise<ExportSpy> {
  const base = createMockAdapter({ notes: NOTES })
  const spy = spyOnExport(base, failWrite)
  setIpcAdapter(spy.adapter)
  resetStores()
  if (relPath !== null) {
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openNote(relPath)
  }
  return spy
}

beforeEach(() => {
  stubTauriRuntime()
  // 保存对话框：jsdom 里没有系统对话框，注入一个"用户选了某个路径"的替身
  // （与 `setIpcAdapter` 同一个理由，见 export-save.ts）
  setSavePathPicker(async (defaultName) => `D:\\导出\\${defaultName}`)
})

afterEach(() => {
  cleanup()
  removeTauriRuntime()
  setSavePathPicker(null)
  document.getElementById(PRINT_ROOT_ID)?.remove()
  document.getElementById(PRINT_STYLE_ID)?.remove()
})

describe('导出为自包含 HTML', () => {
  it('写出一份完整、自包含的 HTML 文档（图片内嵌、无外部引用）', async () => {
    const spy = await setup('笔记/导出.md')

    const outcome = await exportNoteHtml()

    expect(outcome).not.toBeNull()
    expect(outcome?.absolutePath).toBe('D:\\导出\\导出测试.html')

    expect(spy.writes).toHaveLength(1)
    const written = spy.writes[0]
    expect(written?.path).toBe('D:\\导出\\导出测试.html')
    const html = written?.html ?? ''

    // 1) 是一份完整的 HTML 文档，标题取正文 H1
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8" />')
    expect(html).toContain('<title>导出测试</title>')
    expect(html).toContain('</html>')

    // 2) 正文渲染出来了（走的是与阅读视图同一个净化管线）
    expect(html).toContain('关键词甲')
    expect(html).toContain('<strong>')
    expect(html).toContain('answer = 42')

    // 3) 图片内嵌成 data: URL（Mock 的 base64 命令返回它的内容）
    expect(spy.imageRequests).toEqual([['附件/图.png']])
    expect(html).toContain(`<img class="mn-image" src="data:image/png;base64,${IMAGE_BASE64}"`)

    // 4) 不含任何外部资源引用：`asset:` 只在应用内有效；`http(s)://` 与协议相对地址
    //    在别处不是断掉就是变成一次出网请求 —— 两者都不该出现在导出件里
    expect(html).not.toContain('asset:')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toMatch(/\b(?:src|href)="(?:[a-z][a-z0-9+.-]*:)?\/\//i)

    // 5) 样式内联且是**主题令牌的静态快照**（不引 app.css、不引字体、不引任何 URL）
    expect(html).toContain('<style>')
    expect(html).toMatch(/--mn-bg:\s*#[0-9a-f]{3,8}/i)
    expect(html).toMatch(/--mn-font-mono:/)
    expect(html).not.toContain('@import')
    expect(html).not.toContain('<link')

    // 6) 成功反馈（导出到哪、多大）
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((item) => item.message === '已导出到')).toBe(true)
    })
  })

  it('frontmatter 不进正文，标题优先取 frontmatter 的 title', async () => {
    const spy = await setup('笔记/带属性.md')

    await exportNoteHtml()

    const html = spy.writes[0]?.html ?? ''
    expect(html).toContain('<title>前端属性标题</title>')
    expect(html).not.toContain('tags: [导出]')
    expect(html).toContain('正文。')
  })

  it('外部图片与越界图片退化成占位文字，且导出件里没有任何可请求的地址', async () => {
    const spy = await setup('笔记/外链图.md')

    await exportNoteHtml()

    const html = spy.writes[0]?.html ?? ''
    expect(spy.imageRequests).toEqual([])
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toContain('<img')
    // 占位文字里可以出现用户自己写的地址（那是原文，不是引用），但绝不能是 src/href
    expect(html).not.toMatch(/\b(?:src|href)="(?:[a-z][a-z0-9+.-]*:)?\/\//i)
  })

  it('图片没能内嵌（宿主跳过）时导出仍然成功，只是退化成占位文字', async () => {
    const base = createMockAdapter({
      notes: [
        { relPath: '笔记/缺图.md', text: '# 缺图\n\n这张图不在库里：![图](../附件/没有.png)\n' },
      ],
    })
    const spy = spyOnExport(base)
    setIpcAdapter(spy.adapter)
    resetStores()
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openNote('笔记/缺图.md')

    await exportNoteHtml()

    const html = spy.writes[0]?.html ?? ''
    expect(spy.imageRequests).toEqual([['附件/没有.png']])
    expect(html).toContain('mn-image-placeholder')
    expect(html).not.toContain('<img')
  })

  it('没有 Vault / 没有打开笔记时给出可见反馈，且不发任何 IPC', async () => {
    const spy = await setup(null)

    expect(await exportNoteHtml()).toBeNull()
    expect(spy.writes).toHaveLength(0)
    expect(
      useToastStore.getState().toasts.some((item) => item.message === '还没有打开 Vault'),
    ).toBe(true)

    // 打开了 Vault 但没有笔记 → 另一条提示
    useToastStore.getState().clear()
    await useVaultStore.getState().openVault('C:\\MockVault')
    expect(await exportNoteHtml()).toBeNull()
    expect(
      useToastStore.getState().toasts.some((item) => item.message === '没有打开的笔记'),
    ).toBe(true)
  })

  it('写盘失败时弹错误提示（不静默失败）', async () => {
    await setup('笔记/导出.md', true)

    expect(await exportNoteHtml()).toBeNull()

    const errors = useToastStore.getState().toasts.filter((item) => item.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('导出失败')
    expect(errors[0]?.message).toContain('磁盘')
  })

  it('用户取消保存对话框时静默结束（不报错、不弹成功提示）', async () => {
    await setup('笔记/导出.md')
    setSavePathPicker(async () => null)

    expect(await exportNoteHtml()).toBeNull()

    const toasts = useToastStore.getState().toasts
    expect(toasts.some((item) => item.kind === 'error')).toBe(false)
    expect(toasts.some((item) => item.message === '已导出到')).toBe(false)
  })

  it('浏览器预览模式（没有 Tauri 运行时）：说明为什么写不出文件', async () => {
    removeTauriRuntime()
    await setup('笔记/导出.md')
    setSavePathPicker(async () => null)

    expect(await exportNoteHtml()).toBeNull()

    expect(
      useToastStore
        .getState()
        .toasts.some((item) => item.message === '浏览器预览模式无法写出文件'),
    ).toBe(true)
  })
})

describe('导出对话框与入口', () => {
  it('「导出」按钮打开对话框，选「自包含 HTML」后真的导出', async () => {
    const spy = await setup('笔记/导出.md')
    render(
      <>
        <ExportButton />
        <ExportDialog />
      </>,
    )

    const button = screen.getByRole<HTMLButtonElement>('button', { name: /导出/ })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    const dialog = await screen.findByRole('dialog', { name: '导出当前笔记' })
    expect(dialog.textContent).toContain('笔记/导出.md')

    fireEvent.click(screen.getByRole('button', { name: /自包含 HTML/ }))

    await waitFor(() => {
      expect(spy.writes).toHaveLength(1)
    })
    // 成功后对话框自己收起（结果由 toast 说明）
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导出当前笔记' })).toBeNull()
    })
  })

  it('没有笔记时按钮禁用、对话框给出原因', async () => {
    await setup(null)
    render(
      <>
        <ExportButton />
        <ExportDialog />
      </>,
    )

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /导出/ }).disabled).toBe(true)

    act(() => requestExport())
    const dialog = await screen.findByRole('dialog', { name: '导出当前笔记' })
    expect(dialog.textContent).toContain('还没有打开 Vault')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /自包含 HTML/ }).disabled).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /打印 \/ 另存为 PDF/ }).disabled,
    ).toBe(true)
  })

  it('Esc 关闭对话框', async () => {
    await setup('笔记/导出.md')
    render(<ExportDialog />)

    act(() => requestExport())
    const dialog = await screen.findByRole('dialog', { name: '导出当前笔记' })
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导出当前笔记' })).toBeNull()
    })
  })

  it('命令直接执行（`export.html`）：对话框兼作进度面板，跑完自己收起', async () => {
    const spy = await setup('笔记/导出.md')
    render(<ExportDialog />)

    act(() => requestExportKind('html'))

    await waitFor(() => {
      expect(spy.writes).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导出当前笔记' })).toBeNull()
    })
  })
})

describe('打印 / 另存为 PDF', () => {
  it('打印样式强制浅色（颜色换掉、字体与字号沿用用户设置）', async () => {
    // 颜色令牌声明在打印容器上会盖掉 `@media print :root` 的浅色值 → 打印出来又是深色块。
    // 这条用例专门钉住这个坑：颜色必须换，排版令牌必须留。
    const style = buildPrintCss({
      '--mn-bg': '#14161a',
      '--mn-fg': '#d7dce5',
      '--mn-font-size-editor': '17px',
      '--mn-font-mono': "'Cascadia Code', monospace",
    })

    expect(style).toContain('--mn-bg: #ffffff')
    expect(style).not.toContain('#14161a')
    expect(style).toContain('--mn-fg: #000000')
    expect(style).toContain('--mn-font-size-editor: 17px')
    expect(style).toContain('--mn-font-mono:')
    expect(style).toContain('white-space: pre-wrap')
    expect(style).toContain('@page')
  })

  it('把正文挂到打印容器里并调用 window.print()，打印后清理干净', async () => {
    await setup('笔记/导出.md')

    /** 打印瞬间容器里的东西（`window.print()` 时抓一次）。 */
    let printedHtml = ''
    let rootDuringPrint = false
    const printSpy = vi.fn(() => {
      const root = document.getElementById(PRINT_ROOT_ID)
      rootDuringPrint = root !== null
      printedHtml = root?.innerHTML ?? ''
    })
    vi.stubGlobal('print', printSpy)

    expect(await printNote()).toBe(true)

    expect(printSpy).toHaveBeenCalledTimes(1)
    expect(rootDuringPrint).toBe(true)
    // 打印的是"导出的那份正文"：图片同样是内嵌的 data URL（打印时不会去请求 asset 协议）
    expect(printedHtml).toContain('关键词甲')
    expect(printedHtml).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`)
    expect(printedHtml).not.toContain('asset:')

    // 可逆副作用：打印结束后容器与样式都不留
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.getElementById(PRINT_STYLE_ID)).toBeNull()

    vi.unstubAllGlobals()
  })

  it('没有笔记时不打印，并说明原因', async () => {
    await setup(null)
    const printSpy = vi.fn()
    vi.stubGlobal('print', printSpy)

    expect(await printNote()).toBe(false)

    expect(printSpy).not.toHaveBeenCalled()
    expect(
      useToastStore.getState().toasts.some((item) => item.message === '还没有打开 Vault'),
    ).toBe(true)

    vi.unstubAllGlobals()
  })
})

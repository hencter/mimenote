/**
 * 导出的高层动作：`exportNoteHtml()`（自包含 HTML）与 `printNote()`（打印 / 另存为 PDF）。
 *
 * 为什么放在 `features/export/` 而不是 `app/actions.ts`：那个文件不在本次改动的可改范围内；
 * 这里与它的分工一致（组件只调用动作，动作编排 store 与 IPC，组件不自己 invoke）。
 *
 * 两个动作共用一条"取材"链路（{@link buildCurrentExport}）：
 * 打开中的笔记（含未保存的编辑）→ 去掉 frontmatter 的正文 → 用既有的净化管线渲染 →
 * 把 Vault 内图片换成 `data:` URL。区别只在最后一步：写文件 vs 交给系统打印。
 */

import { formatBytes } from '@/domain/format'
import { frontmatterBody } from '@/domain/frontmatter'
import { stem } from '@/domain/paths'
import { ipc, isTauriRuntime } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { getTheme } from '@/theme/apply'
import { REQUIRED_TOKENS } from '@/theme/tokens'

import {
  PRINT_ROOT_ID,
  PRINT_STYLE_ID,
  buildExportBodyHtml,
  buildExportHtml,
  buildPrintCss,
  collectExportImages,
} from './export-html'
import { pickExportPath } from './export-save'

/**
 * "大笔记"的门槛（5 MiB，与 architecture.md §8 的大文档口径一致）。
 *
 * 超过它时对话框会先说明"要等几秒"：渲染 + 内嵌图片都是**主线程同步工作**，
 * 用户看不到进度就会以为卡死了。
 */
export const LARGE_EXPORT_BYTES = 5 * 1024 * 1024

/** 进度回调（对话框把它显示成一行状态文字）。 */
export type ExportProgress = (message: string) => void

export interface ExportOptions {
  onProgress?: ExportProgress
}

interface ExportContent {
  /** 来源笔记的相对路径。 */
  relPath: string
  /** 文档标题。 */
  title: string
  /** 已净化的正文 HTML（打印容器只需要它）。 */
  bodyHtml: string
  /** 自包含 HTML 文档（完整文档，含 `<style>` 与页脚）。 */
  html: string
  /** 已内嵌图片张数（提示用）。 */
  embeddedImages: number
}

/** 让浏览器先把"忙碌"这一帧画出来，再做同步的重活（大笔记渲染是阻塞的）。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 主题令牌的静态快照：优先取 DOM 上的**实际值**（含设置页的字号覆盖），缺失才回落主题 JSON。 */
export function readExportTokens(): { tokens: Record<string, string>; appearance: 'dark' | 'light' } {
  const theme = getTheme(useUiStore.getState().themeId)
  const computed =
    typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const live =
    typeof document === 'undefined' ? null : document.documentElement.style

  const tokens: Record<string, string> = {}
  for (const name of REQUIRED_TOKENS) {
    const fromComputed = computed?.getPropertyValue(name).trim() ?? ''
    const fromInline = live?.getPropertyValue(name).trim() ?? ''
    const value = fromComputed !== '' ? fromComputed : fromInline !== '' ? fromInline : (theme.tokens[name] ?? '')
    if (value !== '') tokens[name] = value
  }
  return { tokens, appearance: theme.appearance }
}

/** 导出件的标题：frontmatter 的 `title`（走宿主既有解析）→ 正文首个 H1 → 文件名主干。 */
async function resolveExportTitle(relPath: string, body: string, dirty: boolean): Promise<string> {
  // 有未保存改动时跳过 frontmatter：磁盘上的值可能还是旧的，用它会导出成"改之前的标题"，
  // 而 H1/文件名至少来自用户眼前看到的正文。
  if (!dirty && isTauriRuntime()) {
    try {
      const tags = await ipc.noteTags(relPath)
      const title = tags.frontmatter.find((field) => field.key === 'title')
      if (title !== undefined && title.value.kind === 'scalar' && title.value.value.trim() !== '') {
        return title.value.value.trim()
      }
    } catch {
      // 读不到只是"标题退一级"，不影响导出本身，不打扰用户
    }
  }

  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(body.split('\n')[0]?.trim() ?? '')
  const fromHeading = heading?.[1]?.trim() ?? ''
  if (fromHeading !== '') return fromHeading
  return stem(relPath)
}

/** 收集导出所需的全部素材（正文 HTML、标题、令牌）。 */
async function buildCurrentExport(
  relPath: string,
  onProgress: ExportProgress | undefined,
): Promise<ExportContent> {
  const doc = useNoteStore.getState().doc
  const text = doc?.text ?? ''
  // frontmatter 是元数据，不进正文（与阅读视图、`domain/frontmatter.ts` 的口径一致）
  const body = frontmatterBody(text)
  const entries = useVaultStore.getState().entries

  onProgress?.('正在渲染正文…')
  await yieldToUi()

  const imageRelPaths = collectExportImages({ relPath, body, entries })
  const images = new Map<string, string>()
  if (imageRelPaths.length > 0 && isTauriRuntime()) {
    onProgress?.(`正在内嵌 ${imageRelPaths.length} 张图片…`)
    try {
      const items = await ipc.assetReadBase64(imageRelPaths)
      for (const item of items) {
        images.set(item.relPath, `data:${item.mime};base64,${item.dataBase64}`)
      }
      const skipped = imageRelPaths.length - items.length
      if (skipped > 0) {
        // 宿主会跳过超限/读取失败的图片；说出张数，别让用户以为图丢了却没提示
        toast.warn('部分图片未能内嵌', `${skipped} 张图片超出内嵌上限或读取失败，导出件里显示为占位文字`)
      }
    } catch (cause) {
      toast.warn('图片内嵌失败', describeError(MimenoteError.from(cause), '导出将以占位文字显示图片'))
    }
  }

  onProgress?.('正在生成 HTML…')
  await yieldToUi()

  const title = await resolveExportTitle(relPath, body, useNoteStore.getState().dirty)
  const bodyHtml = buildExportBodyHtml({ relPath, body, entries, images })
  const { tokens, appearance } = readExportTokens()

  return {
    relPath,
    title,
    bodyHtml,
    embeddedImages: images.size,
    html: buildExportHtml({
      title,
      bodyHtml,
      tokens,
      appearance,
      sourceRelPath: relPath,
      exportedAtMs: Date.now(),
    }),
  }
}

/** 前置校验：必须打开了 Vault 且有一篇打开的笔记。失败时给出可见提示并返回 `false`。 */
function requireExportable(): boolean {
  if (useVaultStore.getState().info === null) {
    toast.warn('还没有打开 Vault', '导出的是"当前打开的笔记"，先打开一个 Vault 再试')
    return false
  }
  if (useNoteStore.getState().doc === null) {
    toast.warn('没有打开的笔记', '先在文件树里点开一篇笔记，再导出它')
    return false
  }
  return true
}

/** 建议的文件名（Windows 非法字符做一次替换，与 `mn-core` 的命名口径精神一致）。 */
function suggestFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || '未命名'
  return `${safe}.html`
}

/**
 * 导出当前笔记为**自包含 HTML**：渲染 → 内嵌图片 → 保存对话框 → 宿主原子写。
 *
 * 返回写入结果；用户取消或失败返回 `null`。
 */
export async function exportNoteHtml(
  options: ExportOptions = {},
): Promise<{ absolutePath: string; sizeBytes: number } | null> {
  if (!requireExportable()) return null
  const doc = useNoteStore.getState().doc
  if (doc === null) return null

  try {
    const content = await buildCurrentExport(doc.relPath, options.onProgress)

    options.onProgress?.('请选择保存位置…')
    const target = await pickExportPath(suggestFileName(content.title))
    if (target === null) {
      // 用户取消是正常路径（不打错误提示）；完全没有对话框（浏览器预览）才需要解释
      if (!isTauriRuntime()) {
        toast.info('浏览器预览模式无法写出文件', '这里没有系统保存对话框；用「打印 / 另存为 PDF」或在桌面应用里导出')
      }
      return null
    }

    options.onProgress?.('正在写入文件…')
    const outcome = await ipc.exportWriteHtml(target, content.html)
    toast.success(
      '已导出到',
      `${outcome.absolutePath}\n${formatBytes(outcome.sizeBytes)} · 写入 ${outcome.writtenInMs}ms` +
        (content.embeddedImages > 0 ? ` · 内嵌 ${content.embeddedImages} 张图片` : ''),
    )
    return { absolutePath: outcome.absolutePath, sizeBytes: outcome.sizeBytes }
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '导出失败'))
    return null
  }
}

/** 清理打印容器与样式（可逆副作用的收尾）。 */
function clearPrintRoot(): void {
  document.getElementById(PRINT_ROOT_ID)?.remove()
  document.getElementById(PRINT_STYLE_ID)?.remove()
}

/**
 * 打印当前笔记（用户在系统打印对话框里选"另存为 PDF"就是 v1 的 PDF 路径）。
 *
 * 为什么走 `window.print()` 而不是自己生成 PDF：Tauri 没有直接写 PDF 的 API，要生成 PDF 就得
 * 引入一个 PDF 引擎（体积按 MB 计、还要处理中文字体嵌入与排版继承）—— 而每个平台的
 * 打印对话框本来就有"另存为 PDF"。用系统能力换掉一个必然会跟浏览器排版打架的依赖。
 *
 * 打印的是**导出的那份 HTML**（同一个渲染管线、图片同样是内嵌的 data URL），而不是当前界面：
 * 界面里有侧栏/状态栏/编辑器光标，而且编辑视图下打印 CodeMirror 完全没有意义。
 * 做法是把正文挂到一个只在打印时可见的容器（`#mn-print-root`）里，用 `export.css` 隐藏应用外壳。
 */
export async function printNote(options: ExportOptions = {}): Promise<boolean> {
  if (!requireExportable()) return false
  const doc = useNoteStore.getState().doc
  if (doc === null) return false

  try {
    const content = await buildCurrentExport(doc.relPath, options.onProgress)
    options.onProgress?.('正在准备打印…')

    // 打印件固定浅色（白底黑字）：纸张/PDF 是"外部介质"，深色主题既费墨又常常打出一片灰黑
    const { tokens } = readExportTokens()
    const style = document.createElement('style')
    style.id = PRINT_STYLE_ID
    style.textContent = buildPrintCss(tokens)
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.id = PRINT_ROOT_ID
    root.setAttribute('aria-hidden', 'true')
    // bodyHtml 已经过 DOMPurify 净化（两道防线见 domain/markdown.ts），这里只是换个容器
    root.innerHTML = `<main class="mn-export"><article class="mn-export__content">${content.bodyHtml}</article></main>`
    document.body.appendChild(root)

    // 让浏览器先按打印样式排一次版，再唤起打印对话框
    await yieldToUi()
    window.print()
    return true
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '打印失败'))
    return false
  } finally {
    clearPrintRoot()
  }
}

/** 供渲染层判断"这篇笔记算不算大"（对话框据此提前提示需要等几秒）。 */
export function isLargeExport(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === 'number' && sizeBytes > LARGE_EXPORT_BYTES
}

/**
 * 整库导出静态站点（ADR-0019）的高层动作。
 *
 * 形状是被两条"唯一一份"逼出来的（见 `docs/adr/0019-static-site-export.md`）：
 *
 * * **Markdown→HTML 的唯一渲染管线在前端**（`domain/markdown.ts` 的 `renderMarkdown` + DOMPurify）
 *   —— 所以正文必须在这里渲染，不能在宿主的 Rust 里再养一份；
 * * **链接解析的唯一规则在链接索引里**（`mn-index::resolve_target`）—— 所以"谁指向谁、
 *   每篇落在哪个 URL"由宿主算好（`export_site_plan`），前端只查表，不复制解析规则。
 *
 * 于是流程是：**宿主出计划 → 前端分批渲染 → 宿主批量落盘 → 前端写索引页与标记**。
 * 分批（每批 24 篇）有三个作用：进度是真实的 `i/N`、每批之间让出主线程（界面不假死）、
 * 取消只需在批边界检查一个标志位（宿主侧没有可取消的后台任务，也就没有半途而废的写入）。
 *
 * 三条与"诚实"有关的决定：
 *
 * 1. **取消或失败时不写 `index.html` 与标记文件** —— 目录里不会出现任何"自称导出完成"的东西；
 * 2. **单篇失败不中断整批**（非 UTF-8、超过读取上限、读不到）：跳过、继续、如实汇报，
 *    绝不因为一篇坏笔记让另外 4000 篇白跑；
 * 3. **从不删除任何文件**（与回收站那条底线一致）：上次导出写过、这次没写的文件留在原处，
 *    由这里按标记文件的清单算出来并在结果里点名。
 */

import { frontmatterBody } from '@/domain/frontmatter'
import { createAssetResolver, isImageAssetTarget, type AssetEntry } from '@/domain/assets'
import { renderMarkdown, type ImageResolution } from '@/domain/markdown'
import {
  SITE_CSS_FILE,
  SITE_INDEX_FILE,
  SITE_MARKER_FILE,
  siteAssetHref,
} from '@/domain/site-paths'
import { ipc, isTauriRuntime } from '@/ipc/client'
import { MimenoteError, describeHostReason } from '@/ipc/types'
import type { SiteFile, SitePage, SiteSkip } from '@/ipc/types'
import { pickDirectory } from '@/app/dialogs'
import { useLinksStore } from '@/state/links-store'
import { useVaultStore } from '@/state/vault-store'
import { toast } from '@/state/toast-store'
import { collectSnippetCss } from '@/theme/snippets'

import { readExportTokens } from './export-note'
import {
  buildSiteCss,
  buildSiteIndexHtml,
  buildSiteMarker,
  buildSitePageHtml,
  collectSiteAssets,
  prepareSiteRender,
  siteAssetPath,
} from './site-html'

/** 每个渲染批次读多少篇（批越大越快、批越小越不容易卡住界面）。 */
export const SITE_EXPORT_BATCH = 24

/**
 * 单批最多写多少个文件 —— **必须 ≤ 宿主的上限**（`site_export.rs` 的 256）。
 *
 * 一批 = 一批页面 + 样式表 + 索引页 + 标记文件，所以取 200 留出余量：宿主超限会整批拒绝，
 * 那是"最后一刻才发现"的最差失败时机。
 */
const SITE_WRITE_BATCH = 200

/** 每批复制多少张图片（宿主的单次上限是 512 张 / 256 MiB，这里留足余量）。 */
const SITE_ASSET_BATCH = 200

/** 进度回调：已完成的篇数与总数、以及一行人话。 */
export type SiteProgress = (done: number, total: number, message: string) => void

export interface SiteExportOptions {
  onProgress?: SiteProgress
  /** 每次准备开始一批之前问一次"还要继续吗"；返回 false 就停下（已写的文件留着）。 */
  shouldContinue?: () => boolean
}

export interface SiteExportResult {
  outputDir: string
  pages: number
  assets: number
  /** 写出去的文件数（含样式表、索引页与标记文件）。 */
  files: number
  bytes: number
  /** 没能导出的笔记（读失败 / 太大 / 非 UTF-8）。 */
  skipped: SiteSkip[]
  /** 悬空链接的目标（去重）。 */
  dangling: string[]
  /** 上次导出写过、这次没写的文件（我们从不删除，所以它们还在目录里）。 */
  stale: string[]
  /** 同名撞页面路径、被改名的笔记。 */
  renamed: Array<{ relPath: string; pagePath: string }>
  elapsedMs: number
}

/** 让浏览器先把"忙碌"这一帧画出来，再做同步的重活（渲染是阻塞的）。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 一批一批地取笔记原文；单篇失败进 `skipped`（宿主已经这么做，这里只负责汇总）。 */
async function readBatch(relPaths: readonly string[]): Promise<{
  items: Map<string, string>
  skipped: SiteSkip[]
}> {
  const outcome = await ipc.notesReadBatch(relPaths)
  return {
    items: new Map(outcome.items.map((item) => [item.relPath, item.text])),
    skipped: outcome.skipped,
  }
}

/**
 * 渲染一页：正文（已去 frontmatter）→ 净化后的 HTML → 套上站点外壳，成为一份完整的 HTML 文档。
 *
 * 两处刻意复用既有的 env 钩子：
 * * `resolveWikilink`：宿主给的 href 直接贴上去；**悬空链接返回 `null`** → 渲染成不可点的文字
 *   （站点里没有"点击创建"这条路，让它看起来可点才是骗人）；
 * * `resolveImage`：图片指向 `assets/<原路径>`，同时**记下"这张图要复制"** —— 单篇导出在这里
 *   内嵌 `data:`，站点在这里只记一笔，字节由宿主侧复制（不经过 IPC）。
 *
 * 为什么外壳（导航/反链/页脚）也在这里拼、而不是交给宿主：外壳必须与正文在同一处拼装，
 * 才能共用同一份令牌快照与同一套 `buildExportCss` 排版；把它挪到 Rust 等于把一份产物
 * 拆成两种语言维护，两边迟早出现"壳里的排版和正文里的不一样"。
 */
function renderPage(input: {
  page: SitePage
  text: string
  entries: readonly AssetEntry[]
  linkHrefs: Map<string, string | null>
  images: Set<string>
  vaultName: string
  tokens: Readonly<Record<string, string>>
  appearance: 'dark' | 'light'
}): string {
  const resolveAsset = createAssetResolver(input.entries)
  const body = frontmatterBody(input.text)

  const bodyHtml = renderMarkdown(body, {
    headingIds: true,
    // `[[目标#锚点]]` 的 href 由宿主算好（含编码后的片段）。键里带上锚点：同一篇的不同小节
    // 是两个不同的目标，只用 target 做键会让"指向另一节"的链接错误地落到同一处。
    resolveWikilink: (target: string, anchor: string | null): string | null => {
      const key = `${target}\u0000${anchor ?? ''}`
      if (input.linkHrefs.has(key)) return input.linkHrefs.get(key) ?? null
      // 计划里没有这一条（理论不该发生：计划就是从同一份正文抽的链接）——
      // 按悬空处理而不是猜一个 URL，猜错会生成一个 404 的链接。
      return null
    },
    resolveImage: (source: string): ImageResolution | null => {
      const rel = resolveAsset(input.page.relPath, source)
      if (rel === null || !isImageAssetTarget(rel)) return null
      input.images.add(rel)
      return { kind: 'ready', url: siteAssetHref(input.page.pagePath, rel) }
    },
  })

  return buildSitePageHtml({
    page: input.page,
    bodyHtml,
    vaultName: input.vaultName,
    tokens: input.tokens,
    appearance: input.appearance,
  })
}

/** 把一批页面拼成待写文件（含它们的样式表引用；样式表本身由最后一批写）。 */
function pageFiles(pages: readonly SitePage[], html: Map<string, string>): SiteFile[] {
  return pages.flatMap((page) => {
    const text = html.get(page.relPath)
    return text === undefined ? [] : [{ relPath: page.pagePath, text }]
  })
}

/**
 * 导出整个 Vault 为一个静态站点。
 *
 * 返回 `null` 表示"这次导出没有发生"（用户取消、索引还没就绪、浏览器预览模式、宿主拒绝）——
 * 那是正常路径，不抛异常；反常的是"写了一半"：那种情况会**如实返回**已经写出去的东西
 * （`files`/`bytes`），并在提示里说清目录是部分的、可以再跑一次（重跑是幂等的）。
 */
export async function exportVaultSite(
  options: SiteExportOptions = {},
): Promise<SiteExportResult | null> {
  const vault = useVaultStore.getState()
  const vaultName = vault.info?.name ?? 'Vault'

  if (vault.info === null) {
    toast.warn('还没有打开 Vault', '整库导出的是整个 Vault，先打开一个再试')
    return null
  }

  const started = Date.now()
  try {
    // 计划依赖链接索引（"每篇的链接指向谁"只有索引知道）。索引没就绪时宿主返回
    // `INDEX_NOT_READY`，这里提前拦一次是为了**在用户选目录之前**就把话说清楚。
    if (useLinksStore.getState().status.phase !== 'ready') {
      toast.warn('链接索引还在构建', '整库导出需要一个完整的链接索引，稍等一下再试')
      return null
    }

    options.onProgress?.(0, 0, '正在准备计划…')
    const overview = await ipc.sitePlan(null)
    if (overview.pages.length === 0) {
      toast.info('这个 Vault 里没有可导出的笔记', '导出的是 Markdown 笔记；这个 Vault 里一篇都没有')
      return null
    }

    options.onProgress?.(0, overview.pages.length, '请选择输出位置…')
    const outputDir = await pickDirectory('选择静态站点的输出目录（不要选在 Vault 里面）')
    if (outputDir === null) {
      if (!isTauriRuntime()) {
        toast.info(
          '浏览器预览模式无法写出文件',
          '整库导出需要系统目录选择框；在桌面应用里试，或先用单篇导出',
        )
      }
      return null
    }

    // 第二次带目录的计划：宿主在这里做**目标目录预检**（在 Vault 内 → 拒绝；非空且不是
    // 我们上次导出的 → 拒绝），并回带上次的标记内容。放在选完目录之后是因为预检需要目录。
    const plan = await ipc.sitePlan(outputDir)
    prepareSiteRender(plan.pages)

    const previousFiles = new Set(plan.previous?.files ?? [])
    const written = new Set<string>()
    const entries = useVaultStore.getState().entries
    const skipped: SiteSkip[] = []
    const images = new Set<string>(plan.assets)
    const { tokens, appearance } = readExportTokens()
    const snippets = readSnippets()
    const dangling = collectDangling(plan.pages)

    let bytes = 0
    let files = 0
    let exportedPages = 0
    let pending: SiteFile[] = []
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return
      const outcome = await ipc.siteWritePages(outputDir, pending)
      bytes += outcome.bytes
      files += outcome.files
      for (const file of pending) written.add(file.relPath)
      pending = []
    }

    for (let offset = 0; offset < plan.pages.length; offset += SITE_EXPORT_BATCH) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        return await finishPartial({
          outputDir,
          files,
          bytes,
          pages: exportedPages,
          skipped,
          dangling,
          images,
        })
      }
      const batch = plan.pages.slice(offset, offset + SITE_EXPORT_BATCH)
      options.onProgress?.(
        offset,
        plan.pages.length,
        `正在导出 ${offset + batch.length} / ${plan.pages.length} 篇…`,
      )
      await yieldToUi()

      const read = await readBatch(batch.map((page) => page.relPath))
      skipped.push(...read.skipped)

      const rendered = new Map<string, string>()
      for (const page of batch) {
        const text = read.items.get(page.relPath)
        if (text === undefined) continue
        const linkHrefs = new Map(
          page.links.map((link) => [`${link.target}\u0000${link.anchor ?? ''}`, link.href]),
        )
        try {
          rendered.set(
            page.relPath,
            renderPage({
              page,
              text,
              entries,
              linkHrefs,
              images,
              vaultName,
              tokens,
              appearance,
            }),
          )
          exportedPages += 1
        } catch (cause) {
          // 渲染异常（极端输入、内存不足）不该让整库导出停在这里
          skipped.push({
            relPath: page.relPath,
            reason: 'render-failed',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }

      pending.push(...pageFiles(batch, rendered))
      if (pending.length >= SITE_WRITE_BATCH) await flush()
    }
    await flush()

    // 图片：分批复进 `assets/`（字节只在宿主里搬）。失败的如实进 skipped。
    //
    // 为什么分批：宿主对一次请求有上限（512 张 / 256 MiB），而一个 4000 篇的 Vault 完全可能
    // 引用几千张图。超限在宿主侧走 `skipped`（不是报错 —— 否则"页面全写好、只差图片"的导出
    // 会被判成失败），但那时用户看到的是一批莫名其妙的跳过项；分批就让上限永远碰不到。
    const assetList = collectSiteAssets(images)
    let copiedAssets = 0
    if (assetList.length > 0) {
      for (let offset = 0; offset < assetList.length; offset += SITE_ASSET_BATCH) {
        const batch = assetList.slice(offset, offset + SITE_ASSET_BATCH)
        options.onProgress?.(
          plan.pages.length,
          plan.pages.length,
          `正在复制图片 ${offset + batch.length} / ${assetList.length}…`,
        )
        await yieldToUi()
        const outcome = await ipc.siteCopyAssets(
          outputDir,
          batch.map((vaultRelPath) => ({ vaultRelPath })),
        )
        copiedAssets += outcome.copied
        skipped.push(...outcome.skipped)
        for (const asset of batch) written.add(siteAssetPath(asset))
      }
    }

    // 最后一批：共享样式表、索引页、标记文件。**顺序是有意义的** —— 标记文件最后写，
    // 它是"这个目录里已经是一份完整导出"的唯一凭据；中途失败时目录里不会有它。
    //
    // 索引页里的"上次残留"要按**这一轮最终会写出的全部文件**算（`written` 现在还只有页面与图片，
    // `index.html` 与 `assets/site.css` 恰好是每次都会写的两个 —— 不把它们算进去，
    // 索引页会把自己和样式表报成"上次的残留文件"）。
    options.onProgress?.(plan.pages.length, plan.pages.length, '正在写索引页…')
    const finalPaths = [SITE_CSS_FILE, SITE_INDEX_FILE, SITE_MARKER_FILE]
    const stale = collectStale(previousFiles, new Set([...written, ...finalPaths]))
    const finalFiles: SiteFile[] = [
      { relPath: SITE_CSS_FILE, text: buildSiteCss(tokens, appearance, snippets) },
      {
        relPath: SITE_INDEX_FILE,
        text: buildSiteIndexHtml({
          vaultName,
          pages: plan.pages,
          dangling,
          skipped,
          stale,
          renamed: plan.stats.renamed,
          tokens,
          appearance,
        }),
      },
    ]
    await ipc.siteWritePages(outputDir, finalFiles)
    for (const file of finalFiles) written.add(file.relPath)

    await ipc.siteWritePages(outputDir, [
      {
        relPath: SITE_MARKER_FILE,
        text: buildSiteMarker({
          vaultName,
          exportedAtMs: Date.now(),
          files: [...written, SITE_MARKER_FILE],
        }),
      },
    ])
    files += finalFiles.length + 1

    const result: SiteExportResult = {
      outputDir,
      pages: exportedPages,
      assets: copiedAssets,
      files,
      bytes,
      skipped,
      dangling,
      stale,
      renamed: plan.stats.renamed,
      elapsedMs: Date.now() - started,
    }
    reportSiteResult(result)
    return result
  } catch (cause) {
    notifySiteFailure(cause)
    return null
  }
}

/** 取消时的收尾：不写索引页与标记文件，如实说出已经写出去多少。 */
async function finishPartial(input: {
  outputDir: string
  files: number
  bytes: number
  pages: number
  skipped: SiteSkip[]
  dangling: string[]
  images: Set<string>
}): Promise<SiteExportResult> {
  const result: SiteExportResult = {
    outputDir: input.outputDir,
    pages: input.pages,
    assets: 0,
    files: input.files,
    bytes: input.bytes,
    skipped: input.skipped,
    dangling: input.dangling,
    stale: [],
    renamed: [],
    elapsedMs: 0,
  }
  toast.info(
    '导出已取消',
    `已经写出 ${input.files} 个文件（${input.outputDir}）。这次没有写索引页与标记文件，` +
      '所以那个目录不会被认成一份完整的导出（下次导出也不会往它里面写）——' +
      '想接着来就换一个空目录，或者先把那个目录删掉重来。',
  )
  return result
}

/** 上次写过、这次没写的文件（我们从不删除，所以它们还在目录里）。 */
function collectStale(previous: ReadonlySet<string>, written: ReadonlySet<string>): string[] {
  return [...previous]
    .filter((relPath) => !written.has(relPath))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** 悬空链接的目标（去重排序）—— 索引页会把它们列出来，"指向不存在的笔记"是要让人知道的事实。 */
function collectDangling(pages: readonly SitePage[]): string[] {
  const targets = new Set<string>()
  for (const page of pages) {
    for (const link of page.links) {
      if (link.href === null) targets.add(link.target)
    }
  }
  return [...targets].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** 设置里的 Vault CSS 片段（用户在应用里看到的样式，导出件里也该看到）。 */
function readSnippets(): Array<{ name: string; content: string }> {
  return collectSnippetCss()
}

/** 成功提示：说清导出到哪、多少页、多少图，以及**任何需要用户知道的问题**。 */
function reportSiteResult(result: SiteExportResult): void {
  const seconds = (result.elapsedMs / 1000).toFixed(1)
  const detail =
    `${result.outputDir}\n${result.pages} 篇笔记 · ${result.assets} 张图片 · ` +
    `${result.files} 个文件 · 用时 ${seconds}s\n打开那个目录里的 index.html 就能看（不需要本应用）`

  const problems: string[] = []
  if (result.skipped.length > 0) problems.push(`${result.skipped.length} 篇没能导出`)
  if (result.dangling.length > 0) problems.push(`${result.dangling.length} 个链接指向不存在的笔记`)
  if (result.renamed.length > 0) problems.push(`${result.renamed.length} 篇因撞名换了页面地址`)
  if (result.stale.length > 0) problems.push(`${result.stale.length} 个上次的文件留着没动`)

  if (problems.length > 0) {
    toast.warn('导出完成，有几点要说清', `${detail}\n${problems.join('；')}（索引页里逐条列出了）`)
    return
  }
  toast.success('已导出静态站点', detail)
}

/** 失败提示：与其它导出同一条纪律 —— 说清原因，绝不静默。 */
function notifySiteFailure(cause: unknown): void {
  // 宿主对"输出目录在 Vault 里 / 非空且不是我们导出的"写的是完整的人话，
  // 按错误码翻译会把它们统一压成"路径不合法"（见 `describeHostReason`）
  toast.error(describeHostReason(MimenoteError.from(cause), '导出静态站点失败'))
}

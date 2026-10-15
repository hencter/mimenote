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
 *
 * frontmatter 的两条覆盖（ADR-0047 §4）就落在这条流水线的"计划"一段：
 * `draft: true` 的笔记在**计划层**被摘掉（不生成页面、它的图片也不复制），`slug` / `url` 把页面
 * 搬到别处（判据与安全审查在 `domain/site-frontmatter.ts`，这里只消费结果）。请特别注意
 * **被摘掉不是失败**：草稿与被拒绝的覆盖都进 `overrides` 而不是 `skipped`，
 * 结果界面才不会把"按你的要求跳过"说成"出了错"。
 * 指向草稿的链接在渲染时改成不可点：索引不认识 `draft`，计划里的 href 仍指向那一页，
 * 而那一页不会写出去 —— 贴上原 href 就是 404。这里不另写一份"谁是草稿"的判据。
 */

import { frontmatterBody } from '@/domain/frontmatter'
import { createAssetResolver, isImageAssetTarget, type AssetEntry } from '@/domain/assets'
import { renderMarkdown, type ImageResolution } from '@/domain/markdown'
import {
  SITE_CSS_FILE,
  SITE_INDEX_FILE,
  SITE_MARKER_FILE,
  pageDir,
  siteAssetHref,
  siteRelativeHref,
} from '@/domain/site-paths'
import {
  buildSiteExportPathPlan,
  parseSiteFrontmatter,
  type SiteExportPathPlan,
} from '@/domain/site-frontmatter'
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

/**
 * frontmatter 预扫每批读多少篇（宿主的 `notes_read_batch` 上限是 64）。
 *
 * 预扫要**读完每一篇的原文**才能知道谁被 `draft` 跳过、谁用 `slug`/`url` 换了地址：
 * 宿主的计划里只有路径与链接，没有"这一页要不要导出"这个信息（计划是索引算的，
 * 索引不认识这两个字段）。代价是整库读两遍 —— 一遍预扫、一遍渲染；换来的是
 * **进度分母从一开始就是准的**（"3 / 40 篇"而不是先报 40、越导越少），以及
 * 草稿的图片一次都不会被收集。不做"边渲染边过滤"是因为那会让计划里出现"幽灵页"：
 * 链接表、反链、索引页都在按一个不存在于输出的页面算。
 */
const SITE_PRESCAN_BATCH = 24

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
  /** 同名撞页面路径、被改名的笔记（含 frontmatter 覆盖造成的改名）。 */
  renamed: Array<{ relPath: string; pagePath: string }>
  /**
   * frontmatter 覆盖的如实汇报（ADR-0047 §4）：草稿、生效的覆盖、被拒绝的、撞车的。
   *
   * 与 `skipped` 分开：草稿与"被拒绝的覆盖"**不是失败**（那一页照样导出、磁盘上什么都没动），
   * 混进 `skipped` 会让结果界面说成"N 篇没能导出"，那是假话。
   */
  overrides: SiteExportOverrides
  elapsedMs: number
}

/** 覆盖汇报的形状（索引页与结果提示共用，避免两处各列一遍字段）。 */
export interface SiteExportOverrides {
  /** 生效的覆盖：`slug` / `url` 把这一页放到了别处。 */
  applied: Array<{ relPath: string; pagePath: string; source: 'slug' | 'url' }>
  /** `draft: true` 被跳过的笔记（**磁盘上什么都没动**）。 */
  drafts: string[]
  /** 覆盖值被拒绝、退回默认路径的（含原因码，措辞由 `describeReject` 一处生成）。 */
  rejected: SiteExportPathPlan['rejected']
  /** 两个覆盖撞在同一个路径、退回默认路径的。 */
  conflicts: SiteExportPathPlan['conflicts']
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
 * 读一遍全文，只为了三件事：谁被 `draft: true` 跳过、谁用 `slug` / `url` 换了地址。
 *
 * 读不到的笔记在这里也**如实进 `skipped`**（渲染那一遍再读一次，仍然读不到也还是这条记录）：
 * 预扫是"计划之后、选目录之后"的第一步，此时报出来的失败与渲染期报出来的是同一批原因，
 * 只是早了几百毫秒 —— 早报总比晚报好读。
 */
async function prescanOverrides(pages: readonly SitePage[]): Promise<{
  notes: Array<{ relPath: string; defaultPagePath: string | null; frontmatter: ReturnType<typeof parseSiteFrontmatter> }>
  skipped: SiteSkip[]
}> {
  const notes: Array<{
    relPath: string
    defaultPagePath: string | null
    frontmatter: ReturnType<typeof parseSiteFrontmatter>
  }> = []
  const skipped: SiteSkip[] = []
  for (let offset = 0; offset < pages.length; offset += SITE_PRESCAN_BATCH) {
    const batch = pages.slice(offset, offset + SITE_PRESCAN_BATCH)
    const read = await readBatch(batch.map((page) => page.relPath))
    skipped.push(...read.skipped)
    for (const page of batch) {
      const text = read.items.get(page.relPath)
      // 读不到的那一篇留给渲染期报（这里报一次、那里再报一次就成了两条重复记录）
      if (text === undefined) continue
      notes.push({
        relPath: page.relPath,
        defaultPagePath: page.pagePath,
        frontmatter: parseSiteFrontmatter(text),
      })
    }
  }
  return { notes, skipped }
}

/**
 * 把一页的出链 href 按**最终路径**重算（只有被覆盖改过路径的页需要）。
 *
 * 为什么必须重算：宿主算出来的 href 是"从原来的页面路径出发"的相对链接
 * （`mn_index::resolve_target` 只管"谁指向谁"，相对路径是顺手算的）。这一页被
 * `slug` / `url` 搬到别处之后，那些 `../` 的层数就不再成立 —— 不重算的话，
 * 改一个地址会让这一页里所有链接变成 404。
 *
 * 做法上只有最后一小步是自己的判断，前面全是复用：
 * * `link.href` 是宿主解析并编码好的站内相对地址 —— 它锚在**本页的目录**里，
 *   所以"`../` 走几层 + 文件名"拆出来的就是目标页面的**默认输出路径**（可能与磁盘文件名不同，
 *   因为 href 里是百分号编码，要解一次编码才认得回文件名）；
 * * 默认输出路径 → **最终**输出路径：一张由计划与覆盖表合出来的表（没有覆盖时是恒等映射），
 *   于是"被覆盖改名的那一页"的链接自动落到新地址上；
 * * 相对路径那一段算术是 `domain/site-paths.ts` 里那一份（与图片、反向链接、索引页同一个函数）。
 *
 * 为什么不直接拿 `link.target` 去覆盖表里查：覆盖表的键是**笔记路径**，而 `link.target` 是作者
 * 在正文里写的 wikilink 文字（`[[甲]]` 的 `甲`）—— 它们只在"这一篇是那一篇"这件事上等价。
 * 链接怎么解析成哪一篇仍然只有索引那一份，这里只把它已经给出的答案换算成新的相对路径。
 */
function linkHrefsForPage(
  plan: {
    /** 计划里的**默认**输出路径 → 这一页最终的输出路径（没被覆盖的映射到它自己）。 */
    finalPathOf: ReadonlyMap<string, string>
    /**
     * 默认输出路径里、这一轮不会写出去的那些（目前只有 `draft: true`）。
     *
     * 索引算出的 href 在草稿上仍是非空的：它只知道"这篇笔记存在"。导出层已经决定不写那一页，
     * 若仍贴上 href，站点里就是一条 404。改成 `null` 走既有的"不可点"渲染，
     * 并且**不**把目标报成"还不存在的笔记"——草稿是作者要求跳过的，索引页另有一节。
     */
    unpublished: ReadonlySet<string>
  },
  page: SitePage,
): Map<string, string | null> {
  const hrefs = new Map<string, string | null>()
  for (const link of page.links) {
    const key = `${link.target}\u0000${link.anchor ?? ''}`
    // 宿主给的 href 锚在**本页原来的目录**里，且是百分号编码的默认输出路径；
    // 解回站内路径之后才能去查"它最终落在哪"（覆盖表按最终路径组织）。
    const defaultPath = link.href === null ? null : outputPathOfHref(page.pagePath, link.href)
    if (defaultPath !== null && plan.unpublished.has(defaultPath)) {
      hrefs.set(key, null)
      continue
    }
    const target = defaultPath === null ? undefined : plan.finalPathOf.get(defaultPath)
    if (link.href === null || target === undefined) {
      hrefs.set(key, link.href)
      continue
    }
    hrefs.set(key, siteRelativeHref(page.pagePath, target, link.anchor))
  }
  return hrefs
}

/**
 * 一个站内相对 href 指向的输出路径（从 `fromPage` 出发解回绝对站内路径）。
 *
 * `#frag`（指向本页本身）返回 `null`：`siteRelativeHref` 只在同页时生成它，
 * 那时"目标"就是本页，重算的结果必然还是 `#frag`，不需要也不该去查表。
 * 解不出来的段（`decodeURIComponent` 抛异常的病态输入）返回 `null` → 退回宿主给的 href。
 */
function outputPathOfHref(fromPage: string, href: string): string | null {
  const fragmentAt = href.indexOf('#')
  const withoutFragment = fragmentAt === -1 ? href : href.slice(0, fragmentAt)
  if (withoutFragment === '') return null
  const segments = (pageDir(fromPage) === '' ? [] : pageDir(fromPage).split('/')).filter(
    (segment) => segment !== '',
  )
  for (const segment of withoutFragment.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    try {
      segments.push(decodeURIComponent(segment))
    } catch {
      segments.push(segment)
    }
  }
  return segments.length === 0 ? null : segments.join('/')
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

    // frontmatter 预扫：`draft: true` 在这里就被摘掉（**计划层过滤**，磁盘上一个字节都不动），
    // `slug` / `url` 在这里换算成最终路径。之后的每一步（渲染、图片、索引页、标记文件）
    // 都只看 `path` 这一份结果 —— 判据只有 `domain/site-frontmatter.ts` 那一份。
    const prescan = await prescanOverrides(plan.pages)
    const path = buildSiteExportPathPlan(prescan.notes)
    if (path.pages.length === 0) {
      if (path.drafts.length === plan.pages.length) {
        toast.info(
          '这个 Vault 里没有可导出的笔记',
          `计划里有 ${plan.pages.length} 篇，但全部是草稿（\`draft: true\`）—— 一页都不会写出去`,
        )
      } else {
        // 一篇都没剩下、又不是全草稿 —— 那是"读不出来"，结果界面在别处已经拦过（计划为空），
        // 这里只是不让它静默地写一个空站点出去
        toast.warn('这次没有可导出的页面', '计划里的笔记都没能读出来，先看看是不是文件被移走了')
      }
      return null
    }

    // 按笔记路径查页面（O(1)）：下面的每一步都在这张表上做，别再线性找
    const pageOfNote = new Map(plan.pages.map((page) => [page.relPath, page]))
    const exportedNotes = new Set(path.pages.map((item) => item.relPath))
    const pages = path.pages.flatMap((item) => {
      const page = pageOfNote.get(item.relPath)
      if (page === undefined) return []
      // 反链名单来自索引，里面可以有草稿。草稿页不会写出去，留着就会在页脚链到一个不存在的 HTML
      // （渲染侧查不到路径时会丢掉 `<li>`，但标题上的计数仍把它算进去）。
      return [
        {
          ...page,
          pagePath: item.pagePath,
          backlinks: page.backlinks.filter((from) => exportedNotes.has(from)),
        },
      ]
    })
    prepareSiteRender(pages, path.overrides)
    const overrides: SiteExportOverrides = {
      applied: path.pages
        .filter((item) => path.overrides.has(item.relPath))
        .map((item) => ({
          relPath: item.relPath,
          pagePath: item.pagePath,
          // 覆盖来源按**最终路径**记（`pathSource` 的键就是它），查不到只可能是覆盖表被改过
          source: path.pathSource.get(item.pagePath) ?? 'slug',
        })),
      drafts: path.drafts,
      rejected: path.rejected,
      conflicts: path.conflicts,
    }
    // 出链重算要的一张查表：计划里的**默认**输出路径 → 这一页**最终**的输出路径。
    // 在计划上贴一层覆盖就够（没被覆盖的映射到自己），只算一次 —— 它的内容与批次无关。
    // `unpublished` 是草稿的默认输出路径：链接解析仍认它存在，但这一轮不会写那个文件。
    const draftNotes = new Set(path.drafts)
    const rewire = {
      finalPathOf: new Map(
        plan.pages.map((page) => [page.pagePath, path.overrides.get(page.relPath) ?? page.pagePath]),
      ),
      unpublished: new Set(
        plan.pages.filter((page) => draftNotes.has(page.relPath)).map((page) => page.pagePath),
      ),
    }

    const previousFiles = new Set(plan.previous?.files ?? [])
    const written = new Set<string>()
    const entries = useVaultStore.getState().entries
    // 预扫读不到的那几篇先记下（渲染那一遍还会读到同一条失败，去重见下）
    const skipped: SiteSkip[] = [...prescan.skipped]
    const images = new Set<string>(plan.assets)
    const { tokens, appearance } = readExportTokens()
    const snippets = readSnippets()
    const dangling = collectDangling(pages)

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

    for (let offset = 0; offset < pages.length; offset += SITE_EXPORT_BATCH) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        return await finishPartial({
          outputDir,
          files,
          bytes,
          pages: exportedPages,
          skipped,
          dangling,
          images,
          overrides,
        })
      }
      const batch = pages.slice(offset, offset + SITE_EXPORT_BATCH)
      options.onProgress?.(
        offset,
        pages.length,
        `正在导出 ${offset + batch.length} / ${pages.length} 篇…`,
      )
      await yieldToUi()

      const read = await readBatch(batch.map((page) => page.relPath))
      skipped.push(...read.skipped)

      const rendered = new Map<string, string>()
      for (const page of batch) {
        const text = read.items.get(page.relPath)
        if (text === undefined) continue
        const linkHrefs = linkHrefsForPage(rewire, page)
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
          pages.length,
          pages.length,
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
    options.onProgress?.(pages.length, pages.length, '正在写索引页…')
    const finalPaths = [SITE_CSS_FILE, SITE_INDEX_FILE, SITE_MARKER_FILE]
    const stale = collectStale(previousFiles, new Set([...written, ...finalPaths]))
    // 唯一需要合并而不是覆盖的一处：宿主自己算出的撞名清单 + 覆盖造成的改名。
    // 两边都按 `relPath` 排序过，所以合并后再排一次就与"从头到尾只有一个来源"等价。
    const renamed = uniqueRenames([...plan.stats.renamed, ...path.renamed])
    const finalFiles: SiteFile[] = [
      { relPath: SITE_CSS_FILE, text: buildSiteCss(tokens, appearance, snippets) },
      {
        relPath: SITE_INDEX_FILE,
        text: buildSiteIndexHtml({
          vaultName,
          pages,
          dangling,
          skipped: uniqueByRelPath(skipped),
          stale,
          renamed,
          overrides,
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
      skipped: uniqueByRelPath(skipped),
      dangling,
      stale,
      renamed,
      overrides,
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
  overrides: SiteExportOverrides
}): Promise<SiteExportResult> {
  const result: SiteExportResult = {
    outputDir: input.outputDir,
    pages: input.pages,
    assets: 0,
    files: input.files,
    bytes: input.bytes,
    skipped: uniqueByRelPath(input.skipped),
    dangling: input.dangling,
    stale: [],
    renamed: [],
    overrides: input.overrides,
    elapsedMs: 0,
  }
  const drafts =
    input.overrides.drafts.length === 0 ? '' : `；另有 ${input.overrides.drafts.length} 篇草稿没导出`
  toast.info(
    '导出已取消',
    `已经写出 ${input.files} 个文件（${input.outputDir}）${drafts}。这次没有写索引页与标记文件，` +
      '所以那个目录不会被认成一份完整的导出（下次导出也不会往它里面写）——' +
      '想接着来就换一个空目录，或者先把那个目录删掉重来。',
  )
  return result
}

/**
 * 按笔记路径去重（保留第一次出现的记录）。
 *
 * 为什么需要：预扫与渲染各读了一遍全文，读不到的那一篇**两遍都会失败** ——
 * 不去重的话索引页会把同一篇"没能导出"列两次，而"重复计数"正是这类清单最容易失去信任的方式。
 */
function uniqueByRelPath(items: readonly SiteSkip[]): SiteSkip[] {
  const seen = new Set<string>()
  const out: SiteSkip[] = []
  for (const item of items) {
    if (seen.has(item.relPath)) continue
    seen.add(item.relPath)
    out.push(item)
  }
  return out
}

/** 当前一轮的改名清单（宿主算的撞名 + 覆盖造成的改名，同一篇只留一条）。 */
function uniqueRenames(
  items: readonly { relPath: string; pagePath: string }[],
): Array<{ relPath: string; pagePath: string }> {
  const byPath = new Map<string, { relPath: string; pagePath: string }>()
  for (const item of items) byPath.set(item.relPath, item)
  return [...byPath.values()].sort((left, right) => compareText(left.relPath, right.relPath))
}

/** 与导出流程其它地方的排序逐字一致（码元序，不用 `localeCompare` —— 它随系统语言变）。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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
  if (result.overrides.drafts.length > 0) {
    problems.push(`${result.overrides.drafts.length} 篇是草稿（draft: true），没有导出`)
  }
  if (result.overrides.rejected.length > 0) {
    problems.push(`${result.overrides.rejected.length} 处 slug/url 覆盖被拒绝，用了默认地址`)
  }
  if (result.overrides.conflicts.length > 0) {
    problems.push(`${result.overrides.conflicts.length} 处覆盖撞在同一个路径上`)
  }
  if (result.overrides.applied.length > 0) {
    // 不是问题，只是"地址与默认不一样"这件事实得说出来（有人按目录找过去会找不到）
    problems.push(`${result.overrides.applied.length} 篇按 frontmatter 换了页面地址`)
  }
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

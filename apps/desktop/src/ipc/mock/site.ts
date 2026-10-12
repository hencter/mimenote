/**
 * ipc/mock/site.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * 站点导出计划与导出辅助 —— Mock 侧的镜像（判据在 `domain/site-paths.ts`）。
 */
import type { MockHost } from './host'
import { extensionOf, isMarkdown } from '@/domain/paths'
import { createMockResolver, mockExtractLinks } from './links'

import { MOCK_VAULT_PATH } from './model'
import type { MockNote } from './model'
import { mockExtractTags, mockNormalizeTag, mockParseFrontmatter } from './tags'
import { wikilinkDisplayText } from '@/domain/links'
import { assignPagePaths, encodeUrlPath, siteRelativeHref } from '@/domain/site-paths'
import type {
  ExportWriteOutcome,
  SiteAssetInput,
  SiteAssetOutcome,
  SiteFile,
  SitePage,
  SitePlan,
  SiteSkip,
  SiteWriteOutcome,
} from '@/ipc/types'


export const MOCK_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

/** 导出文件扩展名白名单（与宿主 `ALLOWED_EXPORT_EXTENSIONS` 一致）。 */
export const MOCK_EXPORT_EXTENSIONS: readonly string[] = ['html', 'htm']

/**
 * 站点文件的扩展名白名单（与宿主 `site_export.rs` 的 `ALLOWED_SITE_EXTENSIONS` 一致）。
 *
 * 与单篇导出的区别：整库导出还要写一份共享样式表与一个标记文件，所以多了 `.css` / `.json`；
 * 但仍然**不含 `.md`** —— 这条命令是"往一个目录里写很多文件"，白名单就是它的能力边界。
 */
export const MOCK_SITE_FILE_EXTENSIONS: readonly string[] = ['html', 'css', 'json']

/** 导出大小上限（与宿主 `MAX_EXPORT_BYTES` 一致）。 */
export const MOCK_MAX_EXPORT_BYTES = 32 * 1024 * 1024

/** 字节 → 标准 base64（Mock 里用 `btoa` 即可，不追求大文件性能）。 */
export function mockBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 取小写扩展名（不含点）；没有扩展名返回空串。 */
// ---------------------------------------------------------------------------
// Mock 的附件写入（`attachment_save`）
//
// 权威实现在 Rust 侧（`src-tauri/src/attachments.rs`，见 ADR-0013），这里只镜像**能观察到的
// 行为**：白名单、三道上限、命名去重、附件目录、返回契约。之所以要镜像而不是"随便返回个成功"：
// UI 层 E2E 与组件测试都跑在这个适配器上，"Mock 说成功、真实宿主却拒绝"是最难查的一类假绿
// （与 `asset_read_base64` / `export_write_html` 两个 Mock 分支同一约定）。
// ---------------------------------------------------------------------------

/** 一次最多接受的张数（与宿主 `MAX_ATTACHMENTS_PER_REQUEST` 一致）。 */
export interface MockSitePage {
  relPath: string
  pagePath: string
  urlPath: string
  links: Array<{ target: string; anchor: string | null; href: string | null; display: string }>
  backlinks: string[]
}

export function buildMockSitePlan(files: Map<string, MockNote>): MockSitePage[] {
  const resolver = createMockResolver(files)
  const notes = [...files.keys()].filter((rel) => isMarkdown(rel)).sort()
  const { pageOf } = assignPagePaths(notes)

  return notes.flatMap((rel) => {
    const pagePath = pageOf.get(rel)
    if (pagePath === undefined) return []
    const note = files.get(rel)
    const links = (note === undefined ? [] : mockExtractLinks(note.text)).map((link) => {
      const resolved = resolver(rel, link.rawTarget)
      const targetPage = resolved.path === null ? undefined : pageOf.get(resolved.path)
      return {
        target: link.rawTarget,
        anchor: link.anchor,
        href:
          targetPage === undefined
            ? null
            : siteRelativeHref(pagePath, targetPage, link.anchor ?? null),
        display: wikilinkDisplayText({
          target: link.rawTarget,
          alias: link.alias,
          anchor: link.anchor,
        }),
      }
    })
    const backlinks = notes.filter((from) => {
      if (from === rel) return false
      const other = files.get(from)
      if (other === undefined) return false
      return mockExtractLinks(other.text).some((link) => resolver(from, link.rawTarget).path === rel)
    })
    return [{ relPath: rel, pagePath, urlPath: encodeUrlPath(pagePath), links, backlinks }]
  })
}

/**
 * `export_site_plan` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function exportSitePlan(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          // 整库导出的计划（ADR-0019 的 Mock 镜像）：页面表、每页的出链 href（相对本页）、
          // 反向链接、标签与统计。刻意**不去动文件系统**：目标目录的预检在真宿主里做
          // （那里才有真实路径），这里只在给了一个明显落在 Mock Vault 里面的目录时拒绝 ——
          // 这条判定是整库导出最重要的一条安全规则，浏览器预览里也要能看见它生效。
          const rawDir = a.outputDir === null || a.outputDir === undefined ? null : String(a.outputDir)
          if (rawDir !== null) {
            const normalized = rawDir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
            const vault = MOCK_VAULT_PATH.replaceAll('\\', '/').toLowerCase()
            if (normalized === vault || normalized.startsWith(`${vault}/`)) {
              host.fail(
                'PATH_INVALID',
                `输出目录不能放在 Vault 里面（${rawDir}）：导出会写出上千个文件，而 Vault 里的任何改动都会触发重扫，同步盘还会把整站上传一遍`,
              )
            }
          }

          const built = buildMockSitePlan(files)
          // 标题与标签的口径**必须与图谱卡片一致**（frontmatter `title` 优先，其次文件名主干；
          // 标签按归一化键去重后按字典序排、值是首次出现的写法）—— 这里刻意照抄 `graph_data`
          // 分支的那两行推导，两处不一致的话"页面标题"和"卡片标题"会各说各话。
          const titleOf = (rel: string): string => {
            const note = files.get(rel)
            const frontmatter = note === undefined ? null : mockParseFrontmatter(note.text)
            const titleField = frontmatter?.fields.find((field) => field.key === 'title')
            return titleField !== undefined && titleField.value.kind === 'scalar'
              ? titleField.value.value
              : (rel.split('/').pop() ?? rel).replace(/\.(md|markdown)$/i, '')
          }
          const tagKeysOf = (rel: string): string[] => {
            const note = files.get(rel)
            const byKey = new Map<string, string>()
            for (const tag of note === undefined ? [] : mockExtractTags(note.text)) {
              const key = mockNormalizeTag(tag.tag)
              if (key !== '' && !byKey.has(key)) byKey.set(key, tag.tag)
            }
            return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, raw]) => raw)
          }
          const pages: SitePage[] = built.map((page) => ({
            ...page,
            title: titleOf(page.relPath),
            tags: tagKeysOf(page.relPath),
          }))
          const payload: SitePlan = {
            vaultName: MOCK_VAULT_PATH.split('\\').pop() ?? 'MockVault',
            outputDir: rawDir,
            previous: null,
            pages,
            stats: {
              notes: pages.length,
              pages: pages.length,
              links: pages.reduce((sum, page) => sum + page.links.length, 0),
              dangling: pages.reduce(
                (sum, page) => sum + page.links.filter((link) => link.href === null).length,
                0,
              ),
              assets: 0,
              renamed: [],
            },
            assets: [],
          }
          return payload
}

/**
 * `export_site_write_pages` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function exportSiteWritePages(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { siteFiles, validate } = host
          // 站点落盘的 Mock 镜像：**只记账**（浏览器里没有真实文件系统）。
          // 白名单与路径校验照样做：`ui.e2e` 跑在这个适配器上，"Mock 说成功、真实宿主却拒绝"
          // 是最难查的一类假绿（与 `attachment_save` / `export_write_html` 两个分支同一约定）。
          const rawDir = String(a.outputDir ?? '')
          if (rawDir.trim() === '') host.fail('PATH_INVALID', '输出目录为空')
          const requested = Array.isArray(a.files) ? a.files : []
          if (requested.length > 256) {
            host.fail('TOO_LARGE', `一批最多写 256 个文件（本次 ${requested.length} 个）`)
          }
          const createdDirs = new Set<string>()
          let bytes = 0
          for (const raw of requested) {
            const entry = (raw ?? {}) as Partial<SiteFile>
            const rel = String(entry.relPath ?? '')
            validate(rel)
            const ext = extensionOf(rel)
            if (!MOCK_SITE_FILE_EXTENSIONS.includes(ext)) {
              host.fail('PATH_INVALID', `站点文件只允许写 ${MOCK_SITE_FILE_EXTENSIONS.map((item) => `.${item}`).join(' / ')}（收到 .${ext || '无扩展名'}）`)
            }
            const text = String(entry.text ?? '')
            bytes += new TextEncoder().encode(text).length
            siteFiles.set(rel, text)
            const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
            if (dir !== '') createdDirs.add(dir)
          }
          const payload: SiteWriteOutcome = {
            outputDir: rawDir,
            files: requested.length,
            bytes,
            writtenInMs: 1,
            createdDirs: [...createdDirs].sort(),
          }
          return payload
}

/**
 * `export_site_copy_assets` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function exportSiteCopyAssets(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, binaries, siteFiles } = host
          const rawDir = String(a.outputDir ?? '')
          if (rawDir.trim() === '') host.fail('PATH_INVALID', '输出目录为空')
          const requested = Array.isArray(a.assets) ? a.assets : []
          if (requested.length > 512) {
            host.fail('TOO_LARGE', `一次最多复制 512 张图片（本次 ${requested.length} 张）`)
          }
          const skipped: SiteSkip[] = []
          const createdDirs = new Set<string>()
          let copied = 0
          let bytes = 0
          for (const raw of requested) {
            const entry = (raw ?? {}) as Partial<SiteAssetInput>
            const rel = String(entry.vaultRelPath ?? '')
            const ext = extensionOf(rel)
            if (MOCK_IMAGE_MIMES[ext] === undefined) {
              skipped.push({ relPath: rel, reason: 'unsupported-type', message: '不是 Vault 支持的图片类型' })
              continue
            }
            if (!files.has(rel) && !binaries.has(rel)) {
              skipped.push({ relPath: rel, reason: 'not-found', message: '图片不存在' })
              continue
            }
            copied += 1
            bytes += binaries.get(rel)?.length ?? new TextEncoder().encode(files.get(rel)?.text ?? '').length
            siteFiles.set(`assets/${rel}`, '（Mock：图片字节已在宿主侧复制）')
            createdDirs.add('assets')
          }
          const payload: SiteAssetOutcome = {
            copied,
            bytes,
            createdDirs: [...createdDirs].sort(),
            skipped,
          }
          return payload
}

/**
 * `export_write_html` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function exportWriteHtml(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
          // 导出落盘（`export_write_html` 的 Mock 镜像）：**不写真实文件**，只回显契约形状；
          // 扩展名与大小上限与宿主保持一致，免得测试绿得毫无意义。
          const path = String(a.path ?? '')
          const html = String(a.html ?? '')
          const sizeBytes = new TextEncoder().encode(html).length
          if (
            path === '' ||
            !MOCK_EXPORT_EXTENSIONS.includes(extensionOf(path.replaceAll('\\', '/')))
          ) {
            host.fail('PATH_INVALID', `导出只允许写 .html/.htm：${path}`)
          }
          if (sizeBytes > MOCK_MAX_EXPORT_BYTES) {
            host.fail('TOO_LARGE', `导出内容过大：${sizeBytes} 字节`)
          }
          const payload: ExportWriteOutcome = {
            absolutePath: path,
            sizeBytes,
            writtenInMs: 1,
          }
          return payload
}

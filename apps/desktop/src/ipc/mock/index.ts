/**
 * ipc/mock/index.ts：Mock 适配器的**装配与分发**。
 *
 * 为什么 case 全部留在这一个文件：`scripts/check-ipc.mjs` 的 mock 侧判据是「在 TS_MOCK 指向的
 * 文件里数 `case '命令名'`」，43 条命令的名字必须与 Rust `generate_handler!`、`ipc/client.ts`
 * 三方一致。所以这里只放**薄分发**（一行调一个域处理体），处理体在各领域模块里 ——
 * 这既让文件体积达标，也没有动那个判据。
 *
 * ## Mock 与"权威判据"的差异清单（B11）
 *
 * 架构体检点名过的最严重问题是"Mock 成了第三个领域实现"。能收敛的都收敛了，**剩下的差异
 * 是刻意的**，逐条列在这里，免得后来者以为是漏改：
 *
 * | 判据 | 现在复用谁 | 仍然不同的地方 |
 * | --- | --- | --- |
 * | 扩展名 / 是否 Markdown | `domain/paths.ts` 的 `isMarkdown`、`extensionOf` | 无（原先 mock 自己写了两份） |
 * | 标签名字符 | `domain/inline-tags.ts` 的 `isInlineTagChar` | Mock 额外做**文档级遮蔽**（围栏代码 / HTML 注释 / 行内代码 / 转义），domain 的行内扫描器把这件事留给调用方 |
 * | 附件命名与上限 | `domain/attachments.ts`（`uniqueAttachmentName`、`MAX_*`） | 无 |
 * | 资源类型判定 | `domain/assets.ts` 的 `isImageAssetTarget` | 无 |
 * | 站点路径与 URL 编码 | `domain/site-paths.ts` 的 `assignPagePaths` / `encodeUrlPath` | Mock 的页面表是内存记账，不落盘 |
 * | wikilink 词法 | `domain/links.ts` 的 `splitWikilink` / `normalizeLinkTarget` | 链接**抽取与改写**是 `mn-core::links` 的简化镜像（domain 没有完整抽取器） |
 * | frontmatter 解析 | —— | Mock 需要**行号**（`FrontmatterField.line`），`domain/frontmatter-edit.ts` 的 `parseMetadata` 只回字段值；两边形状不同，未合并 |
 * | 全文搜索打分 / 片段 | —— | 权威实现只有 Rust 的 FTS5；Mock 的 `mockSearchScore` 是占位近似，不是 bm25 |
 */
import { createMockHost } from './host'
import type { MockAdapter, MockAdapterOptions } from './model'
import * as vault from './vault'
import * as notes from './notes'
import * as trash from './trash'
import * as dirs from './dirs'
import * as tagOps from './tag-ops'
import * as graph from './graph'
import * as assets from './assets'
import * as site from './site'
import * as config from './config'
import * as search from './search'

export { MOCK_VAULT_PATH } from './model'

export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  const host = createMockHost(options)
  const { fail } = host
  return {
    kind: 'mock',
    dump: () => [...host.files.values()].map((note) => ({ ...note })),
    simulateExternalEdit: (relPath, text) => {
      const existing = host.files.get(relPath)
      if (existing === undefined) return
      host.files.set(relPath, { relPath, text })
      host.mtimes.set(relPath, host.touch())
    },
    simulateTrashFileGone: (id) => {
      // 只把「回收站里的那个文件」拿走（`removedTexts`），台账（`trashed`）原样留着 ——
      // 这正是孤儿记录的定义，也是永久删除里 `missing` 那一路的来路
      host.removedTexts.delete(id)
    },
    trashCalls: host.trashCalls,
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      const a = args ?? {}
      switch (method) {
        case 'vault_open':
        case 'vault_snapshot':
          return (await vault.vaultSnapshotOrOpen(host, a)) as T
        case 'vault_info':
          return (await vault.vaultInfo(host, a)) as T
        case 'vault_close':
          return (await vault.vaultClose(host, a)) as T
        case 'startup_vault':
          return (await vault.startupVault(host, a)) as T
        case 'index_status':
          return (await vault.indexStatus(host, a)) as T
        case 'note_links':
          return (await notes.noteLinks(host, a)) as T
        case 'note_read':
          return (await notes.noteRead(host, a)) as T
        case 'note_write':
          return (await notes.noteWrite(host, a)) as T
        case 'note_create':
          return (await notes.noteCreate(host, a)) as T
        case 'note_delete':
          return (await notes.noteDelete(host, a)) as T
        case 'trash_list':
          return (await trash.trashList(host, a)) as T
        case 'trash_delete':
          return (await trash.trashDelete(host, a)) as T
        case 'trash_empty':
          return (await trash.trashEmpty(host, a)) as T
        case 'note_restore':
          return (await trash.noteRestore(host, a)) as T
        case 'note_rename':
          return (await notes.noteRename(host, a)) as T
        case 'note_move':
          return (await notes.noteMove(host, a)) as T
        case 'dir_rename':
          return (await dirs.dirRename(host, a)) as T
        case 'dir_move':
          return (await dirs.dirMove(host, a)) as T
        case 'note_set_tags':
          return (await tagOps.noteSetTags(host, a)) as T
        case 'tag_rename':
          return (await tagOps.tagRename(host, a)) as T
        case 'tag_move':
          return (await tagOps.tagMove(host, a)) as T
        case 'note_tags':
          return (await tagOps.noteTags(host, a)) as T
        case 'tags_list':
          return (await tagOps.tagsList(host, a)) as T
        case 'tag_notes':
          return (await tagOps.tagNotes(host, a)) as T
        case 'tag_filter':
          return (await tagOps.tagFilter(host, a)) as T
        case 'search_query':
          return (await search.searchQuery(host, a)) as T
        case 'graph_data':
          return (await graph.graphData(host, a)) as T
        case 'graph_ego':
          return (await graph.graphEgo(host, a)) as T
        case 'asset_authorize':
          return (await assets.assetAuthorize(host, a)) as T
        case 'asset_read_base64':
          return (await assets.assetReadBase64(host, a)) as T
        case 'attachment_save':
          return (await assets.attachmentSave(host, a)) as T
        case 'export_site_plan':
          return (await site.exportSitePlan(host, a)) as T
        case 'notes_read_batch':
          return (await notes.notesReadBatch(host, a)) as T
        case 'export_site_write_pages':
          return (await site.exportSiteWritePages(host, a)) as T
        case 'export_site_copy_assets':
          return (await site.exportSiteCopyAssets(host, a)) as T
        case 'export_write_html':
          return (await site.exportWriteHtml(host, a)) as T
        case 'snippets_list':
          return (await config.snippetsList(host, a)) as T
        case 'note_stats':
          return (await notes.noteStats(host, a)) as T
        case 'config_read':
          return (await config.configRead(host, a)) as T
        case 'config_write':
          return (await config.configWrite(host, a)) as T
        case 'templates_list':
          return (await config.templatesList(host, a)) as T
        case 'version_info':
          return (await config.versionInfo(host, a)) as T
        default:
          return fail('INTERNAL', `Mock 适配器未实现命令：${method}`)
      }
    },
  }
}

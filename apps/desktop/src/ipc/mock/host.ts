/**
 * ipc/mock/host.ts：一份内存 Mock 宿主的**状态与共用辅助**（从 createMockAdapter 的闭包里搬出）。
 *
 * 命令的处理体在各领域模块（vault/notes/tags…），它们只通过这个对象读写状态 ——
 * 于是「Mock 的状态」有唯一一份，跨命令的共享逻辑（回收站台账、目录重映射、
 * 标签全库改写）也不会各自复制一份。
 */
import { createMockResolver, mockExtractLinks } from './links'

import { DEFAULT_NOTES, MOCK_VAULT_PATH,  } from './model'
import type { MockAdapter, MockAdapterOptions, MockNote } from './model'
import { mockRenameTags } from './tag-rename'
import type { MockTagMapping } from './tag-rename'
import { mockExtractTags, mockNormalizeTag, mockParseFrontmatter } from './tags'
import { isMarkdown, parentOf } from '@/domain/paths'
import { MimenoteError } from '@/ipc/types'
import type {EntryMeta, ErrorCode, GraphData, GraphEdge, GraphNode, PurgeSummary, TagRenameFile, TagRenameOutcome, TagRenameSkip, TrashRecord} from '@/ipc/types'

/**
 * 一份内存 Mock 宿主的全部状态与共用辅助。
 *
 * 为什么把闭包状态变成显式对象：43 条命令的处理体原先都关在 createMockAdapter 的闭包里，
 * 「哪一条命令碰了哪些状态」只能靠通读 3000 行；变成显式 MockHost 之后，每个域模块在
 * 第一行就写清自己用了什么，跨域共享的辅助（目录重映射、回收站台账、标签全库改写）
 * 也只有一份实现。
 */
export interface MockHost {
  rootPath: string
  writeLatencyMs: number
  /** `startup_vault` 命令要回显的「命令行指定的 Vault」。 */
  startupVaultPath: string | undefined
  files: Map<string, MockNote>
  dirs: Set<string>
  binaries: Map<string, Uint8Array>
  configContent: string | null
  configFormat: 'toml' | 'yaml' | 'json' | null
  trashed: TrashRecord[]
  removedTexts: Map<string, string>
  trashDirs: Set<string>
  siteFiles: Map<string, string>
  presentInTrash: (record: TrashRecord) => boolean
  trashCalls: MockAdapter['trashCalls']
  touch: () => number
  seed: (list: MockNote[]) => void
  graphDataOf: () => GraphData
  mtimes: Map<string, number>
  mtimeOf: (relPath: string) => number
  entries: () => EntryMeta[]
  noteCount: () => number
  insideDir: (rel: string, dir: string) => boolean
  remapPrefix: (rel: string, oldDir: string, newDir: string) => string
  relocateTree: (oldDir: string, newDir: string) => Array<{ from: string; to: string }>
  remapDirs: (oldDir: string, newDir: string) => void
  fail: (code: ErrorCode, message: string) => never
  validate: (relPath: string) => void
  sleep: () => Promise<void>
  purgeTrashEntries: (indices: number[]) => PurgeSummary
  rewriteTagsAcrossVault: (mapping: MockTagMapping, fromDisplay: string, dryRun: boolean) => TagRenameOutcome
}

export function createMockHost(options: MockAdapterOptions = {}): MockHost {
  const rootPath = options.rootPath ?? MOCK_VAULT_PATH
  const writeLatencyMs = options.writeLatencyMs ?? 0
  const files = new Map<string, MockNote>()
  const dirs = new Set<string>()
  /**
   * 二进制附件（图片）单独存一张表：`files` 里的 `text` 是"笔记正文"，全文搜索、链接抽取、
   * 标签抽取都按它遍历 —— 把二进制塞进去等于让这些路径也开始处理图片。
   */
  const binaries = new Map<string, Uint8Array>()
  /**
   * Vault 配置文件（ADR-0055）的内容。
   *
   * Mock 没有真实文件系统，但"写一份配置再读回来"这条链路必须能被测到 ——
   * 否则前端的分层（localStorage 迁移 → config.toml → 覆盖生效）在浏览器预览与
   * UI 层测试里全是空转。初始 `null` = 还没有配置文件（首次打开 Vault 会迁移生成）。
   */
  let configContent: string | null = null
  let configFormat: 'toml' | 'yaml' | 'json' | null = null
  const trashed: TrashRecord[] = []
  /**
   * 回收站里那些文件的**内容**（`id → text`）：Mock 没有真文件系统，
   * 但"恢复后内容逐字回来"要成立。
   *
   * 它同时是"东西还在不在回收站里"的**唯一真相**（见 `presentInTrash`）：
   * `trashed` 是台账，`removedTexts` 才是回收站里真躺着的文件。两者分开正是真实世界里
   * 的状态（台账是 JSONL，文件在 `.mimenote/trash`），孤儿记录就是"台账有、这里没有"。
   */
  const removedTexts = new Map<string, string>()
  /** 被删/被恢复时"曾经存在过的目录"：Mock 用了扁平的文件表，目录需要单独记一笔。 */
  const trashDirs = new Set<string>()
  /**
   * 整库导出"写出去"的站点文件（站内相对路径 → 内容）。
   *
   * Mock 没有真实文件系统，但测试要能断言"这次导出到底写了哪些页面、`index.html` 排在第几个"，
   * 所以在这里记账。浏览器预览模式下前端根本走不到这一步（没有系统目录选择框），
   * 这个表只服务于测试与"契约保持完整"。
   */
  const siteFiles = new Map<string, string>()
  /**
   * 台账里这条记录的东西**现在还在不在**回收站里（`simulateTrashFileGone` 之外的唯一真相
   * 是 `removedTexts`）。
   */
  const presentInTrash = (record: TrashRecord): boolean => removedTexts.has(record.id)
  /** 收到的永久删除调用（见 `MockAdapter.trashCalls`）。 */
  const trashCalls: MockAdapter['trashCalls'] = []
  let clock = Date.now()

  const touch = (): number => {
    clock += 1
    return clock
  }

  const seed = (list: MockNote[]): void => {
    files.clear()
    dirs.clear()
    binaries.clear()
    for (const note of list) {
      files.set(note.relPath, { relPath: note.relPath, text: note.text })
      const parts = note.relPath.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? part : `${acc}/${part}`
        dirs.add(acc)
      }
    }
  }
  seed(options.notes ?? DEFAULT_NOTES)

  /**
   * 图谱的 Mock 镜像（权威实现在 Rust 的链接索引里）：节点 = Markdown 笔记，
   * 边 = 抽取出的链接（resolved / 悬空都保留），按 (from, to) 去重后累加 count。
   *
   * 抽成函数是为了让 `graph_data` 与 `graph_ego` 共用**同一份投影**：自我中心子图只是它上面的
   * 一个子集（与宿主 `Scope::All` / `Scope::Only(kept)` 同一个口径）。两份实现迟早会让
   * "浏览器里说这篇连着 5 篇、真机上只有 3 篇"。
   */
  const graphDataOf = (): GraphData => {
    const resolver = createMockResolver(files)
    const byPair = new Map<string, GraphEdge>()
    for (const [from, note] of files) {
      if (!isMarkdown(from)) continue
      for (const link of mockExtractLinks(note.text)) {
        const target = resolver(from, link.rawTarget).path
        const key = `${from}\u0000${target ?? ''}`
        const existing = byPair.get(key)
        if (existing !== undefined) {
          existing.count += 1
          continue
        }
        byPair.set(key, {
          fromRelPath: from,
          toRelPath: target,
          toRawTarget: link.rawTarget,
          kind: link.kind,
          count: 1,
        })
      }
    }
    const edges = [...byPair.values()].sort(
      (left, right) =>
        left.fromRelPath.localeCompare(right.fromRelPath) ||
        (left.toRelPath ?? '\uffff').localeCompare(right.toRelPath ?? '\uffff') ||
        left.kind.localeCompare(right.kind),
    )
    const outDegrees = new Map<string, number>()
    const inDegrees = new Map<string, number>()
    for (const edge of edges) {
      outDegrees.set(edge.fromRelPath, (outDegrees.get(edge.fromRelPath) ?? 0) + 1)
      if (edge.toRelPath !== null) {
        inDegrees.set(edge.toRelPath, (inDegrees.get(edge.toRelPath) ?? 0) + 1)
      }
    }
    const nodes: GraphNode[] = [...files.keys()]
      .filter(isMarkdown)
      .sort()
      .map((relPath) => {
        const note = files.get(relPath)
        const frontmatter = note === undefined ? null : mockParseFrontmatter(note.text)
        const titleField = frontmatter?.fields.find((field) => field.key === 'title')
        const title =
          titleField !== undefined && titleField.value.kind === 'scalar'
            ? titleField.value.value
            : (relPath.split('/').pop() ?? relPath).replace(/\.(md|markdown)$/i, '')
        return {
          relPath,
          title,
          folder: parentOf(relPath),
          tags: (note === undefined ? [] : mockExtractTags(note.text))
            .slice(0, 8)
            .map((tag) => tag.tag),
          outDegree: outDegrees.get(relPath) ?? 0,
          inDegree: inDegrees.get(relPath) ?? 0,
        }
      })
    return { nodes, edges, truncated: false, elapsedMs: 1 }
  }

  const mtimes = new Map<string, number>()
  const mtimeOf = (relPath: string): number => {
    const existing = mtimes.get(relPath)
    if (existing !== undefined) return existing
    const value = touch()
    mtimes.set(relPath, value)
    return value
  }

  const entries = (): EntryMeta[] => {
    const out: EntryMeta[] = []
    for (const dir of [...dirs].sort()) {
      out.push({
        relPath: dir,
        name: dir.split('/').pop() ?? dir,
        isDir: true,
        sizeBytes: 0,
        mtimeMs: null,
        ext: null,
      })
    }
    for (const note of [...files.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const name = note.relPath.split('/').pop() ?? note.relPath
      const dot = name.lastIndexOf('.')
      out.push({
        relPath: note.relPath,
        name,
        isDir: false,
        sizeBytes: new TextEncoder().encode(note.text).length,
        mtimeMs: mtimeOf(note.relPath),
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
      })
    }
    // 图片附件（粘贴/拖入落下来的）：形状与扫描结果一致（大小按字节、ext 小写），
    // 这样文件树与过滤逻辑不需要知道"这条是笔记还是附件"
    for (const [relPath, bytes] of [...binaries.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const name = relPath.split('/').pop() ?? relPath
      const dot = name.lastIndexOf('.')
      out.push({
        relPath,
        name,
        isDir: false,
        sizeBytes: bytes.length,
        mtimeMs: mtimeOf(relPath),
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
      })
    }
    return out
  }

  const noteCount = (): number => [...files.keys()].filter(isMarkdown).length

  // -- 目录搬迁的小工具（闭包内，直接读 `files` / `dirs` 两张表） --------------
  //
  // 与 Rust 的 `mn_index::path_inside` 同一纪律：`归档2` 以 `归档` 开头却**不是**它的后代，
  // 用 `startsWith(oldDir)` 一把梭会在"移动整棵子树"时动错目录。

  /** `rel` 是否在目录 `dir` 之内（`dir === ''` = Vault 根，任何路径都在内）。 */
  const insideDir = (rel: string, dir: string): boolean =>
    dir === '' || rel === dir || rel.startsWith(`${dir}/`)

  /** 把已在 `oldDir` 之内的路径映射到 `newDir` 下。 */
  const remapPrefix = (rel: string, oldDir: string, newDir: string): string => {
    const rest = oldDir === '' ? rel : rel === oldDir ? '' : rel.slice(oldDir.length + 1)
    return rest === '' ? newDir : newDir === '' ? rest : `${newDir}/${rest}`
  }

  /** 子树里每个文件的旧 → 新相对路径（字典序，测试可复现）。 */
  const relocateTree = (oldDir: string, newDir: string): Array<{ from: string; to: string }> =>
    [...files.keys()]
      .filter((rel) => insideDir(rel, oldDir))
      .sort()
      .map((from) => ({ from, to: remapPrefix(from, oldDir, newDir) }))

  /** 目录表里 `oldDir` 及其所有后代换成 `newDir` 前缀（拖拽后树里不能留着旧目录）。 */
  const remapDirs = (oldDir: string, newDir: string): void => {
    const doomed = [...dirs].filter((dir) => insideDir(dir, oldDir))
    for (const dir of doomed) dirs.delete(dir)
    for (const dir of doomed) dirs.add(remapPrefix(dir, oldDir, newDir))
  }

  // 显式类型标注：让 TypeScript 的流程分析知道调用后不可达（从而正确收窄 note 等变量）
  const fail: (code: ErrorCode, message: string) => never = (code, message) => {
    throw new MimenoteError({ code, message, detail: null, currentMtimeMs: null })
  }

  const validate = (relPath: string): void => {
    if (relPath.trim() === '') fail('PATH_INVALID', '路径为空')
    if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) fail('PATH_INVALID', '不允许绝对路径')
    for (const segment of relPath.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        fail('PATH_INVALID', `非法路径段：${segment}`)
      }
    }
  }

  const sleep = async (): Promise<void> => {
    if (writeLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, writeLatencyMs))
  }

  /**
   * 永久删除回收站里的若干条（`trash_delete` 与 `trash_empty` 的**共用实现**）。
   *
   * 为什么抽出来：两条命令只差"处理哪些记录"，从"什么算释放了空间"到"结果怎么分三类"
   * 这一段必须是同一份 —— 分成两份写，界面上那句"永久删除了 N 项、释放 X"就会在
   * 单条删除与清空之间悄悄漂移。
   *
   * 索引按**从大到小**处理：`splice` 会把后面的下标往前挪，正序删会把还没处理的那些跳过去。
   */
  const purgeTrashEntries = (indices: number[]): PurgeSummary => {
    const removed: string[] = []
    const missing: string[] = []
    let bytesFreed = 0
    for (const index of [...indices].sort((left, right) => right - left)) {
      const record = trashed[index]
      if (record === undefined) continue
      const text = removedTexts.get(record.id)
      if (text === undefined) {
        // 台账里有、回收站里没有（孤儿记录）：只清台账记录，**不释放空间**
        missing.push(record.id)
      } else {
        bytesFreed += new TextEncoder().encode(text).length
        removedTexts.delete(record.id)
        removed.push(record.id)
      }
      trashed.splice(index, 1)
    }
    return { removed, missing, failed: [], bytesFreed }
  }

  /**
   * 全库标签改写的**共用实现**：`tag_rename` 与 `tag_move` 只差"目标键怎么算出来"
   * （前者直接用用户输入，后者由 `mockTagMoveTarget` 从父标签推），从"哪些笔记进了候选集"
   * 到"逐篇汇报了什么"这一段必须是**同一份** —— 分开写两份，结果界面就会在两处慢慢漂移。
   *
   * 刻意**永远返回空的 `skipped`**：内存 Vault 不可能"被外部改动"或"写失败"，
   * 编一个假的跳过项只会让浏览器预览里的汇报看起来更完整、实际更不可信。
   * 那条路径由宿主单测（`tag_rename_skips_files_changed_outside_the_app` 等）与 UI 层用桩适配器写的用例覆盖。
   */
  const rewriteTagsAcrossVault = (
    mapping: MockTagMapping,
    fromDisplay: string,
    dryRun: boolean,
  ): TagRenameOutcome => {
    const covers = (key: string): boolean =>
      key === mapping.fromKey ||
      (mapping.includeChildren && key.startsWith(`${mapping.fromKey}/`))

    const edited: TagRenameFile[] = []
    const skipped: TagRenameSkip[] = []
    let unchanged = 0
    let frontmatterEdits = 0
    let inlineEdits = 0
    let inlineRemoved = 0
    let candidates = 0

    for (const rel of [...files.keys()].sort()) {
      if (!isMarkdown(rel)) continue
      const note = files.get(rel)
      if (note === undefined) continue
      const keys = new Set(
        mockExtractTags(note.text)
          .map((tag) => mockNormalizeTag(tag.tag))
          .filter((key) => key !== ''),
      )
      if (![...keys].some(covers)) continue
      candidates += 1

      const rewrite = mockRenameTags(note.text, mapping)
      if (rewrite === null) {
        unchanged += 1
        continue
      }
      if (!dryRun) {
        files.set(rel, { relPath: rel, text: rewrite.text })
        mtimes.set(rel, touch())
      }
      frontmatterEdits += rewrite.frontmatterEdits
      inlineEdits += rewrite.inlineEdits
      inlineRemoved += rewrite.inlineRemoved
      edited.push({
        relPath: rel,
        frontmatterEdits: rewrite.frontmatterEdits,
        inlineEdits: rewrite.inlineEdits,
        inlineRemoved: rewrite.inlineRemoved,
      })
    }

    return {
      from: mapping.fromKey,
      to: mapping.toKey,
      fromDisplay,
      toDisplay: mapping.toDisplay,
      includeChildren: mapping.includeChildren,
      dryRun,
      candidates,
      edited,
      skipped,
      unchanged,
      frontmatterEdits,
      inlineEdits,
      inlineRemoved,
      elapsedMs: 1,
    }
  }

  const startupVaultPath = options.startupVaultPath

  return {
    rootPath,
    writeLatencyMs,
    files,
    dirs,
    binaries,
    configContent,
    configFormat,
    trashed,
    removedTexts,
    trashDirs,
    siteFiles,
    presentInTrash,
    trashCalls,
    touch,
    seed,
    graphDataOf,
    mtimes,
    mtimeOf,
    entries,
    noteCount,
    insideDir,
    remapPrefix,
    relocateTree,
    remapDirs,
    fail,
    validate,
    sleep,
    purgeTrashEntries,
    rewriteTagsAcrossVault,
    startupVaultPath,
  }
}
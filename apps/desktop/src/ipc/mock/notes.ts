/**
 * ipc/mock/notes.ts
 *
 * 笔记的读 / 写 / 新建 / 删除 / 改名 / 移动（`note_*`、`notes_read_batch`、`note_stats`）。
 */
import type { MockHost } from './host'
import { buildMockNoteLinks, createMockResolver, mockRewriteLinks } from './links'

import { basename, extensionOf, joinRel, parentOf } from '@/domain/paths'
import { MimenoteError } from '@/ipc/types'
import type {NoteContent, NotesBatch, RenameLinkUpdate, RenameOutcome, SiteSkip, TrashRecord, WriteOutcome} from '@/ipc/types'



/**
 * `note_links` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteLinks(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, validate } = host
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          return buildMockNoteLinks(files, relPath)
}

/**
 * `note_read` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteRead(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, mtimeOf, validate } = host
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          const payload: NoteContent = {
            relPath,
            text: note.text,
            sizeBytes: new TextEncoder().encode(note.text).length,
            mtimeMs: mtimeOf(relPath),
          }
          return payload
}

/**
 * `note_write` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteWrite(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { writeLatencyMs, files, touch, mtimes, mtimeOf, validate, sleep } = host
          const relPath = String(a.relPath ?? '')
          const text = String(a.text ?? '')
          const baseMtimeMs = a.baseMtimeMs === null || a.baseMtimeMs === undefined ? null : Number(a.baseMtimeMs)
          const force = a.force === true
          // `stampTimes` 只为契约兼容而接收：Mock 文件系统没有 birthtime/frontmatter 语义，
          // 时间挂钩的逻辑由 Rust 单测覆盖（`commands::notes::tests`），这里存原文
          void a.stampTimes
          validate(relPath)
          await sleep()
          // 带了基线令牌就是在更新一篇已有笔记。文件已经不在时不能写回去 ——
          // 否则和宿主一样，会把外部删掉的路径重新建出来。`force` 只覆盖 mtime 冲突。
          if (baseMtimeMs !== null && !files.has(relPath)) {
            host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          }
          const current = mtimeOf(relPath)
          if (!force && baseMtimeMs !== null && baseMtimeMs !== current) {
            throw new MimenoteError({
              code: 'CONFLICT',
              message: '文件已被外部修改',
              detail: null,
              currentMtimeMs: current,
            })
          }
          files.set(relPath, { relPath, text })
          const next = touch()
          mtimes.set(relPath, next)
          const payload: WriteOutcome = {
            relPath,
            mtimeMs: next,
            sizeBytes: new TextEncoder().encode(text).length,
            writtenInMs: writeLatencyMs,
          }
          return payload
}

/**
 * `note_create` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteCreate(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, dirs, mtimeOf, validate } = host
          const parentRel = String(a.parentRel ?? '')
          const title = String(a.title ?? '').trim()
          // 见 `note_write` 的注释：`stampTimes` 只为契约兼容而接收
          void a.stampTimes
          const stem = (title === '' ? '未命名' : title).replace(/[\\/:*?"<>|]/g, '-')
          let candidate = parentRel === '' ? `${stem}.md` : `${parentRel}/${stem}.md`
          let attempt = 0
          while (files.has(candidate)) {
            attempt += 1
            candidate = parentRel === '' ? `${stem} ${attempt}.md` : `${parentRel}/${stem} ${attempt}.md`
          }
          validate(candidate)
          const text = title === '' ? '' : `# ${title}\n`
          files.set(candidate, { relPath: candidate, text })
          if (parentRel !== '') dirs.add(parentRel)
          const payload: NoteContent = {
            relPath: candidate,
            text,
            sizeBytes: new TextEncoder().encode(text).length,
            mtimeMs: mtimeOf(candidate),
          }
          return payload
}

/**
 * `note_delete` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteDelete(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, trashed, removedTexts, validate } = host
          const relPath = String(a.relPath ?? '')
          if (a.confirm !== true) host.fail('CONFIRMATION_REQUIRED', '删除需要显式确认')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          files.delete(relPath)
          const record: TrashRecord = {
            id: `mock-${trashed.length + 1}`,
            originalRelPath: relPath,
            storedRelPath: `.mimenote/trash/mock-${trashed.length + 1}__${relPath.split('/').pop() ?? ''}`,
            deletedAtMs: Date.now(),
            sizeBytes: new TextEncoder().encode(note.text).length,
            isDir: false,
          }
          // 正文另存一份：真实宿主是把它移进 `.mimenote/trash`，Mock 里没有真文件系统，
          // 但"恢复之后内容逐字回来"这条必须在 Mock 下也成立（否则前端测试就是在测空气）
          removedTexts.set(record.id, note.text)
          trashed.push(record)
          return record
}

/**
 * `note_rename` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteRename(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, touch, mtimes, mtimeOf, validate } = host
          const relPath = String(a.relPath ?? '')
          const newTitle = String(a.newTitle ?? '').trim()
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          if (newTitle === '' || newTitle === '.' || newTitle === '..' || /[\\/:*?"<>|]/.test(newTitle)) {
            host.fail('PATH_INVALID', `非法文件名：${newTitle}`)
          }

          const dir = parentOf(relPath)
          const ext = extensionOf(relPath) === '' ? 'md' : extensionOf(relPath)
          const newRelPath = joinRel(dir, `${newTitle}.${ext}`)
          validate(newRelPath)
          if (newRelPath !== relPath && files.has(newRelPath)) {
            host.fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }

          // ⚠️ 解析器必须基于**改名前**的文件表：改名之后 `[[旧名]]` 再也解析不到任何文件，
          // 就无法判断哪些链接原本指向它了（Rust 侧用的是索引里的改名前快照，同一个道理）。
          const resolver = updateLinks ? createMockResolver(files) : null

          files.delete(relPath)
          files.set(newRelPath, { relPath: newRelPath, text: note.text })
          const movedMtime = mtimeOf(relPath)
          mtimes.delete(relPath)
          mtimes.set(newRelPath, movedMtime)

          const updatedLinks: RenameLinkUpdate[] = []
          if (resolver !== null) {
            for (const from of [...files.keys()].sort()) {
              const current = files.get(from)
              if (current === undefined) continue
              const result = mockRewriteLinks(current.text, from, relPath, newRelPath, resolver)
              if (result.count === 0) continue
              files.set(from, { relPath: from, text: result.text })
              mtimes.set(from, touch())
              // 被改名文件**自身**的条目用**旧路径**上报：前端要在"改名前的坐标系"里判断
              // "我正在编辑的这一篇也被改写了"。Rust 侧（`mn_index::rename`）用的是同一口径，
              // 这里必须对齐，否则浏览器模式下自链接场景走不到"重新读取"分支。
              updatedLinks.push({ relPath: from === newRelPath ? relPath : from, count: result.count })
            }
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            newMtimeMs: mtimeOf(newRelPath),
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload
}

/**
 * `note_move` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteMove(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, dirs, touch, mtimes, mtimeOf, validate } = host
          // 跨目录移动（`note_move` 的 Mock 镜像）：与 `note_rename` 共用同一段"改路径 +
          // 改写全库链接"的机制，差别只有两点 —— 目标目录由参数给（不存在就建），
          // 以及链接一律写成相对新位置的路径（见 `mockRewriteLinks` 的 alwaysRelative）。
          const relPath = String(a.relPath ?? '')
          const rawTarget = String(a.targetParentRel ?? '')
          const rawTitle = a.newTitle === null || a.newTitle === undefined ? null : String(a.newTitle).trim()
          const updateLinks = a.updateLinks !== false
          validate(relPath)

          if (dirs.has(relPath)) host.fail('IS_DIRECTORY', `目录移动暂不支持：${relPath}`)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)

          // 首尾 `/` 与反斜杠都容忍（`''` = Vault 根）；`..` 之类仍由 validate 拦下
          const parentRel = rawTarget.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
          if (parentRel !== '') validate(parentRel)

          const name = basename(relPath)
          let newName = name
          if (rawTitle !== null) {
            if (rawTitle === '' || rawTitle === '.' || rawTitle === '..' || /[\\/:*?"<>|]/.test(rawTitle)) {
              host.fail('PATH_INVALID', `非法文件名：${rawTitle}`)
            }
            const stem = rawTitle.replace(/\.(md|markdown)$/i, '')
            const ext = extensionOf(relPath)
            newName = ext === '' ? stem : `${stem}.${ext}`
          }
          const newRelPath = parentRel === '' ? newName : `${parentRel}/${newName}`
          validate(newRelPath)

          if (newRelPath === relPath) {
            // 移到自己所在目录：无操作（与宿主一致，连 mtime 都不动）
            const payload: RenameOutcome = {
              oldRelPath: relPath,
              newRelPath,
              newMtimeMs: mtimeOf(relPath),
              updatedLinks: [],
              updatedLinkCount: 0,
              elapsedMs: 0,
            }
            return payload
          }
          if (files.has(newRelPath)) host.fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)

          // ⚠️ 解析器必须基于**移动前**的文件表：搬完之后 `[[旧路径]]` 再也解析不到它，
          // 就无法判断哪些链接原本指向它了（Rust 侧用的是索引里的移动前快照，同一个道理）。
          const resolver = updateLinks ? createMockResolver(files) : null

          files.delete(relPath)
          files.set(newRelPath, { relPath: newRelPath, text: note.text })
          const movedMtime = mtimeOf(relPath)
          mtimes.delete(relPath)
          mtimes.set(newRelPath, movedMtime)

          // 目标目录不存在时创建（含缺失的祖先），否则树里会缺一层
          if (parentRel !== '') {
            const parts = parentRel.split('/')
            let acc = ''
            for (const part of parts) {
              acc = acc === '' ? part : `${acc}/${part}`
              dirs.add(acc)
            }
          }

          const updatedLinks: RenameLinkUpdate[] = []
          if (resolver !== null) {
            for (const from of [...files.keys()].sort()) {
              const current = files.get(from)
              if (current === undefined) continue
              // 被移动的文件**自身**：解析与相对路径换算都要按**移动前**的位置来
              // （Rust 的改写计划也是在移动前算的；否则自链接会算出"换个写法但等价"的差量）
              const fromBefore = from === newRelPath ? relPath : from
              const result = mockRewriteLinks(current.text, fromBefore, relPath, newRelPath, resolver, true)
              if (result.count === 0) continue
              files.set(from, { relPath: from, text: result.text })
              mtimes.set(from, touch())
              // 被移动文件自身的条目用**旧路径**上报（与 Rust 侧同一口径）
              updatedLinks.push({ relPath: fromBefore, count: result.count })
            }
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            newMtimeMs: mtimeOf(newRelPath),
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload
}

/**
 * `notes_read_batch` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function notesReadBatch(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, mtimeOf } = host
          // 批量读的 Mock 镜像：单篇失败**不整批失败**（与宿主同一口径），
          // 因此这里逐条 try 并如实记进 skipped，而不是一遇到坏路径就整批抛。
          const requested = Array.isArray(a.relPaths) ? a.relPaths.map((item) => String(item)) : []
          if (requested.length > 64) {
            host.fail('PATH_INVALID', `一次最多读 64 篇（本次 ${requested.length} 篇）`)
          }
          const items: NoteContent[] = []
          const skipped: SiteSkip[] = []
          for (const rel of requested) {
            const note = files.get(rel)
            if (note === undefined) {
              skipped.push({ relPath: rel, reason: 'not-found', message: '笔记不存在' })
              continue
            }
            items.push({
              relPath: rel,
              text: note.text,
              sizeBytes: new TextEncoder().encode(note.text).length,
              mtimeMs: mtimeOf(rel),
            })
          }
          const payload: NotesBatch = { items, skipped }
          return payload
}

/**
 * `note_stats` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteStats(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, mtimeOf, validate } = host
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          const payload = {
            relPath,
            sizeBytes: new TextEncoder().encode(note.text).length,
            mtimeMs: mtimeOf(relPath),
            stats: {
              chars: note.text.length,
              charsNoWhitespace: note.text.replace(/\s/g, '').length,
              words: note.text.split(/\s+/).filter((w) => w !== '').length,
              cjkChars: 0,
              lines: note.text === '' ? 0 : note.text.split('\n').length,
              readingMinutes: 1,
            },
          }
          return payload
}

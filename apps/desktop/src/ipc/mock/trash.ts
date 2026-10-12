/**
 * ipc/mock/trash.ts
 *
 * 回收站（`trash_*` 与 `note_restore`）。
 */
import type { MockHost } from './host'
import type { RestoreSummary, TrashEntry } from '@/ipc/types'



/**
 * `trash_list` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function trashList(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { trashed, presentInTrash } = host
          // 与宿主同口径：按删除时间倒序，并如实标出"东西还在不在"
          const entries: TrashEntry[] = [...trashed]
            .sort((left, right) => right.deletedAtMs - left.deletedAtMs)
            .map((record) => ({ ...record, present: presentInTrash(record) }))
          return entries
}

/**
 * `trash_delete` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function trashDelete(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { trashed, trashCalls, purgeTrashEntries } = host
/**
         * 永久删除/清空回收站（宿主两条命令共用这一份实现）。
         *
         * 与宿主**逐条对齐**的三点，任何一处漂移都会让 E2E 底座说假话：
         *
         * 1. 东西还在（`removedTexts` 里有）才算释放字节；台账里有、回收站里没有的那些
         *    只清台账记录，进 `missing` 而**不计入** `bytesFreed`；
         * 2. **没有**任何一条会进 `failed`：内存 Vault 里不存在"台账指向回收站之外"或
         *    "文件被占用"这两种处境。刻意不编假的跳过项 —— 那条路径由宿主单测
         *    （`purge_delete_rejects_a_tampered_ledger_entry`）与 UI 层用桩适配器写的用例覆盖；
         * 3. 被清理的条目从 `trashed`（台账）与 `removedTexts`（回收站里的东西）里**一起**消失。
         */
          trashCalls.push({ method: 'trash_delete', id: String(a.id ?? ''), confirm: a.confirm === true })
          if (a.confirm !== true) host.fail('CONFIRMATION_REQUIRED', '永久删除需要显式确认')
          const id = String(a.id ?? '')
          const index = trashed.findIndex((record) => record.id === id)
          if (index < 0) host.fail('NOT_FOUND', `回收站记录不存在：${id}`)
          return purgeTrashEntries([index])
}

/**
 * `trash_empty` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function trashEmpty(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { trashed, trashCalls, purgeTrashEntries } = host
          trashCalls.push({ method: 'trash_empty', confirm: a.confirm === true })
          if (a.confirm !== true) host.fail('CONFIRMATION_REQUIRED', '清空回收站需要显式确认')
          return purgeTrashEntries(trashed.map((_record, index) => index))
}

/**
 * `note_restore` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteRestore(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, trashed, removedTexts, trashDirs, presentInTrash, touch, validate } = host
          const id = String(a.id ?? '')
          const targetRaw = a.targetRelPath
          const index = trashed.findIndex((record) => record.id === id)
          if (index < 0) host.fail('NOT_FOUND', `回收站记录不存在：${id}`)
          const record = trashed[index]!
          if (!presentInTrash(record)) host.fail('NOT_FOUND', '回收站里的这个文件已经不在了')

          const target = targetRaw === undefined || targetRaw === null ? record.originalRelPath : String(targetRaw)
          validate(target)
          if (files.has(target) || trashDirs.has(target)) {
            host.fail('ALREADY_EXISTS', `目标已存在：${target}（先把那个文件移开，或用「恢复为…」换个名字）`)
          }

          // 父目录缺了就补（与 mn-core 的 restore_from_trash 同一行为），并自浅到深报出来
          const createdDirs: string[] = []
          const segments = target.split('/')
          let accumulated = ''
          for (const segment of segments.slice(0, -1)) {
            accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
            if (!trashDirs.has(accumulated) && !files.has(accumulated)) {
              trashDirs.add(accumulated)
              createdDirs.push(accumulated)
            }
          }

          const text = removedTexts.get(record.id)
          if (text === undefined) host.fail('NOT_FOUND', '回收站里的这个文件已经不在了')
          files.set(target, { relPath: target, text })
          touch()
          removedTexts.delete(record.id)
          trashed.splice(index, 1)

          const summary: RestoreSummary = {
            id: record.id,
            originalRelPath: record.originalRelPath,
            restoredRelPath: target,
            isDir: record.isDir,
            createdDirs,
            restoredToOriginalPlace: target === record.originalRelPath,
            // 目录恢复要交给真实重扫；Mock 里没有扫描器，但契约形状要保持一致
            needsRescan: record.isDir,
          }
          return summary
}

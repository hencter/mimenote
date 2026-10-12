/**
 * ipc/mock/dirs.ts
 *
 * 目录改名与目录移动（`dir_rename` / `dir_move`）。
 */
import type { MockHost } from './host'
import { mockRewriteDirLinks } from './links'
import { basename, parentOf } from '@/domain/paths'
import type { RenameOutcome } from '@/ipc/types'



/**
 * `dir_rename` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function dirRename(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, dirs, touch, mtimes, mtimeOf, relocateTree, remapDirs, validate } = host
          // 目录改名（`dir_rename` 的 Mock 镜像）：真的搬整棵子树 + 改写指向它的链接。
          // 与宿主同一套语义（见 `mockRewriteDirLinks`）：子树里每篇都要跟着换路径，
          // 目标同名一律拒（**绝不合并两棵子树**）。
          const relPath = String(a.relPath ?? '')
          const rawTitle = String(a.newTitle ?? '')
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          if (!dirs.has(relPath)) host.fail('NOT_A_DIRECTORY', `不是目录：${relPath}`)
          if (relPath === '.mimenote' || relPath.startsWith('.mimenote/')) {
            host.fail('PATH_INVALID', '.mimenote 是应用的内部目录，不能重命名或移动')
          }
          if (rawTitle !== rawTitle.trim()) host.fail('PATH_INVALID', '新名字不能带首尾空白')
          // 名字里的分隔符一律拒绝（与宿主同一口径）：允许 `子/新名` 会让"改名"偷偷变成"移动"，
          // 而改名与移动的链接改写规则不同 —— 换目录请走 `dir_move`
          if (rawTitle.includes('/') || rawTitle.includes('\\')) {
            host.fail('PATH_INVALID', '新名字不能包含路径分隔符（换目录请用目标目录参数）')
          }
          const name = rawTitle
          if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
            host.fail('PATH_INVALID', `非法目录名：${rawTitle}`)
          }

          const parent = parentOf(relPath)
          const newRelPath = parent === '' ? name : `${parent}/${name}`
          validate(newRelPath)
          if (newRelPath !== relPath && (dirs.has(newRelPath) || files.has(newRelPath))) {
            host.fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }

          const updatedLinks = mockRewriteDirLinks({
            files,
            oldDir: relPath,
            newDir: newRelPath,
            updateLinks,
          })
          const moves = relocateTree(relPath, newRelPath)
          for (const item of moves) {
            const note = files.get(item.from)
            if (note === undefined) continue
            files.set(item.to, { relPath: item.to, text: note.text })
            const movedMtime = mtimeOf(item.from)
            mtimes.delete(item.from)
            mtimes.set(item.to, movedMtime)
          }
          for (const item of moves) files.delete(item.from)
          remapDirs(relPath, newRelPath)
          for (const from of updatedLinks.map((item) => item.relPath)) {
            mtimes.set(from, touch())
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            // 目录不是版本令牌的载体（与宿主一致：如实报 0）
            newMtimeMs: 0,
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload
}

/**
 * `dir_move` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function dirMove(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, dirs, touch, mtimes, mtimeOf, relocateTree, remapDirs, validate } = host
          // 目录移动（`dir_move` 的 Mock 镜像）：与 `dir_rename` 共用同一段"搬子树 + 改写链接"，
          // 只有目标父目录由参数给（不存在就建）。搬进自己的后代一律拒绝 —— 与宿主同一口径。
          const relPath = String(a.relPath ?? '')
          const rawTarget = String(a.targetParentRel ?? '')
          const rawTitle =
            a.newTitle === null || a.newTitle === undefined ? null : String(a.newTitle)
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          if (!dirs.has(relPath)) host.fail('NOT_A_DIRECTORY', `不是目录：${relPath}`)
          if (relPath === '.mimenote' || relPath.startsWith('.mimenote/')) {
            host.fail('PATH_INVALID', '.mimenote 是应用的内部目录，不能重命名或移动')
          }

          const parentRel = rawTarget
            .trim()
            .replaceAll('\\', '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '')
          if (parentRel !== '') validate(parentRel)

          let name = basename(relPath)
          if (rawTitle !== null) {
            if (rawTitle !== rawTitle.trim()) host.fail('PATH_INVALID', '新名字不能带首尾空白')
            if (rawTitle.includes('/') || rawTitle.includes('\\')) {
              host.fail('PATH_INVALID', '新名字不能包含路径分隔符（换目录请用目标目录参数）')
            }
            name = rawTitle
            if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
              host.fail('PATH_INVALID', `非法目录名：${rawTitle}`)
            }
          }
          const newRelPath = parentRel === '' ? name : `${parentRel}/${name}`
          validate(newRelPath)
          // 搬进自己或自己的后代：宿主也是拒绝（这里给出同样的原因）
          if (newRelPath !== relPath && newRelPath.startsWith(`${relPath}/`)) {
            host.fail('PATH_INVALID', `不能把目录搬到它自己或它的子目录里（${relPath}）`)
          }
          if (newRelPath !== relPath && (dirs.has(newRelPath) || files.has(newRelPath))) {
            host.fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }
          if (newRelPath === relPath) {
            const payload: RenameOutcome = {
              oldRelPath: relPath,
              newRelPath,
              newMtimeMs: 0,
              updatedLinks: [],
              updatedLinkCount: 0,
              elapsedMs: 0,
            }
            return payload
          }
          if (parentRel !== '') {
            let accumulated = ''
            for (const segment of parentRel.split('/')) {
              accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
              dirs.add(accumulated)
            }
          }

          const updatedLinks = mockRewriteDirLinks({
            files,
            oldDir: relPath,
            newDir: newRelPath,
            updateLinks,
          })
          const moves = relocateTree(relPath, newRelPath)
          for (const item of moves) {
            const note = files.get(item.from)
            if (note === undefined) continue
            files.set(item.to, { relPath: item.to, text: note.text })
            const movedMtime = mtimeOf(item.from)
            mtimes.delete(item.from)
            mtimes.set(item.to, movedMtime)
          }
          for (const item of moves) files.delete(item.from)
          remapDirs(relPath, newRelPath)
          for (const from of updatedLinks.map((item) => item.relPath)) {
            mtimes.set(from, touch())
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            newMtimeMs: 0,
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload
}

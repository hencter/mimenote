/**
 * ipc/mock/tag-ops.ts
 *
 * 标签命令（`note_set_tags` / `tag_rename` / `tag_move` / `tag_filter`…）。
 */
import type { MockHost } from './host'
import { mockTagMapping, mockTagMoveTarget } from './tag-rename'
import { mockExtractTags, mockNormalizeTag, mockParseFrontmatter, mockSetTags } from './tags'
import { MimenoteError } from '@/ipc/types'
import type { NoteTags, SetTagsOutcome, TagFilterResult, TagNotes, TagSummary } from '@/ipc/types'



/**
 * `note_set_tags` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteSetTags(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { writeLatencyMs, files, touch, mtimes, mtimeOf, validate, sleep } = host
          // 与真实实现同一条纪律：令牌校验 → 改文本 → 写回 → `note_tags`/`tags_list` 立刻跟着变
          // （那两条都是从文本现算的，所以这里**必须真的改文本**，否则 UI/E2E 会假绿）
          const relPath = String(a.relPath ?? '')
          const add = Array.isArray(a.add) ? (a.add as unknown[]).map((item) => String(item)) : []
          const remove = Array.isArray(a.remove)
            ? (a.remove as unknown[]).map((item) => String(item))
            : []
          const baseMtimeMs =
            a.baseMtimeMs === null || a.baseMtimeMs === undefined ? null : Number(a.baseMtimeMs)
          validate(relPath)
          await sleep()
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)

          const current = mtimeOf(relPath)
          if (baseMtimeMs !== null && baseMtimeMs !== current) {
            throw new MimenoteError({
              code: 'CONFLICT',
              message: '文件已被外部修改',
              detail: null,
              currentMtimeMs: current,
            })
          }

          const updated = mockSetTags(note.text, add, remove)
          const changed = updated !== note.text
          if (changed) {
            files.set(relPath, { relPath, text: updated })
            mtimes.set(relPath, touch())
          }
          const frontmatter = mockParseFrontmatter(updated)
          const payload: SetTagsOutcome = {
            relPath,
            mtimeMs: mtimeOf(relPath),
            sizeBytes: new TextEncoder().encode(updated).length,
            writtenInMs: changed ? writeLatencyMs : 0,
            changed,
            tags: (frontmatter?.tags ?? []).map((entry) => entry.tag),
            text: updated,
          }
          return payload
}

/**
 * `tag_rename` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function tagRename(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { rewriteTagsAcrossVault } = host
          // 标签改名/合并的 Mock 镜像：与真实宿主同一条纪律 —— 候选集来自"文本里的标签"，
          // 逐篇走 `mockRenameTags`（frontmatter 与正文一起改），逐篇如实汇报。
          // `dryRun` 只算不写，但判定与真跑完全一致（对话框那句"这会改 N 篇笔记"才可信）。
          // 执行部分与 `tag_move` 共用 `rewriteTagsAcrossVault`（见那里的注释）。
          const from = String(a.from ?? '')
          const to = String(a.to ?? '')
          const includeChildren = a.includeChildren !== false
          const dryRun = a.dryRun === true
          const mapping = mockTagMapping(from, to, includeChildren)
          if (mapping === null) host.fail('PATH_INVALID', '标签名称为空，无法改名')

          const payload = rewriteTagsAcrossVault(mapping, from, dryRun)
          return payload
}

/**
 * `tag_move` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function tagMove(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, rewriteTagsAcrossVault } = host
          // 层级编辑的 Mock 镜像：目标键由 `mockTagMoveTarget` 算（与 Rust 的
          // `tag_move_target` 同规则、同拒绝理由），随后**走的是与改名同一条执行路径** ——
          // 宿主那边也是这样（`tag_move_in` 内部就是 `tag_rename_in`），
          // 所以"会改 N 篇 / 改了哪几篇"的汇报形状与原命令完全一致，界面无需分支。
          //
          // "目标键已被别的标签占用"这个判定这里也照做：内存 Vault 里所有标签都是从文本现算的，
          // 因此这条拒绝在浏览器预览里同样成立（不是宿主独有的分支）。
          const key = String(a.key ?? '')
          const parent = String(a.parent ?? '')
          const includeChildren = a.includeChildren !== false
          const dryRun = a.dryRun === true

          const move = mockTagMoveTarget(key, parent)
          if (!move.ok) host.fail('PATH_INVALID', move.reason)

          const fromKey = mockNormalizeTag(key)
          const taken = [...files.values()].some((note) =>
            mockExtractTags(note.text).some((tag) => {
              const existing = mockNormalizeTag(tag.tag)
              return existing === move.toKey && existing !== fromKey
            }),
          )
          if (taken) {
            host.fail('PATH_INVALID', `「${move.toKey}」已经是一个标签了；要合并请用「重命名」`)
          }

          const mapping = mockTagMapping(key, move.toKey, includeChildren)
          if (mapping === null) host.fail('PATH_INVALID', '标签名称为空，无法调整层级')

          const payload = rewriteTagsAcrossVault(mapping, key, dryRun)
          return payload
}

/**
 * `note_tags` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function noteTags(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, validate } = host
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) host.fail('NOT_FOUND', `文件不存在：${relPath}`)
          const frontmatter = mockParseFrontmatter(note.text)
          const payload: NoteTags = {
            relPath,
            tags: mockExtractTags(note.text),
            frontmatter: frontmatter === null ? [] : frontmatter.fields,
          }
          return payload
}

/**
 * `tags_list` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function tagsList(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          const summary = new Map<string, { tag: string; count: number }>()
          for (const note of files.values()) {
            const counted = new Set<string>()
            for (const tag of mockExtractTags(note.text)) {
              const key = mockNormalizeTag(tag.tag)
              if (key === '' || counted.has(key)) continue
              counted.add(key)
              const existing = summary.get(key)
              if (existing === undefined) summary.set(key, { tag: tag.tag, count: 1 })
              else existing.count += 1
            }
          }
          const payload: TagSummary[] = [...summary.entries()]
            .map(([key, value]) => ({ key, tag: value.tag, count: value.count }))
            .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
          return payload
}

/**
 * `tag_notes` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function tagNotes(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          const key = mockNormalizeTag(String(a.key ?? ''))
          if (key === '') host.fail('PATH_INVALID', '标签为空')
          const notes = [...files.entries()]
            .filter(([, note]) =>
              mockExtractTags(note.text).some((tag) => mockNormalizeTag(tag.tag) === key),
            )
            .map(([rel]) => rel)
            .sort()
          const payload: TagNotes = { key, notes }
          return payload
}

/**
 * `tag_filter` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function tagFilter(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          // 与宿主 `TagIndex::filter_notes` 同口径：含任意一个（空 = 全部有标签的笔记）
          // 且不含任何一个；`includeChildren` 按 `/` 切段匹配后代（`父老` 不是 `父` 的后代）。
          const anyKeys = (Array.isArray(a.any) ? a.any : [])
            .map((key) => mockNormalizeTag(String(key)))
            .filter((key) => key !== '')
          const noneKeys = (Array.isArray(a.none) ? a.none : [])
            .map((key) => mockNormalizeTag(String(key)))
            .filter((key) => key !== '')
          const includeChildren = a.includeChildren === true

          const keysOf = (path: string): Set<string> => {
            const note = files.get(path)
            if (note === undefined) return new Set()
            return new Set(
              mockExtractTags(note.text)
                .map((tag) => mockNormalizeTag(tag.tag))
                .filter((key) => key !== ''),
            )
          }
          /** 这组键是否命中某个想要的条件（含后代时按 `/` 切段比较）。 */
          const hits = (keys: Set<string>, wanted: string): boolean => {
            if (keys.has(wanted)) return true
            if (!includeChildren) return false
            const prefix = `${wanted}/`
            for (const key of keys) {
              if (key.startsWith(prefix)) return true
            }
            return false
          }

          let tagged = 0
          const paths: string[] = []
          for (const path of [...files.keys()].sort()) {
            const keys = keysOf(path)
            if (keys.size === 0) continue
            tagged += 1
            const included = anyKeys.length === 0 ? true : anyKeys.some((key) => hits(keys, key))
            if (!included) continue
            if (noneKeys.some((key) => hits(keys, key))) continue
            paths.push(path)
          }
          const result: TagFilterResult = { paths, matched: paths.length, tagged }
          return result
}

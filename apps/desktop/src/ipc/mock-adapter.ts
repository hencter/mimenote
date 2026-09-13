/**
 * 内存 Vault 适配器。
 *
 * 双重用途：
 * 1. **测试替身**：让 store / 领域层可以在 vitest 里跑完整 M1 闭环，无需 Tauri；
 * 2. **浏览器预览**：`pnpm dev` 时若不在 Tauri 内，UI 依然可用（便于调样式）。
 *
 * 行为刻意与 Rust 侧对齐：删除进回收站、mtime 作为版本令牌、路径校验。
 */

import type { EntryMeta, NoteContent, TrashRecord, VaultInfo, VaultSnapshot, WriteOutcome } from './types'
import { MimenoteError, type ErrorCode } from './types'
import type { IpcAdapter } from './client'

interface MockNote {
  relPath: string
  text: string
}

/** 内存示例 Vault 的根路径（浏览器预览模式下"打开 Vault"打开的就是它）。 */
export const MOCK_VAULT_PATH = 'C:\\MockVault'

const DEFAULT_NOTES: MockNote[] = [
  { relPath: 'README.md', text: '# 示例 Vault\n\n这是**内存 Mock Vault**，用于浏览器预览与自动化测试。\n' },
  {
    relPath: '日记/2025-01-01.md',
    text: '# 一月一日\n\n- [x] 起床\n- [ ] 写笔记\n\n> 引用：本地优先。\n',
  },
  { relPath: '日记/2025-01-02.md', text: '# 一月二日\n\n今天研究了 CodeMirror 6 的扩展机制。\n' },
  { relPath: '项目/设计.md', text: '# 设计\n\n| 层 | 职责 |\n| --- | --- |\n| 文件层 | 原子写 |\n| 索引层 | FTS5 |\n' },
  { relPath: '项目/路线图.md', text: '# 路线图\n\n1. M1 闭环\n2. M2 搜索\n3. M3 图谱\n' },
  { relPath: '项目/子项目/细节.md', text: '# 细节\n\n```ts\nexport const answer = 42\n```\n' },
  { relPath: '随手记.md', text: '字数统计测试：hello world 与中文混排。\n' },
  { relPath: '附件/说明.txt', text: '非 Markdown 附件，M1 不可编辑。\n' },
]

export interface MockAdapterOptions {
  notes?: MockNote[]
  rootPath?: string
  /** 模拟命令行指定的 Vault（`startup_vault` 命令）。 */
  startupVaultPath?: string
  /** 模拟写入延迟（毫秒），用于验证 UI 的"保存中"状态。 */
  writeLatencyMs?: number
}

export interface MockAdapter extends IpcAdapter {
  /** 模拟外部程序修改文件（用于手工验证冲突横幅）。 */
  simulateExternalEdit(relPath: string, text: string): void
  /** 当前快照（测试断言用）。 */
  dump(): MockNote[]
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  const rootPath = options.rootPath ?? MOCK_VAULT_PATH
  const writeLatencyMs = options.writeLatencyMs ?? 0
  const files = new Map<string, MockNote>()
  const dirs = new Set<string>()
  const trashed: TrashRecord[] = []
  let clock = Date.now()

  const touch = (): number => {
    clock += 1
    return clock
  }

  const seed = (list: MockNote[]): void => {
    files.clear()
    dirs.clear()
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
    return out
  }

  const noteCount = (): number =>
    [...files.keys()].filter((rel) => {
      const ext = rel.split('.').pop()?.toLowerCase()
      return ext === 'md' || ext === 'markdown'
    }).length

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

  return {
    kind: 'mock',
    dump: () => [...files.values()].map((n) => ({ ...n })),
    simulateExternalEdit: (relPath, text) => {
      const existing = files.get(relPath)
      if (existing === undefined) return
      files.set(relPath, { relPath, text })
      mtimes.set(relPath, touch())
    },
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      const a = args ?? {}
      switch (method) {
        case 'vault_open':
        case 'vault_snapshot': {
          const list = entries()
          const payload: VaultSnapshot = {
            rootPath,
            name: 'MockVault',
            entries: list,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
            generatedAtMs: Date.now(),
          }
          // vault_open 与 vault_snapshot 在契约上返回同一结构（见 commands.rs）
          return payload as T
        }
        case 'vault_info': {
          const info: VaultInfo = {
            rootPath,
            name: 'MockVault',
            entryCount: entries().length,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
          }
          return info as T
        }
        case 'vault_close':
          return undefined as T
        case 'startup_vault':
          return (options.startupVaultPath ?? null) as T
        case 'note_read': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          const payload: NoteContent = {
            relPath,
            text: note.text,
            sizeBytes: new TextEncoder().encode(note.text).length,
            mtimeMs: mtimeOf(relPath),
          }
          return payload as T
        }
        case 'note_write': {
          const relPath = String(a.relPath ?? '')
          const text = String(a.text ?? '')
          const baseMtimeMs = a.baseMtimeMs === null || a.baseMtimeMs === undefined ? null : Number(a.baseMtimeMs)
          const force = a.force === true
          validate(relPath)
          await sleep()
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
          return payload as T
        }
        case 'note_create': {
          const parentRel = String(a.parentRel ?? '')
          const title = String(a.title ?? '').trim()
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
          return payload as T
        }
        case 'note_delete': {
          const relPath = String(a.relPath ?? '')
          if (a.confirm !== true) fail('CONFIRMATION_REQUIRED', '删除需要显式确认')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          files.delete(relPath)
          const record: TrashRecord = {
            id: `mock-${trashed.length + 1}`,
            originalRelPath: relPath,
            storedRelPath: `.mimenote/trash/mock-${trashed.length + 1}__${relPath.split('/').pop() ?? ''}`,
            deletedAtMs: Date.now(),
            sizeBytes: new TextEncoder().encode(note.text).length,
            isDir: false,
          }
          trashed.push(record)
          return record as T
        }
        case 'snippets_list': {
          const snippets = [
            { name: 'example.css', css: '.mn-preview h1 { letter-spacing: 0.02em; }', sizeBytes: 44 },
          ]
          return snippets as T
        }
        case 'note_stats': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
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
          return payload as T
        }
        case 'version_info': {
          const info = { app: '0.1.0', core: '0.1.0', tauri: 'mock' }
          return info as T
        }
        default:
          return fail('INTERNAL', `Mock 适配器未实现命令：${method}`)
      }
    },
  }
}

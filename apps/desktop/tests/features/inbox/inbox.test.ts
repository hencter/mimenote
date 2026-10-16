/**
 * 收件箱的**判定与捕获规则**（ADR-0057 / `docs/design/03-inbox.md`）。
 *
 * 这一份只测纯函数（`domain/inbox.ts`）：判定、排序、时间戳命名、追加拼接。
 * 它们是"用户能在文件树/列表里看到结果"的边界（子目录、非 md、大小写、跨天、
 * 同名、CRLF、frontmatter 保留），放在这里逐条钉死，就不必等到真机上才发现
 * "捕获出来的笔记把 `created` 吃掉了"。
 *
 * 落盘的原子性与冲突语义由宿主的单测覆盖（`note_write` 的 mtime 令牌，ADR-0004）；
 * 这里覆盖的是"前端送过去什么文本"。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INBOX_DIR,
  INBOX_TITLE_SUMMARY_CHARS,
  appendCaptureEntry,
  compareInboxEntries,
  inboxDailyPath,
  inboxDailyTitle,
  inboxEntries,
  inboxNoteTitle,
  inboxTimestamp,
  inboxTitleSummary,
  isInboxEntry,
  isInboxPath,
  mergeCapturedBody,
  normalizeInboxDir,
  withInboxFirst,
} from '@/domain/inbox'
import type { EntryMeta } from '@/ipc/types'

/** 固定时刻，让时间戳可预期：2026-10-12 20:54（本地时间）。 */
const AT = new Date(2026, 9, 12, 20, 54, 0)

/**
 * 造一个条目。
 *
 * 刻意不用 `ipc/client` 的 `makeEntry`：它把缺省 mtime 写成 `0`（`?? 0`），
 * 而"mtime 不可得"（`null`）恰恰是本模块排序规则的核心边界之一，测试必须能表达它。
 */
function entry(relPath: string, mtimeMs: number | null, isDir = false): EntryMeta {
  const name = relPath.split('/').pop() ?? relPath
  const dot = name.lastIndexOf('.')
  return {
    relPath,
    name,
    isDir,
    sizeBytes: 0,
    mtimeMs,
    ext: isDir || dot <= 0 ? null : name.slice(dot + 1).toLowerCase(),
  }
}

describe('条目判定（isInboxPath / isInboxEntry）', () => {
  it('收件箱目录之内的 Markdown 都是条目，子目录也算', () => {
    expect(isInboxEntry('Inbox/一条.md', DEFAULT_INBOX_DIR)).toBe(true)
    expect(isInboxEntry('Inbox/2026-10-12 2054 记得买牛奶.md')).toBe(true)
    expect(isInboxEntry('Inbox/项目A/设计.md')).toBe(true)
    expect(isInboxEntry('Inbox/项目A/深层/x.markdown')).toBe(true)
  })

  it('大小写不敏感（Windows/macOS 上 Inbox 与 inbox 是同一个目录）', () => {
    expect(isInboxEntry('inbox/x.md')).toBe(true)
    expect(isInboxEntry('INBOX/子/x.md')).toBe(true)
    // 配置写小写、磁盘是大写（或反过来）都必须命中
    expect(isInboxPath('Inbox/x.md', 'inbox')).toBe(true)
    expect(isInboxPath('inbox/x.md', 'INBOX')).toBe(true)
  })

  it('必须是**整段**相等：Inbox2 / Inbox 备份 / Inboxx 不算', () => {
    expect(isInboxEntry('Inbox2/x.md')).toBe(false)
    expect(isInboxEntry('Inbox 备份/x.md')).toBe(false)
    expect(isInboxEntry('Inboxx/x.md')).toBe(false)
    expect(isInboxPath('Inboxx')).toBe(false)
    expect(isInboxPath('Inbox.old/x.md')).toBe(false)
  })

  it('非 md 附件不算条目（但仍在收件箱目录之内）', () => {
    expect(isInboxPath('Inbox/图.png')).toBe(true)
    expect(isInboxEntry('Inbox/图.png')).toBe(false)
    expect(isInboxEntry('Inbox/笔记.txt')).toBe(false)
    expect(isInboxEntry('Inbox/无扩展名')).toBe(false)
  })

  it('目录自身不是条目（isMarkdown 对目录返回 false）', () => {
    expect(isInboxPath('Inbox')).toBe(true)
    expect(isInboxEntry('Inbox')).toBe(false)
    expect(isInboxEntry('Inbox/')).toBe(false)
  })

  it('不在 Vault 根下的同名目录不算', () => {
    expect(isInboxEntry('项目/Inbox/x.md')).toBe(false)
    expect(isInboxEntry('a/b/Inbox.md')).toBe(false)
  })

  it('空路径、空目录配置不命中', () => {
    expect(isInboxPath('')).toBe(false)
    expect(isInboxEntry('')).toBe(false)
  })

  it('自定义目录（多段）与反斜杠写法', () => {
    expect(isInboxEntry('收件箱/未整理/a.md', '收件箱/未整理')).toBe(true)
    expect(isInboxEntry('收件箱/a.md', '收件箱/未整理')).toBe(false)
    expect(isInboxPath('收件箱/未整理', '收件箱/未整理')).toBe(true)
    // 容忍反斜杠与首尾 `/`：调用方可能是手工配置或 Windows 上粘进来的值
    expect(isInboxEntry('Inbox\\a.md', 'Inbox/')).toBe(true)
    expect(isInboxEntry('Inbox/a.md', '/Inbox/')).toBe(true)
  })

  it('目录配置非法（`..`、保留名）时按默认目录判定，与归一化同一口径', () => {
    // 归一化把这些值换成默认目录，`isInboxPath` 用的是同一个函数 —— 不出现"两套判定"
    expect(normalizeInboxDir('..')).toBe(DEFAULT_INBOX_DIR)
    expect(isInboxEntry('Inbox/a.md', '..')).toBe(true)
    expect(isInboxEntry('Inbox/a.md', 'Inbox/con')).toBe(true)
  })
})

describe('目录归一化（normalizeInboxDir）', () => {
  it('空串 / 空白 / 首尾斜杠 / 非法值 → 默认目录', () => {
    expect(normalizeInboxDir('')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('   ')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/')).toBe('Inbox')
    expect(normalizeInboxDir('/Inbox/')).toBe('Inbox')
    expect(normalizeInboxDir('a/../b')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/.')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/x.')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/ x')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/x:y')).toBe(DEFAULT_INBOX_DIR)
    expect(normalizeInboxDir('Inbox/nul')).toBe(DEFAULT_INBOX_DIR)
  })

  it('合法值原样保留（含中文与多段）', () => {
    expect(normalizeInboxDir(' 收件箱 ')).toBe('收件箱')
    expect(normalizeInboxDir('收件箱/未整理')).toBe('收件箱/未整理')
  })
})

describe('排序（compareInboxEntries / inboxEntries）', () => {
  it('mtime 倒序：最新捕获的排最前', () => {
    const sorted = inboxEntries([
      entry('Inbox/旧.md', 100),
      entry('Inbox/新.md', 300),
      entry('Inbox/中.md', 200),
    ])
    expect(sorted.map((item) => item.relPath)).toEqual(['Inbox/新.md', 'Inbox/中.md', 'Inbox/旧.md'])
  })

  it('mtimeMs 为 null 恒排最后（含义是"没有这个时间"，不是"最旧/最新"）', () => {
    const sorted = inboxEntries([
      entry('Inbox/未知.md', null),
      entry('Inbox/有.md', 1),
      entry('Inbox/也未知.md', null),
    ])
    expect(sorted.map((item) => item.relPath)).toEqual([
      'Inbox/有.md',
      'Inbox/也未知.md',
      'Inbox/未知.md',
    ])
    expect(compareInboxEntries(entry('a.md', null), entry('b.md', 0))).toBe(1)
  })

  it('mtime 相同时按 relPath 升序，结果与输入顺序无关', () => {
    const forward = inboxEntries([entry('Inbox/b.md', 5), entry('Inbox/a.md', 5)])
    const backward = inboxEntries([entry('Inbox/a.md', 5), entry('Inbox/b.md', 5)])
    expect(forward.map((item) => item.relPath)).toEqual(['Inbox/a.md', 'Inbox/b.md'])
    expect(backward.map((item) => item.relPath)).toEqual(['Inbox/a.md', 'Inbox/b.md'])
  })

  it('过滤掉非条目（非 md、别的目录），且**不修改入参**', () => {
    const all = [
      entry('Inbox/一条.md', 3),
      entry('Inbox/图.png', 4),
      entry('Inbox/子/二条.md', 2),
      entry('其它/三条.md', 9),
      entry('Inbox', null, true),
    ]
    const snapshot = all.map((item) => item.relPath)
    const kept = inboxEntries(all)
    expect(kept.map((item) => item.relPath)).toEqual(['Inbox/一条.md', 'Inbox/子/二条.md'])
    expect(all.map((item) => item.relPath)).toEqual(snapshot)
  })
})

describe('文件树置顶钩子（withInboxFirst）', () => {
  /** 一个"按名称升序"的基础比较器（等价于树里最常用的那一档）。 */
  const byName = (a: EntryMeta, b: EntryMeta): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  it('收件箱目录排最前，其余顺序完全不变', () => {
    const compare = withInboxFirst(byName)
    const items = [
      entry('项目/a.md', 1),
      entry('Inbox', 1),
      entry('归档/b.md', 1),
    ]
    expect(items.slice().sort(compare).map((item) => item.relPath)).toEqual([
      'Inbox',
      '项目/a.md',
      '归档/b.md',
    ])
    expect(compare(entry('Inbox', 1), entry('归档/b.md', 1))).toBe(-1)
    expect(compare(entry('归档/b.md', 1), entry('Inbox', 1))).toBe(1)
  })

  it('两边都在收件箱里时交给基础比较器（子树内部排序不被打乱）', () => {
    const compare = withInboxFirst(byName)
    expect(compare(entry('Inbox/子/b.md', 1), entry('Inbox/子/a.md', 1))).toBe(1)
    expect(compare(entry('Inbox/a.md', 1), entry('Inbox/b.md', 1))).toBe(-1)
  })

  it('自定义目录同样置顶', () => {
    const compare = withInboxFirst(byName, '收件箱')
    expect(compare(entry('收件箱', 1), entry('Inbox', 1))).toBe(-1)
  })
})

describe('时间戳与标题（inboxTimestamp / inboxDailyTitle / inboxNoteTitle）', () => {
  it('精确到分钟的本地时间戳与当日标题', () => {
    expect(inboxTimestamp(AT)).toBe('2026-10-12 2054')
    expect(inboxDailyTitle(AT)).toBe('2026-10-12')
    // 个位数的月/日/时/分都要补零（跨天、跨年的判断都建立在可排序的字符串上）
    expect(inboxTimestamp(new Date(2026, 0, 2, 3, 4, 0))).toBe('2026-01-02 0304')
  })

  it('当日模式的目标路径', () => {
    expect(inboxDailyPath('Inbox', AT)).toBe('Inbox/2026-10-12.md')
    expect(inboxDailyPath('收件箱/未整理', AT)).toBe('收件箱/未整理/2026-10-12.md')
    // 非法目录走归一化，不产出 `../` 这种路径
    expect(inboxDailyPath('..', AT)).toBe('Inbox/2026-10-12.md')
  })

  it('首行摘要：取第一个非空行、压空白、按码点截断', () => {
    expect(inboxTitleSummary('记得买牛奶')).toBe('记得买牛奶')
    expect(inboxTitleSummary('\n\n  记得   买牛奶  \n第二行')).toBe('记得 买牛奶')
    expect(inboxTitleSummary('')).toBe('')
    expect(inboxTitleSummary('   ')).toBe('')
    const long = 'x'.repeat(INBOX_TITLE_SUMMARY_CHARS + 10)
    expect(inboxTitleSummary(long)).toBe('x'.repeat(INBOX_TITLE_SUMMARY_CHARS))
    // 按码点截：代理对（emoji）不会被劈成半个字符
    expect([...inboxTitleSummary('😀'.repeat(30))]).toHaveLength(INBOX_TITLE_SUMMARY_CHARS)
  })

  it('标题 = 时间戳 + 摘要；摘要是空的时候只留时间戳', () => {
    expect(inboxNoteTitle('记得买牛奶', AT)).toBe('2026-10-12 2054 记得买牛奶')
    expect(inboxNoteTitle('   ', AT)).toBe('2026-10-12 2054')
  })

  it('标题里的 Windows 非法字符被安全化（与宿主 sanitize_file_stem 同口径）', () => {
    const title = inboxNoteTitle('关于/安全: 测试', AT)
    expect(title.startsWith('2026-10-12 2054 ')).toBe(true)
    expect(title).not.toContain('/')
    expect(title).not.toContain(':')
  })

  it('摘要正好是保留名（con）时退回纯时间戳，而不是一个落不了盘的名字', () => {
    expect(inboxNoteTitle('con', AT)).toBe('2026-10-12 2054')
  })
})

describe('单篇模式的正文合成（mergeCapturedBody）', () => {
  it('没有 frontmatter（宿主只写了 `# 标题` 占位）→ 只留用户正文 + 一个换行', () => {
    expect(mergeCapturedBody('# 2026-10-12 2054 记得买牛奶\n', '记得买牛奶')).toBe('记得买牛奶\n')
    expect(mergeCapturedBody('', '记得买牛奶')).toBe('记得买牛奶\n')
  })

  it('保留了宿主刚写下的 frontmatter 块（时间挂钩打开时不能吃掉它）', () => {
    const initial = '---\ncreated: 2026-10-12T12:54:00Z\nupdated: 2026-10-12T12:54:00Z\n---\n\n# 标题\n'
    expect(mergeCapturedBody(initial, '记得买牛奶')).toBe(
      '---\ncreated: 2026-10-12T12:54:00Z\nupdated: 2026-10-12T12:54:00Z\n---\n\n记得买牛奶\n',
    )
  })

  it('三种围栏都认（ADR-0048：YAML / TOML / JSON）', () => {
    expect(mergeCapturedBody('+++\ncreated = "x"\n+++\n', 'a')).toBe('+++\ncreated = "x"\n+++\n\na\n')
    expect(mergeCapturedBody(';;;\n{"created":"x"}\n;;;\n', 'a')).toBe(';;;\n{"created":"x"}\n;;;\n\na\n')
  })

  it('未闭合的 `---` 不算 frontmatter（普通分隔线不能被当成元数据块）', () => {
    expect(mergeCapturedBody('---\n只是分隔线\n', '正文')).toBe('正文\n')
  })

  it('正文多行原样保留；首尾空白被去掉；空正文时原样返回初始内容', () => {
    expect(mergeCapturedBody('# 标题\n', '  第一行\n第二行  ')).toBe('第一行\n第二行\n')
    expect(mergeCapturedBody('# 标题\n', '   ')).toBe('# 标题\n')
  })
})

describe('当日模式的追加（appendCaptureEntry）', () => {
  it('空文件 → 直接写一条', () => {
    expect(appendCaptureEntry('', '记得买牛奶', AT)).toBe('- 20:54 记得买牛奶\n')
  })

  it('已有内容 → 末尾追加，且只在需要时补一个空行分隔', () => {
    expect(appendCaptureEntry('# 2026-10-12\n', '记得买牛奶', AT)).toBe(
      '# 2026-10-12\n\n- 20:54 记得买牛奶\n',
    )
    // 已经有一个空行：不再补（否则每捕获一条就多空一行）
    expect(appendCaptureEntry('# 2026-10-12\n\n', '记得买牛奶', AT)).toBe(
      '# 2026-10-12\n\n- 20:54 记得买牛奶\n',
    )
    expect(appendCaptureEntry('# 2026-10-12\n\n\n', '记得买牛奶', AT)).toBe(
      '# 2026-10-12\n\n\n- 20:54 记得买牛奶\n',
    )
    // 只含空白的"空行"同样算分隔
    expect(appendCaptureEntry('# 2026-10-12\n  \n', '记得买牛奶', AT)).toBe(
      '# 2026-10-12\n  \n- 20:54 记得买牛奶\n',
    )
    // 连换行都没有
    expect(appendCaptureEntry('# 2026-10-12', '记得买牛奶', AT)).toBe(
      '# 2026-10-12\n\n- 20:54 记得买牛奶\n',
    )
  })

  it('上一条也是列表项时直接接在下一行（当日笔记是一串捕获，不该被空行拆成松散列表）', () => {
    expect(appendCaptureEntry('- 09:00 旧的一条\n', '新的一条', AT)).toBe(
      '- 09:00 旧的一条\n- 20:54 新的一条\n',
    )
    expect(appendCaptureEntry('1. 旧的一条\n', '新的一条', AT)).toBe(
      '1. 旧的一条\n- 20:54 新的一条\n',
    )
    // 上一条没有结尾换行：补一个换行，仍不空行
    expect(appendCaptureEntry('- 09:00 旧的一条', '新的一条', AT)).toBe(
      '- 09:00 旧的一条\n- 20:54 新的一条\n',
    )
    // `- ` 这种没有内容的行不是列表项：仍然补空行
    expect(appendCaptureEntry('正文\n- \n', '新的一条', AT)).toBe('正文\n- \n\n- 20:54 新的一条\n')
  })

  it('多行正文缩进续行，段内空行留在同一个列表项里', () => {
    expect(appendCaptureEntry('', '第一行\n\n第三行', AT)).toBe('- 20:54 第一行\n  \n  第三行\n')
  })

  it('空正文原样返回（不写、不补空行）', () => {
    expect(appendCaptureEntry('# 2026-10-12\n', '   ', AT)).toBe('# 2026-10-12\n')
    expect(appendCaptureEntry('', '', AT)).toBe('')
  })

  it('时间戳在追加时刻取（跨天捕获各自落在自己的当日文件）', () => {
    const beforeMidnight = new Date(2026, 9, 12, 23, 59, 0)
    const afterMidnight = new Date(2026, 9, 13, 0, 1, 0)
    expect(inboxDailyPath('Inbox', beforeMidnight)).toBe('Inbox/2026-10-12.md')
    expect(inboxDailyPath('Inbox', afterMidnight)).toBe('Inbox/2026-10-13.md')
    expect(appendCaptureEntry('', 'x', beforeMidnight)).toBe('- 23:59 x\n')
    expect(appendCaptureEntry('', 'x', afterMidnight)).toBe('- 00:01 x\n')
  })
})

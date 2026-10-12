// @vitest-environment jsdom
/**
 * 收件箱的**捕获链路**（store ↔ IPC 契约 ↔ 条目表）。
 *
 * 为什么在纯函数用例（`tests/inbox.test.ts`）之外还要一份 store 级的：
 * `capture` 里有编译器看不见的东西 —— `note_create` → `note_write` 的**调用顺序**、
 * 五个位置参数的**次序**（`baseMtimeMs` / `force` / `stampTimes`）、以及"写完有没有把条目
 * 登记进条目表"。这类错只有把 store 接上 IPC 才看得见，而它们错了的表现都是"UI 上看起来
 * 成功、磁盘上不对"。真磁盘的原子性与路径校验仍由宿主单测覆盖。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { inboxDailyPath } from '@/domain/inbox'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { inboxCount, inboxEntriesOf, useInboxStore } from '@/state/inbox-store'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\Mock\\Inbox'

/** 当日笔记的路径按**今天**算：`capture` 用的是真实时钟（否则这条用例明天就假红）。 */
const TODAY = inboxDailyPath('Inbox', new Date())
/** 刻意用 CRLF + 一条旧记录：追加必须原样保留换行风格与原文。 */
const DAILY_TEXT = '# 今天\r\n\r\n- 09:00 旧的一条\r\n'

const NOTES = [
  { relPath: 'Inbox/一条.md', text: '随手记的。\n' },
  { relPath: 'Inbox/子/二条.md', text: '子目录里的也算。\n' },
  { relPath: 'Inbox/图.png', text: 'not an image, but the extension is what matters' },
  { relPath: '项目/三条.md', text: '不是收件箱里的。\n' },
  { relPath: TODAY, text: DAILY_TEXT },
]

beforeEach(async () => {
  window.localStorage.clear()
  setIpcAdapter(createMockAdapter({ rootPath: VAULT_ROOT, notes: NOTES }))
  useNoteStore.setState({ docs: {}, activePath: null })
  // 目录的真相在设置层（它的上游是配置文件 `[inbox] dir`）—— 这里走公开 setter 复位
  useSettingsStore.getState().setInboxDir('Inbox')
  useInboxStore.setState({ captureMode: 'note', panel: 'closed', capturing: false, error: null })
  await useVaultStore.getState().openVault(VAULT_ROOT)
})

/** 让 `capture` 里那条 `void applyExternalChange(...)` 收尾（它自己会走一次静默重扫）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('条目派生与计数', () => {
  it('从条目表现算：收件箱内任意深度的 md 都算，非 md 与别处不算', () => {
    const paths = inboxEntriesOf(useVaultStore.getState().entries)
      .map((entry) => entry.relPath)
      .sort()
    expect(paths).toEqual([TODAY, 'Inbox/一条.md', 'Inbox/子/二条.md'])
    expect(inboxCount()).toBe(3)
  })

  it('改配置里的目录后判据跟着变（同一个真相，不缓存第二份列表）', () => {
    useSettingsStore.getState().setInboxDir('项目')
    expect(inboxEntriesOf(useVaultStore.getState().entries).map((entry) => entry.relPath)).toEqual([
      '项目/三条.md',
    ])
    expect(inboxCount()).toBe(1)
  })
})

describe('单篇捕获（inbox.dailyNote = false）', () => {
  it('建一篇新笔记：标题 = 时间戳 + 首行摘要，正文就是写下的那句话', async () => {
    const before = inboxCount()
    const relPath = await useInboxStore.getState().capture('记得买牛奶')

    expect(relPath).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2} \d{4} 记得买牛奶\.md$/)
    expect(relPath).not.toBeNull()
    // 正文**不是**宿主 note_create 写下的 `# 标题`：第二次 note_write 要把它换成用户那句话
    const content = await ipc.noteRead(relPath ?? '')
    expect(content.text).toBe('记得买牛奶\n')
    // 条目表也要跟上（否则树/列表里看不见刚捕获的那条）
    expect(useVaultStore.getState().entries.some((entry) => entry.relPath === relPath)).toBe(true)
    expect(inboxCount()).toBe(before + 1)
    expect(useInboxStore.getState().error).toBeNull()
  })

  it('空输入不建文件、不报错（用户按了回车又删了而已）', async () => {
    const before = inboxCount()
    expect(await useInboxStore.getState().capture('   ')).toBeNull()
    expect(inboxCount()).toBe(before)
    expect(useInboxStore.getState().error).toBeNull()
  })

  it('连续捕获两条：文件名各自唯一（时间戳同名时由宿主避让）', async () => {
    const first = await useInboxStore.getState().capture('一条')
    const second = await useInboxStore.getState().capture('一条')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(inboxCount()).toBe(5)
  })
})

describe('当日模式（inbox.dailyNote = true）', () => {
  it('追加到当日笔记末尾，并原样保留 CRLF（不留一行裸 LF）', async () => {
    useInboxStore.getState().setCaptureMode('daily')
    const relPath = await useInboxStore.getState().capture('新的一条')
    await settle()

    expect(relPath).toBe(TODAY)
    const content = await ipc.noteRead(TODAY)
    // 原文一字未动 + 上一条也是列表项 → 直接接在下一行（不带空行）
    expect(content.text.startsWith(`${DAILY_TEXT}- `)).toBe(true)
    expect(content.text).toMatch(/\r\n- \d{2}:\d{2} 新的一条\r\n$/)
    // 换行风格是文件级的：追加不会给这个 CRLF 文件塞进裸 LF
    expect(/[^\r]\n/.test(content.text)).toBe(false)
  })

  it('当日笔记不存在时先建再追加（真机上 note_create 不会替你建目录）', async () => {
    // 换一个"目录不存在"的收件箱：真实宿主的 note_create 会 NOT_FOUND，走根目录创建 + 搬入的兜底
    useSettingsStore.getState().setInboxDir('收件箱')
    useInboxStore.getState().setCaptureMode('daily')
    const relPath = await useInboxStore.getState().capture('第一条')
    await settle()

    expect(relPath).toBe(inboxDailyPath('收件箱', new Date()))
    const content = await ipc.noteRead(relPath ?? '')
    expect(content.text.endsWith('第一条\n')).toBe(true)
    expect(inboxCount()).toBe(1)
  })

  it('当日笔记正被编辑且有未保存内容时拒绝捕获（两条写入路径不同时成立）', async () => {
    useInboxStore.getState().setCaptureMode('daily')
    // 走公开 API 把它读进仓库（而不是手搓 docs 的内部形状），再改脏
    await useNoteStore.getState().openDoc(TODAY)
    useNoteStore.getState().setTextFor(TODAY, '# 今天\r\n\r\n- 09:00 旧的一条\r\n- 手改的\r\n')
    expect(useNoteStore.getState().docOf(TODAY)?.dirty).toBe(true)

    expect(await useInboxStore.getState().capture('不该写进去')).toBeNull()
    expect((await ipc.noteRead(TODAY)).text).toBe(DAILY_TEXT)
    expect(useInboxStore.getState().error).toBeNull()

    useNoteStore.getState().closeDoc(TODAY)
  })
})

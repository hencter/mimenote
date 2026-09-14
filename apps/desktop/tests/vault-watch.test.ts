/**
 * 外部改动 → 界面同步（ADR-0016）的前端一侧。
 *
 * 覆盖的是**事件到达之后**的分支：条目表刷新、当前笔记"无脏自动重载 / 有脏进冲突"。
 * 事件本身来自宿主（`src-tauri/src/watcher.rs` 的去抖逻辑与真实监听由 Rust 侧测试覆盖），
 * 这里直接把载荷喂给 store —— 与 `links-store.test.ts` 直接调用 `applyIndexStatus` 同一姿态。
 *
 * 判定依据是**重扫回来的 mtime 与文档的版本令牌**（Mock 适配器的 mtime 是单调计数器，
 * 因此每次 `simulateExternalEdit` 都必然产生一个新的 mtime，用例不依赖真实时钟）。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore, subscribeVaultChanges, VAULT_CHANGED_EVENT } from '@/state/vault-store'

let adapter: MockAdapter
/** 记录发往宿主的命令名（用来断言"真的走了重扫"与"真的没有写盘"）。 */
let calls: string[]

/** 计数适配器：转发给 Mock，同时把命令名记下来。 */
function counting(inner: MockAdapter): IpcAdapter {
  return {
    kind: 'test',
    invoke: <T,>(method: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push(method)
      return inner.invoke<T>(method, args)
    },
  }
}

/** 宿主推来的一次外部改动（`VaultChanged` 的镜像）。 */
function changed(paths: string[]): {
  paths: string[]
  truncated: boolean
  changes: number
  detectedAtMs: number
} {
  return { paths, truncated: false, changes: paths.length, detectedAtMs: Date.now() }
}

function textOnDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((item) => item.message)
}

function resetStores(): void {
  useNoteStore.getState().close()
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
  })
  useToastStore.getState().clear()
}

beforeEach(() => {
  adapter = createMockAdapter()
  calls = []
  setIpcAdapter(counting(adapter))
  resetStores()
})

describe('外部改动 → 条目表', () => {
  it('收到事件就重扫一次，并把新出现的文件放进条目表（不需要用户按重扫键）', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    calls.length = 0

    // 直接往 Mock 的"磁盘"上加一篇 —— store 事先完全不知道它（等价于外部新增）
    await adapter.invoke('note_create', { parentRel: '', title: '外部新建' })
    expect(useVaultStore.getState().entries.some((entry) => entry.relPath === '外部新建.md')).toBe(
      false,
    )

    await useVaultStore.getState().applyExternalChange(changed(['外部新建.md']))

    expect(calls.filter((method) => method === 'vault_snapshot').length).toBe(1)
    expect(useVaultStore.getState().entries.some((entry) => entry.relPath === '外部新建.md')).toBe(
      true,
    )
    expect(useVaultStore.getState().status).toBe('ready')
  })

  it('外部改动是背景事件：不弹"已重扫"这类成功提示', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    useToastStore.getState().clear()
    await useVaultStore.getState().applyExternalChange(changed(['README.md']))
    expect(toastMessages().some((message) => message.startsWith('已重扫'))).toBe(false)

    // 对照：用户自己按的重扫仍然给反馈
    await useVaultStore.getState().rescan()
    expect(toastMessages().some((message) => message.startsWith('已重扫'))).toBe(true)
  })

  it('选中项若已不在条目表里就清掉（不留一个指向不存在路径的选中）', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    useVaultStore.getState().select('并不存在的笔记.md')
    await useVaultStore.getState().applyExternalChange(changed(['README.md']))
    expect(useVaultStore.getState().selected).toBeNull()
  })
})

describe('外部改动 → 当前笔记', () => {
  it('没有未保存修改时自动重新加载（并给一条不打扰的提示）', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    await useNoteStore.getState().open('项目/设计.md')
    const before = useNoteStore.getState().doc?.revision ?? 0

    adapter.simulateExternalEdit('项目/设计.md', '# 别的设备改过了\n')
    await useVaultStore.getState().applyExternalChange(changed(['项目/设计.md']))

    const state = useNoteStore.getState()
    expect(state.doc?.text).toBe('# 别的设备改过了\n')
    expect(state.doc?.revision).toBeGreaterThan(before)
    expect(state.dirty).toBe(false)
    expect(state.conflict).toBeNull()
    expect(toastMessages()).toContain('已在磁盘上更新，已重新加载')
  })

  it('有未保存修改时进入冲突态：不覆盖磁盘、也不丢弃内存里的文本', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    await useNoteStore.getState().open('项目/设计.md')
    useNoteStore.getState().setText('# 我还没保存的修改\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    adapter.simulateExternalEdit('项目/设计.md', '# 别人写的版本\n')
    calls.length = 0
    await useVaultStore.getState().applyExternalChange(changed(['项目/设计.md']))

    const state = useNoteStore.getState()
    expect(state.status).toBe('conflict')
    expect(state.conflict).not.toBeNull()
    expect(state.dirty).toBe(true)
    expect(state.doc?.text).toBe('# 我还没保存的修改\n')
    // 磁盘保持别人的版本，而且**一次写都没有发出去**
    expect(textOnDisk('项目/设计.md')).toBe('# 别人写的版本\n')
    expect(calls).not.toContain('note_write')
  })

  it('与当前笔记无关的外部改动不动编辑器（连 revision 都不动）', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    await useNoteStore.getState().open('项目/设计.md')
    const before = useNoteStore.getState().doc?.revision ?? 0
    const text = useNoteStore.getState().doc?.text ?? ''

    adapter.simulateExternalEdit('README.md', '# 别人在别的文件里改的\n')
    await useVaultStore.getState().applyExternalChange(changed(['README.md']))

    expect(useNoteStore.getState().doc?.revision).toBe(before)
    expect(useNoteStore.getState().doc?.text).toBe(text)
    expect(useNoteStore.getState().conflict).toBeNull()
  })

  it('应用自己保存过的笔记不会被当成外部改动（mtime 与条目表一致 → 不重载）', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    await useNoteStore.getState().open('项目/设计.md')
    useNoteStore.getState().setText('# 我自己写的\n')
    await useNoteStore.getState().saveNow()
    const before = useNoteStore.getState().doc?.revision ?? 0

    // 宿主侧本来就会把"自己写的那次"过滤掉；这里再钉一遍前端这一层的判据：
    // 重扫回来的 mtime 与文档令牌相同 → 什么都不做
    await useVaultStore.getState().applyExternalChange(changed(['项目/设计.md']))

    const state = useNoteStore.getState()
    expect(state.doc?.revision).toBe(before)
    expect(state.dirty).toBe(false)
    expect(state.conflict).toBeNull()
    expect(toastMessages()).not.toContain('已在磁盘上更新，已重新加载')
  })

  it('磁盘上这篇被删掉/搬走：不假装重新加载成功，给一条明确的提示', async () => {
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    await useNoteStore.getState().open('项目/设计.md')

    await adapter.invoke('note_delete', { relPath: '项目/设计.md', confirm: true })
    await useVaultStore.getState().applyExternalChange(changed(['项目/设计.md']))

    const state = useNoteStore.getState()
    expect(state.conflict).toBeNull()
    expect(toastMessages()).toContain('磁盘上的这篇笔记已被删除或移动')
    // 编辑器里仍然是最后读到的内容（没有未保存修改，丢不了东西）
    expect(state.doc?.text).not.toBeUndefined()
  })
})

describe('事件订阅', () => {
  it('事件名与宿主一致（改了名字两边必须同时改）', () => {
    expect(VAULT_CHANGED_EVENT).toBe('mn://vault-changed')
  })

  it('浏览器预览模式（没有 Tauri 事件系统）下静默降级，不抛错', async () => {
    const dispose = subscribeVaultChanges()
    // 订阅是异步建立的（动态 import + listen），让它跑完再取消 ——
    // 真实环境里"订阅失败"是一条 console.debug，绝不能变成未处理的 rejection
    await Promise.resolve()
    expect(() => dispose()).not.toThrow()
  })
})

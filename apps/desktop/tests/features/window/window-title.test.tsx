// @vitest-environment jsdom
/**
 * 窗口标题（`features/status/window-title.ts`）。
 *
 * 标题是"任务栏 / Alt+Tab 里唯一能说明这是哪篇笔记"的东西，而它的规则很容易写错
 * （漏掉未保存标记、把路径当成标题、没有笔记时残留上一篇的名字），因此这里把
 * 三种状态与"未保存 → 已保存"的来回都钉住。真实窗口的 `setTitle` 在 jsdom 里
 * 走不到（非 Tauri 运行时），另有用例确保它**不会抛错**。
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useWindowTitle, windowTitle } from '@/features/status/window-title'

/** 装一层只调用 hook 的宿主组件。 */
function Harness(props: { relPath: string | null; dirty: boolean; rootPath: string | null }) {
  useWindowTitle(props)
  return null
}

afterEach(() => {
  cleanup()
  document.title = ''
})

describe('窗口标题', () => {
  it('没有笔记时是应用名（打开 Vault 后带上 Vault 名）', () => {
    expect(windowTitle({ relPath: null, dirty: false, rootPath: null })).toBe('Mimenote')
    expect(windowTitle({ relPath: null, dirty: false, rootPath: 'C:\\Notes\\知识库' })).toBe(
      'Mimenote — 知识库',
    )
  })

  // 标题里的笔记名**不带 .md**（ADR-0030）：任务栏与 Alt+Tab 里那是"哪一篇"的身份，
  // 而不是磁盘上的文件名（真实名字在文件树/悬停提示里）。
  it('打开笔记后是"笔记名 — 应用名"，只取文件名而不是路径，且不带 .md', () => {
    expect(
      windowTitle({ relPath: '项目/子项目/细节.md', dirty: false, rootPath: 'C:\\Notes\\知识库' }),
    ).toBe('细节 — Mimenote')
  })

  it('未保存时加一个圆点，保存后又消失', () => {
    expect(windowTitle({ relPath: '甲.md', dirty: true, rootPath: null })).toBe('甲 • — Mimenote')
    expect(windowTitle({ relPath: '甲.md', dirty: false, rootPath: null })).toBe('甲 — Mimenote')
  })

  it('隐藏的只是**笔记**的扩展名：附件一类原样保留', () => {
    // `displayName` 的边界（ADR-0030）：只有 `.md` / `.markdown` 会被剥掉 ——
    // "图"与"图.png"是两回事，后者去掉扩展名就认不出是什么文件了。
    expect(windowTitle({ relPath: '附件/图.png', dirty: false, rootPath: null })).toBe(
      '图.png — Mimenote',
    )
  })

  it('把标题写到 document.title（浏览器标签在 dev 下也跟着变）', () => {
    const view = render(<Harness relPath="项目/设计.md" dirty={false} rootPath={null} />)
    expect(document.title).toBe('设计 — Mimenote')

    view.rerender(<Harness relPath="项目/设计.md" dirty rootPath={null} />)
    expect(document.title).toBe('设计 • — Mimenote')

    view.rerender(<Harness relPath={null} dirty={false} rootPath={null} />)
    expect(document.title).toBe('Mimenote')
  })

  it('非 Tauri 运行时不会尝试设置窗口标题（也不报错）', () => {
    // jsdom 里 `isTauriRuntime()` 为 false：这条断言的是"不抛错、不留 Promise 拒绝"
    render(<Harness relPath="甲.md" dirty rootPath={null} />)
    expect(document.title).toContain('甲')
  })
})

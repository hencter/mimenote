/**
 * 模板清单 store（`state/template-store.ts`）与「从模板新建」的取数口测试。
 *
 * 这一层的关键行为只有三条：
 * 1. **空目录不是错误**（宿主返回空数组）：对话框据此说"还没有模板"，而不是报错；
 * 2. 清单来自宿主命令 `templates_list`（模板在 `.mimenote/` 下，条目表里没有它们）；
 * 3. "要问哪些问题"只看**同一份**模板正文（`collectTemplatePrompts` 与展开同源）。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_TEMPLATES_DIR } from '@/state/settings-store'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useTemplateStore, templateTitle } from '@/state/template-store'
import { describeTemplateNotes, readTemplateForCreate } from '@/features/template/from-template'
import type { TemplateNote } from '@/domain/template/expand'

const TEMPLATES = [
  { relPath: '.mimenote/templates/日记.md', text: '# @today\n\n@cursor' },
  { relPath: '.mimenote/templates/会议.md', text: '## @prompt=主题\n\n@prompt=参与者\n' },
  { relPath: '.mimenote/templates/说明.txt', text: '不是 Markdown' },
]

let adapter: MockAdapter

function reset(): void {
  useTemplateStore.setState({
    open: false,
    dir: DEFAULT_TEMPLATES_DIR,
    status: 'idle',
    templates: [],
    error: null,
    selected: null,
  })
}

beforeEach(() => {
  adapter = createMockAdapter({ notes: TEMPLATES })
  setIpcAdapter(adapter)
  reset()
})

describe('清单', () => {
  it('打开对话框即列出目录里的 `.md`（非 Markdown 不算模板）', async () => {
    await useTemplateStore.getState().openPicker()

    const state = useTemplateStore.getState()
    expect(state.open).toBe(true)
    expect(state.dir).toBe(DEFAULT_TEMPLATES_DIR)
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
    expect(state.templates.map((file) => file.relPath)).toEqual([
      '.mimenote/templates/会议.md',
      '.mimenote/templates/日记.md',
    ])
  })

  it('显示标题按 `displayName` 口径（不含 `.md`）', async () => {
    await useTemplateStore.getState().openPicker()
    const first = useTemplateStore.getState().templates[0]
    expect(first === undefined ? '' : templateTitle(first)).toBe('会议')
  })

  it('目录可配置：显式给的目录优先于设置里的默认值', async () => {
    await useTemplateStore.getState().openPicker('.mimenote/templates')
    expect(useTemplateStore.getState().dir).toBe('.mimenote/templates')

    await useTemplateStore.getState().openPicker('.mimenote/别的')
    expect(useTemplateStore.getState().dir).toBe('.mimenote/别的')
    expect(useTemplateStore.getState().templates).toEqual([])
  })

  it('空目录是正常状态，不是错误', async () => {
    setIpcAdapter(createMockAdapter({ notes: [] }))
    await useTemplateStore.getState().openPicker()

    const state = useTemplateStore.getState()
    expect(state.status).toBe('ready')
    expect(state.templates).toEqual([])
    expect(state.error).toBeNull()
  })

  it('读不出来时把原因留在 `error` 里（对话框照实写出来）', async () => {
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(): Promise<T> {
        throw { code: 'IO', message: '磁盘读不了', detail: null, currentMtimeMs: null }
      },
    })
    await useTemplateStore.getState().openPicker()

    const state = useTemplateStore.getState()
    expect(state.status).toBe('error')
    expect(state.templates).toEqual([])
    expect(state.error?.code).toBe('IO')
  })

  it('关闭对话框不清清单（下次打开先用旧清单渲染一帧，不闪空白）', async () => {
    await useTemplateStore.getState().openPicker()
    const listed = useTemplateStore.getState().templates
    useTemplateStore.getState().closePicker()
    expect(useTemplateStore.getState().open).toBe(false)
    expect(useTemplateStore.getState().templates).toBe(listed)
  })

  it('选中项可设可清（对话框回显用）', async () => {
    await useTemplateStore.getState().openPicker()
    useTemplateStore.getState().select('.mimenote/templates/日记.md')
    expect(useTemplateStore.getState().selected).toBe('.mimenote/templates/日记.md')
    useTemplateStore.getState().select(null)
    expect(useTemplateStore.getState().selected).toBeNull()
  })
})

describe('取模板正文', () => {
  it('正文与"要问哪些问题"来自同一份文本', async () => {
    const prepared = await readTemplateForCreate('.mimenote/templates/会议.md')
    expect(prepared?.text).toBe('## @prompt=主题\n\n@prompt=参与者\n')
    // 标签按出现顺序、同标签去重（标签就是那个问题）
    expect(prepared?.prompts).toEqual(['主题', '参与者'])
  })

  it('没有 `@prompt` 的模板问题清单为空（对话框直接创建）', async () => {
    const prepared = await readTemplateForCreate('.mimenote/templates/日记.md')
    expect(prepared?.prompts).toEqual([])
  })

  it('模板读不到时返回 `null`（对话框留在原地）', async () => {
    expect(await readTemplateForCreate('.mimenote/templates/不存在.md')).toBeNull()
  })
})

describe('提示文案', () => {
  const note = (kind: TemplateNote['kind'], raw: string): TemplateNote => ({ kind, raw })

  it('没有提示时返回 `null`（不弹空 toast）', () => {
    expect(describeTemplateNotes([])).toBeNull()
  })

  it('未识别的记号点名列出；其余两种各有一句', () => {
    expect(describeTemplateNotes([note('unknown', '@foo'), note('unknown', '@bar')])).toBe(
      '未识别的记号已原样保留：@foo、@bar',
    )
    expect(describeTemplateNotes([note('extra-cursor', '@cursor')])).toBe(
      '模板里有多个 @cursor，只有第一个生效（其余原样保留）',
    )
    expect(describeTemplateNotes([note('clipboard-missing', '@clipboard')])).toBe(
      '剪贴板里没有内容，@clipboard 展开成了空',
    )
    expect(
      describeTemplateNotes([note('unknown', '@foo'), note('extra-cursor', '@cursor')]),
    ).toBe('未识别的记号已原样保留：@foo；模板里有多个 @cursor，只有第一个生效（其余原样保留）')
  })
})

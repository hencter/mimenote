// @vitest-environment jsdom
/**
 * `![[图.png|300]]` 的尺寸语法（Obsidian 兼容）。
 *
 * 为什么值得一条用例：从 Obsidian 迁移过来的笔记里这种写法到处都是，而我们此前一律把别名
 * 当**图注** —— 结果是"尺寸设置全部失效，图上还多出一行 `300`"。三处必须用**同一套判据**：
 * 纯函数（`parseImageSize`）、阅读视图渲染（`domain/markdown.ts`）、所见即所得 widget
 * （`live-preview/build.ts` → `widgets.ts`）—— 任何一处自己判一套，就会出现
 * "编辑器里是 240px、切到阅读视图变回原图大小"。
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { parseImageSize } from '@/domain/assets'
import { renderMarkdown } from '@/domain/markdown'
import { flushAssets, resetAssets, stageAsset } from '@/features/editor/cm/live-preview/assets'
import { createEditorExtensions } from '@/features/editor/cm/setup'
import { ImageWidget } from '@/features/editor/cm/live-preview/widgets'
import { makeEntry, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

const VAULT_ROOT = 'C:\\Vault'

/** 渲染时给所有图片一个"已授权"的答案（尺寸语法与授权链路无关，这里是隔离变量）。 */
const READY_ENV = {
  resolveImage: () => ({ kind: 'ready' as const, url: 'asset://localhost/x.png' }),
}

/** jsdom 没有实现 `Range.getClientRects`（CodeMirror 画光标时会调用）：补个空实现让输出干净。 */
beforeAll(() => {
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => [] as unknown as DOMRectList
  }
})

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  resetAssets()
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({ status: 'idle', info: null, entries: [], tree: [], selected: null })
})

afterEach(() => {
  cleanup()
  resetAssets()
})

describe('parseImageSize（纯函数）', () => {
  it('纯数字是宽度，`宽x高` 是两项', () => {
    expect(parseImageSize('300')).toEqual({ width: 300, height: null })
    expect(parseImageSize('300x200')).toEqual({ width: 300, height: 200 })
    // 大小写与全角乘号都认（用户从别处粘过来的写法）
    expect(parseImageSize('300X200')).toEqual({ width: 300, height: 200 })
    expect(parseImageSize('300×200')).toEqual({ width: 300, height: 200 })
    expect(parseImageSize(' 300 ')).toEqual({ width: 300, height: null })
  })

  it('不是尺寸的别名一律当图注（这是最容易误伤中文笔记的一处）', () => {
    // 这些在中文笔记里都是**正常的图注**，绝不能被当成尺寸
    expect(parseImageSize('300 字以内')).toBeNull()
    expect(parseImageSize('图注')).toBeNull()
    expect(parseImageSize('宽度 300')).toBeNull()
    expect(parseImageSize('300px')).toBeNull()
    expect(parseImageSize('3.5')).toBeNull()
    // 0 与越界值不是有意义的尺寸：0 会让图消失，999999 会把排版撑爆
    expect(parseImageSize('0')).toBeNull()
    expect(parseImageSize('999999')).toBeNull()
    expect(parseImageSize('')).toBeNull()
    expect(parseImageSize(null)).toBeNull()
    expect(parseImageSize(undefined)).toBeNull()
  })
})

describe('阅读视图渲染', () => {
  it('`|300` 渲染成 width 属性，且**不**出现图注', () => {
    const html = renderMarkdown('![[图.png|300]]', READY_ENV)

    expect(html).toContain('width="300"')
    expect(html).not.toContain('height=')
    // 尺寸标记不是图注：图上不该多出一行 "300"
    expect(html).not.toContain('mn-image__caption')
    // 无障碍文本退回到文件名（而不是空 alt）
    expect(html).toContain('alt="图.png"')
  })

  it('`|300x200` 两个属性都写；普通别名仍是图注、不带 width', () => {
    const sized = renderMarkdown('![[图.png|300x200]]', READY_ENV)
    expect(sized).toContain('width="300"')
    expect(sized).toContain('height="200"')

    const captioned = renderMarkdown('![[图.png|一张示意图]]', READY_ENV)
    expect(captioned).toContain('mn-image__caption')
    expect(captioned).toContain('一张示意图')
    expect(captioned).not.toContain('width=')
  })

  it('普通 Markdown 图片不受影响（这种写法没有尺寸语法）', () => {
    const html = renderMarkdown('![说明](附件/图.png)', READY_ENV)
    expect(html).not.toContain('width=')
    expect(html).toContain('mn-image__caption')
  })
})

describe('所见即所得里的尺寸', () => {
  /** 图片 widget 本体：给了尺寸就写 `width`/`height` 属性（只写宽度时浏览器按比例缩放）。 */
  it('widget 把尺寸写成 width / height 属性', () => {
    const withWidth = new ImageWidget('asset://x.png', '图.png', '图.png', {
      width: 240,
      height: null,
    }).toDOM()
    expect(withWidth.querySelector('img')?.getAttribute('width')).toBe('240')
    expect(withWidth.querySelector('img')?.getAttribute('height')).toBeNull()

    const withBoth = new ImageWidget('asset://x.png', '图.png', '图.png', {
      width: 240,
      height: 160,
    }).toDOM()
    expect(withBoth.querySelector('img')?.getAttribute('width')).toBe('240')
    expect(withBoth.querySelector('img')?.getAttribute('height')).toBe('160')

    // 没写尺寸时一个属性都不加（尺寸完全交给 CSS 的封顶规则）
    const plain = new ImageWidget('asset://x.png', '图.png', '图.png').toDOM()
    expect(plain.querySelector('img')?.getAttribute('width')).toBeNull()
  })

  it('两个尺寸不同的 widget 不相等（否则 CodeMirror 会复用旧 DOM，尺寸改不动）', () => {
    const a = new ImageWidget('asset://x.png', '图.png', '', { width: 240, height: null })
    const b = new ImageWidget('asset://x.png', '图.png', '', { width: 320, height: null })
    const sameAsA = new ImageWidget('asset://x.png', '图.png', '', { width: 240, height: null })

    expect(a.eq(b)).toBe(false)
    expect(a.eq(sameAsA)).toBe(true)
  })

  it('文档里的 `![[图.png|240]]` 一路走到 widget：真装配下 img 带着 width', async () => {
    // 走真实路径：装饰层读授权缓存 → widget 渲染 <img>。先把缓存"喂"成已授权状态。
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    }
    try {
      useVaultStore.setState({
        info: {
          rootPath: VAULT_ROOT,
          name: 'Vault',
          entryCount: 2,
          noteCount: 1,
          folderCount: 1,
          truncated: false,
          skipped: 0,
          scanMs: 0,
        },
        entries: [makeEntry({ relPath: '笔记/图片.md' }), makeEntry({ relPath: '图.png' })],
      })
      useNoteStore.setState({
        doc: {
          relPath: '笔记/图片.md',
          text: '',
          format: { bom: false, eol: '\n' },
          baseMtimeMs: 0,
          sizeBytes: 0,
          revision: 1,
          openedAt: 0,
        },
      })
      stageAsset(VAULT_ROOT, '图.png')
      flushAssets()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const doc = '![[图.png|240]]\n\n尾巴'
      const state = EditorState.create({ doc, extensions: createEditorExtensions({}, true) })
      const view = new EditorView({ state, parent: document.body })
      try {
        // 光标停在末尾：图片那一行不在光标处 ⇒ 换成 widget
        view.dispatch({ selection: { anchor: doc.length } })
        const image = view.dom.querySelector<HTMLImageElement>('img.mn-md-image')
        expect(image).not.toBeNull()
        expect(image?.getAttribute('width')).toBe('240')
      } finally {
        view.destroy()
      }
    } finally {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
    }
  })
})

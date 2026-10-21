/** 主题完整性：所有内置主题必须提供全部令牌（防止改了 CSS 忘了改 JSON）。 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME_ID, THEMES, getTheme, nextThemeId } from '@/theme/apply'
import { REQUIRED_TOKENS, validateTheme } from '@/theme/tokens'

describe('主题', () => {
  it('至少加载到默认主题', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(2)
    expect(THEMES.some((theme) => theme.id === DEFAULT_THEME_ID)).toBe(true)
  })

  it('每个内置主题都完整、id 唯一、令牌命名合法', () => {
    const ids = new Set<string>()
    for (const theme of THEMES) {
      expect(validateTheme(theme), `主题 ${theme.id} 校验失败`).toEqual([])
      expect(ids.has(theme.id)).toBe(false)
      ids.add(theme.id)
      expect(['dark', 'light']).toContain(theme.appearance)
    }
  })

  it('令牌清单受控：缺失会被 validateTheme 指出', () => {
    const broken = {
      id: 'broken',
      name: '残缺',
      appearance: 'dark' as const,
      tokens: { '--mn-bg': '#000' },
    }
    const problems = validateTheme(broken)
    expect(problems).toContain('--mn-fg')
    expect(problems.length).toBe(REQUIRED_TOKENS.length - 1)
  })

  it('非法令牌名会被指出', () => {
    const theme = THEMES[0]
    expect(theme).toBeDefined()
    if (theme === undefined) return
    const problems = validateTheme({ ...theme, tokens: { ...theme.tokens, 'color': 'red' } })
    expect(problems.some((problem) => problem.includes('非法令牌名'))).toBe(true)
  })

  it('默认主题排在最前，未知 id 回退到第一个主题', () => {
    expect(THEMES[0]?.id).toBe(DEFAULT_THEME_ID)
    expect(getTheme('不存在的主题').id).toBe(DEFAULT_THEME_ID)
  })

  it('默认与纸墨均支持日间/夜间，且默认日间优先', () => {
    expect(DEFAULT_THEME_ID).toBe('mimenote-light')
    expect(THEMES.map((theme) => theme.id)).toEqual([
      'mimenote-light',
      'mimenote-dark',
      'mimenote-paper',
      'mimenote-paper-dark',
    ])

    const expected: Record<string, 'light' | 'dark'> = {
      'mimenote-light': 'light',
      'mimenote-dark': 'dark',
      'mimenote-paper': 'light',
      'mimenote-paper-dark': 'dark',
    }
    for (const [id, appearance] of Object.entries(expected)) {
      const theme = getTheme(id)
      expect(theme.appearance, id).toBe(appearance)
      expect(theme.name, id).toBe(id.includes('paper') ? '纸墨' : '默认')
    }
  })

  it('「纸墨」主题的日间和夜间版本都在内置清单里且令牌完整', () => {
    for (const [id, appearance] of [
      ['mimenote-paper', 'light'],
      ['mimenote-paper-dark', 'dark'],
    ] as const) {
      const theme = THEMES.find((candidate) => candidate.id === id)
      expect(theme, id).toBeDefined()
      if (theme === undefined) continue
      expect(theme.appearance).toBe(appearance)
      expect(validateTheme(theme)).toEqual([])
    }
  })

  it('派生表面、交互和阴影颜色使用 color-mix()', () => {
    const derivedTokens = ['--mn-hover', '--mn-active', '--mn-selection', '--mn-shadow']
    for (const theme of THEMES) {
      for (const token of derivedTokens) {
        expect(theme.tokens[token], `${theme.id} 的 ${token} 应使用 color-mix()`).toContain('color-mix(')
      }
    }
  })

  it('固定品牌基色由 CSS 令牌层提供', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/styles/tokens.css').replace(/\\/gu, '/'),
      'utf8',
    )
    for (const [token, value] of [
      ['--mn-brand-ink', '#593719'],
      ['--mn-brand-paper', '#FCF7ED'],
      ['--mn-brand-ochre', '#C37F2C'],
      ['--mn-brand-carbon', '#171614'],
      ['--mn-brand-sand', '#E7D5BD'],
    ] as const) {
      expect(source).toContain(`${token}: ${value};`)
    }
  })

  it('nextThemeId 循环切换（走满一圈回到起点，中途不重复）', () => {
    // 断言不能假设"只有两个主题"（新增主题时 `next(next(first)) === first` 就会假红）：
    // 走满 THEMES.length 步必须正好遍历每个主题一次并回到起点
    const seen: string[] = [DEFAULT_THEME_ID]
    for (let step = 1; step < THEMES.length; step += 1) {
      seen.push(nextThemeId(seen[seen.length - 1] as string))
    }
    expect(new Set(seen).size).toBe(THEMES.length)
    expect(nextThemeId(seen[seen.length - 1] as string)).toBe(DEFAULT_THEME_ID)
  })
})

/**
 * 选中高亮（用户报："选中文本没有高亮，无法确认是否选中了"）。
 *
 * 这两条是**结构性**判据，不是观感偏好：
 * 1. CM 的选区层默认画在内容**下面**（`layer({ above: false })`），而正文里渲染出来的块
 *    （callout / 表格 / 代码块 / 图片）都带不透明底色 —— 不把这一层抬上来，往块里选字就是**必然**
 *    看不见高亮（不是"颜色淡"的问题）；
 * 2. 抬到内容之上后，图案必须是**半透明**的：不透明的色块会把选中的字整个糊住。
 *
 * 颜色仍然只有一份来源：主题令牌 `--mn-selection`（`color-mix` 只给它加透明度）。
 *
 * 为什么读**源码文本**而不是读 `mnEditorTheme.spec`：CM 的 `EditorView.theme()` 返回的是
 * 编译后的样式扩展，原始 spec 不再对外暴露；而这一层要钉的恰恰是"写下来的那两条 CSS 声明"。
 * 同一套做法在 `tests/theme/design-tokens.test.ts` / `tests/features/tabs/tabs.test.tsx` 里已经用过。
 */
describe('编辑器的选中高亮', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/editor/cm/theme.ts').replace(/\\/gu, '/'),
    'utf8',
  )

  it('选区层抬到内容之上（否则被渲染块的底色整段盖住）', () => {
    const matched = /'\.cm-selectionLayer':\s*\{\s*zIndex:\s*(\d+)/u.exec(source)
    expect(matched, '主题里应当把 .cm-selectionLayer 的 zIndex 抬起来').not.toBeNull()
    expect(Number(matched?.[1])).toBeGreaterThan(0)
  })

  it('选区图案是半透明的，且颜色仍然来自 --mn-selection', () => {
    const matched = /\.cm-selectionBackground[^']*':\s*\{\s*backgroundColor:\s*'([^']+)'/u.exec(source)
    expect(matched, '主题里应当有 .cm-selectionBackground 的背景声明').not.toBeNull()
    const background = matched?.[1] ?? ''
    expect(background).toContain('var(--mn-selection)')
    expect(background).toContain('transparent')
  })
})

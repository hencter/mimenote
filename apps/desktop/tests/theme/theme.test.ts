/** 主题完整性：所有内置主题必须提供全部令牌（防止改了 CSS 忘了改 JSON）。 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME_ID, THEMES, getTheme, nextThemeId, themeLabel } from '@/theme/apply'
import { REQUIRED_TOKENS, validateTheme } from '@/theme/tokens'

type RGB = readonly [number, number, number]

const BRAND_COLORS: Readonly<Record<string, string>> = {
  '--mn-brand-ink': '#593719',
  '--mn-brand-paper': '#FCF7ED',
  '--mn-brand-ochre': '#C37F2C',
  '--mn-brand-carbon': '#171614',
  '--mn-brand-sand': '#E7D5BD',
}

/** 解析内置主题使用的 HEX、var() 与 color-mix(in srgb, ...) 子集。 */
function resolveThemeColor(expression: string, tokens: Readonly<Record<string, string>>, depth = 0): RGB {
  if (depth > 20) throw new Error(`主题颜色变量循环：${expression}`)
  const value = expression.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value)
  if (hex?.[1] !== undefined) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((part) => part + part).join('') : hex[1]
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)) as unknown as RGB
  }

  const variable = /^var\((--[\w-]+)\)$/u.exec(value)
  if (variable?.[1] !== undefined) {
    const key = variable[1]
    const target = tokens[key] ?? BRAND_COLORS[key]
    if (target === undefined) throw new Error(`无法解析主题颜色变量：${key}`)
    return resolveThemeColor(target, tokens, depth + 1)
  }

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+?)\s+(\d+(?:\.\d+)?)%\)$/u.exec(value)
  if (mix?.[1] !== undefined && mix[2] !== undefined && mix[3] !== undefined && mix[4] !== undefined) {
    const first = resolveThemeColor(mix[1], tokens, depth + 1)
    const second = resolveThemeColor(mix[3], tokens, depth + 1)
    const firstWeight = Number(mix[2]) / (Number(mix[2]) + Number(mix[4]))
    return first.map((channel, index) =>
      Math.round(channel * firstWeight + (second[index] ?? 0) * (1 - firstWeight)),
    ) as unknown as RGB
  }

  throw new Error(`不支持的主题颜色表达式：${value}`)
}

function relativeLuminance(color: RGB): number {
  const [red, green, blue] = color.map((channel) => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

function themeContrastRatio(
  foreground: string,
  background: string,
  tokens: Readonly<Record<string, string>>,
): number {
  const foregroundLuminance = relativeLuminance(resolveThemeColor(foreground, tokens))
  const backgroundLuminance = relativeLuminance(resolveThemeColor(background, tokens))
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

const CALLOUT_TOKENS = [
  '--mn-callout-note',
  '--mn-callout-abstract',
  '--mn-callout-info',
  '--mn-callout-todo',
  '--mn-callout-tip',
  '--mn-callout-success',
  '--mn-callout-question',
  '--mn-callout-warning',
  '--mn-callout-failure',
  '--mn-callout-danger',
  '--mn-callout-bug',
  '--mn-callout-example',
  '--mn-callout-quote',
] as const

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

  it('主题显示名带明暗后缀：两套家族各有日夜，名字必须互不相同', () => {
    const labels = THEMES.map(themeLabel)
    expect(new Set(labels).size).toBe(THEMES.length)
    expect(themeLabel(getTheme('mimenote-light'))).toBe('默认（浅色）')
    expect(themeLabel(getTheme('mimenote-dark'))).toBe('默认（深色）')
    expect(themeLabel(getTheme('mimenote-paper'))).toBe('纸墨（浅色）')
    expect(themeLabel(getTheme('mimenote-paper-dark'))).toBe('纸墨（深色）')
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

  it('正文、链接、次级文字与状态色满足最低对比度', () => {
    const pairs = [
      { foreground: '--mn-fg', background: '--mn-bg', minimum: 7, label: '正文/主背景' },
      { foreground: '--mn-fg', background: '--mn-bg-elevated', minimum: 7, label: '正文/内容表面' },
      { foreground: '--mn-fg', background: '--mn-bg-sidebar', minimum: 7, label: '正文/侧栏' },
      { foreground: '--mn-fg-muted', background: '--mn-bg', minimum: 4.5, label: '次级文字/主背景' },
      { foreground: '--mn-fg-subtle', background: '--mn-bg', minimum: 4.5, label: '弱化文字/主背景' },
      { foreground: '--mn-fg-subtle', background: '--mn-bg-elevated', minimum: 4.5, label: '弱化文字/内容表面' },
      { foreground: '--mn-link', background: '--mn-bg', minimum: 4.5, label: '链接/主背景' },
      { foreground: '--mn-editor-fg', background: '--mn-editor-bg', minimum: 7, label: '编辑正文/编辑背景' },
      { foreground: '--mn-editor-gutter-fg', background: '--mn-editor-gutter-bg', minimum: 4.5, label: '行号/行号栏' },
      { foreground: '--mn-fg', background: '--mn-code-bg', minimum: 7, label: '正文/代码背景' },
      { foreground: '--mn-accent-fg', background: '--mn-accent', minimum: 4.5, label: '强调色文字/强调背景' },
      { foreground: '--mn-warning', background: '--mn-bg', minimum: 4.5, label: '警告色/主背景' },
      { foreground: '--mn-success', background: '--mn-bg', minimum: 4.5, label: '成功色/主背景' },
      { foreground: '--mn-danger', background: '--mn-bg', minimum: 4.5, label: '错误色/主背景' },
    ] as const

    for (const theme of THEMES) {
      for (const pair of pairs) {
        expect(
          themeContrastRatio(theme.tokens[pair.foreground], theme.tokens[pair.background], theme.tokens),
          `${theme.id} ${pair.label} 至少应达到 ${pair.minimum}:1`,
        ).toBeGreaterThanOrEqual(pair.minimum)
      }
    }
  })

  it('内置 Callout 强调文字使用主题语义色，不回落到刺眼的高饱和默认色', () => {
    const preview = readFileSync(
      resolve(process.cwd(), 'src/features/preview/preview.css').replace(/\\/gu, '/'),
      'utf8',
    )
    const semanticFallbacks = [
      'var(--mn-callout-note, var(--mn-link))',
      'var(--mn-callout-abstract, var(--mn-fg-muted))',
      'var(--mn-callout-info, var(--mn-link))',
      'var(--mn-callout-todo, var(--mn-link))',
      'var(--mn-callout-tip, var(--mn-success))',
      'var(--mn-callout-success, var(--mn-success))',
      'var(--mn-callout-question, var(--mn-link))',
      'var(--mn-callout-warning, var(--mn-warning))',
      'var(--mn-callout-failure, var(--mn-danger))',
      'var(--mn-callout-danger, var(--mn-danger))',
      'var(--mn-callout-bug, var(--mn-danger))',
      'var(--mn-callout-example, var(--mn-link))',
      'var(--mn-callout-quote, var(--mn-fg-muted))',
    ]
    for (const fallback of semanticFallbacks) {
      expect(preview, `Callout 应使用语义回退色：${fallback}`).toContain(fallback)
    }

    for (const theme of THEMES) {
      for (const token of CALLOUT_TOKENS) {
        expect(theme.tokens[token], `${theme.id} 缺少 ${token}`).toBeDefined()
        const tintedBackground = `color-mix(in srgb, var(--mn-bg) 88%, var(${token}) 12%)`
        expect(
          themeContrastRatio(theme.tokens[token], tintedBackground, theme.tokens),
          `${theme.id} ${token} 在 Callout 染色背景上的文字对比度至少应达到 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('正文行长与行距按长时间阅读优化', () => {
    const preview = readFileSync(
      resolve(process.cwd(), 'src/features/preview/preview.css').replace(/\\/gu, '/'),
      'utf8',
    )
    const editor = readFileSync(
      resolve(process.cwd(), 'src/features/editor/editor-shell.css').replace(/\\/gu, '/'),
      'utf8',
    )
    const editorTheme = readFileSync(
      resolve(process.cwd(), 'src/features/editor/cm/theme.ts').replace(/\\/gu, '/'),
      'utf8',
    )
    const livePreviewTheme = readFileSync(
      resolve(process.cwd(), 'src/features/editor/cm/live-preview/theme.ts').replace(/\\/gu, '/'),
      'utf8',
    )

    expect(preview).toContain('max-width: min(100%, 40em);')
    expect(preview).toContain('line-height: 1.78;')
    expect(editor).toContain('width: min(42em, 100%);')
    expect(editor).toContain('box-sizing: border-box;')
    expect(editorTheme).toContain("lineHeight: '1.78'")
    expect(preview).not.toContain('opacity: 0.72;')
    expect(livePreviewTheme).not.toContain("opacity: '0.62'")
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

/**
 * 设计令牌的**别名层**（VI 规范名 → `--mn-*`，ADR-0031）。
 *
 * 这一层存在的理由：VI 规范里那一套名字（`--bg-base` / `--text-primary` / `--brand-primary` /
 * `--radius-md` / `--space-4` …）要成为**公开的书写面**（插件、用户样式片段、新组件都用它），
 * 而 `--mn-*` 是**存储格式**（主题 JSON 的键、`REQUIRED_TOKENS` 的清单）—— 后者一旦改名，
 * 三套内置主题与既有片段全部作废。
 *
 * 因此这里的判据有三条，都是**结构**上的（jsdom 不做 `var()` 求值，所以读的是样式表本身）：
 *
 * 1. 每个 VI 名字都必须有定义，且指向 `--mn-*`（**不许写死颜色**）；
 * 2. 指向"必需令牌"的可以没有兜底，指向**可选令牌**的**必须**带兜底
 *    （`var(--mn-x, 兜底)`，与 ADR-0028 的 `--mn-edge-out` 同一个套路）——
 *    否则主题不提供那个令牌时，整个属性会变成非法值；
 * 3. 间距阶梯与圆角派生得对（圆角以 `--mn-radius` 为中心，换主题只改一个数）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { REQUIRED_TOKENS } from '@/theme/tokens'

/** 直接从磁盘读 app.css（与 `tests/app-shell.test.tsx` 同一套候选路径与理由）。 */
function readAppCss(): string {
  const candidates = [
    resolve(process.cwd(), 'src/styles/app.css'),
    resolve(process.cwd(), 'apps/desktop/src/styles/app.css'),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // 换下一个候选路径
    }
  }
  throw new Error(`找不到 app.css（尝试过：${candidates.join('、')}）`)
}

const appCss = readAppCss()

/** 别名层那一段（以 `--bg-base` 所在的那条规则为准）。 */
function aliasBlock(): string {
  const at = appCss.indexOf('--bg-base:')
  if (at === -1) throw new Error('app.css 里没有别名层（找不到 --bg-base）')
  const open = appCss.lastIndexOf(':root {', at)
  return appCss.slice(open, appCss.indexOf('}', at))
}

/** 取别名层里某个名字的声明值。 */
function valueOf(name: string): string {
  const matched = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, 'u').exec(aliasBlock())
  if (matched === null) throw new Error(`别名层里没有 ${name}`)
  return matched[1]!.trim()
}

/** VI 名字 → 它必须指向的存储名。 */
const COLOR_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--bg-base', '--mn-bg'],
  ['--bg-subtle', '--mn-bg-subtle'],
  ['--bg-elevated', '--mn-bg-elevated'],
  ['--bg-muted', '--mn-bg-muted'],
  ['--bg-inverse', '--mn-bg-inverse'],
  ['--text-primary', '--mn-fg'],
  ['--text-secondary', '--mn-fg-muted'],
  ['--text-tertiary', '--mn-fg-subtle'],
  ['--brand-primary', '--mn-accent'],
  ['--brand-on-primary', '--mn-accent-fg'],
  ['--brand-hover', '--mn-brand-hover'],
  ['--brand-active', '--mn-brand-active'],
  ['--success', '--mn-success'],
  ['--warning', '--mn-warning'],
  ['--danger', '--mn-danger'],
  ['--info', '--mn-info'],
  ['--border-default', '--mn-border'],
  ['--border-muted', '--mn-border-muted'],
]

const FONT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--font-ui', '--mn-font-ui'],
  ['--font-reading', '--mn-font-reading'],
  ['--font-editor', '--mn-font-editor'],
  ['--font-code', '--mn-font-mono'],
]

describe('设计令牌别名层（VI 名 → --mn-*）', () => {
  it('每个 VI 颜色名都有定义，且指向对应的 --mn-* 令牌', () => {
    for (const [alias, token] of COLOR_ALIASES) {
      expect(valueOf(alias), `${alias} 应指向 ${token}`).toContain(`var(${token}`)
    }
  })

  it('别名里**不许写死颜色**（否则主题一换就不跟随）', () => {
    const block = aliasBlock()
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/iu)
    expect(block).not.toMatch(/rgba?\(/u)
  })

  it('指向可选令牌的必须带兜底，指向必需令牌的可以不带', () => {
    const required = new Set(REQUIRED_TOKENS)
    for (const [alias, token] of [...COLOR_ALIASES, ...FONT_ALIASES]) {
      const value = valueOf(alias)
      const hasFallback = value.includes(',')
      if (required.has(token)) {
        // 必需令牌：兜底可有可无（写了也无害），但值必须指向它
        expect(value).toContain(`var(${token}`)
        continue
      }
      expect(hasFallback, `${alias} 指向的可选令牌 ${token} 必须给兜底`).toBe(true)
    }
  })

  it('可选令牌**不进** REQUIRED_TOKENS（否则既有主题会在启动时报缺令牌）', () => {
    const required = new Set(REQUIRED_TOKENS)
    for (const [alias, token] of [...COLOR_ALIASES, ...FONT_ALIASES]) {
      if (!valueOf(alias).includes(',')) continue
      expect(required.has(token), `${token} 是可选的，不该在 REQUIRED_TOKENS 里`).toBe(false)
    }
  })

  it('圆角以 --mn-radius 为中心派生，另有一个全圆角', () => {
    expect(valueOf('--radius-md')).toBe('var(--mn-radius)')
    expect(valueOf('--radius-sm')).toContain('var(--mn-radius)')
    expect(valueOf('--radius-lg')).toContain('var(--mn-radius)')
    expect(valueOf('--radius-full')).toBe('999px')
  })

  it('间距阶梯是 8pt 栅格（编号 = px ÷ 4）', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['--space-1', '4px'],
      ['--space-2', '8px'],
      ['--space-3', '12px'],
      ['--space-4', '16px'],
      ['--space-6', '24px'],
      ['--space-8', '32px'],
      ['--space-12', '48px'],
    ]
    for (const [alias, px] of expected) {
      expect(valueOf(alias), `${alias} 应是 ${px}`).toBe(px)
    }
  })

  it('字号阶梯是相对值（用户调大基础字号时整个界面一起长）', () => {
    for (const alias of ['--font-size-xs', '--font-size-sm', '--font-size-md', '--font-size-lg']) {
      expect(valueOf(alias), `${alias} 应该是 em`).toMatch(/em$/u)
    }
    expect(valueOf('--font-size-md')).toBe('1em')
  })
})

describe('默认字号：三档统一 16（VI 2.3 / 用户诉求）', () => {
  it('默认值写在设置层（那才是真值，覆盖主题 JSON 与 :root）', () => {
    // 真值来源：`state/settings-store.ts` 的 `DEFAULT_SETTINGS`，由 `font-overrides.ts`
    // 以行内变量 + `!important` 写进 `<html>`；这里只钉"三档一致"，具体数值由
    // `tests/settings*.test.tsx` 与 UI E2E 各自把守。
    const source = readFileSync(
      resolve(process.cwd(), 'src/state/settings-store.ts').replace(/\\/gu, '/'),
      'utf8',
    )
    const matched = /export const DEFAULT_SETTINGS[\s\S]*?uiFontSize:\s*(\d+),\s*editorFontSize:\s*(\d+),\s*readingFontSize:\s*(\d+),/u.exec(
      source,
    )
    expect(matched, '没读到 DEFAULT_SETTINGS 的三档字号').not.toBeNull()
    const [ui, editor, reading] = [matched?.[1], matched?.[2], matched?.[3]]
    expect(ui).toBe('16')
    expect(editor).toBe('16')
    expect(reading).toBe('16')
  })
})

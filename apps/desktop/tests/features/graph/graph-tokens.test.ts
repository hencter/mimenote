// @vitest-environment jsdom
/**
 * 主题令牌的读取（`features/graph/canvas/probe.ts`）。
 *
 * 这一层存在的唯一理由是 callout 的 13 种颜色写在 `var()` 的**兜底位置**上：
 * `getComputedStyle(html).getPropertyValue('--mn-callout-note')` 返回空串（没有任何规则声明过那个
 * 名字），只有挂着 `.mn-callout--<type>` 的元素上才有解析好的 `--mn-callout-accent`。
 * 于是"名字 → 类名"的映射与"读不到时返回 null"的降级链都必须可断言 ——
 * 读错了不会报错，只会让画布上的提示框全都变成同一个颜色。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { calloutClassForToken, createTokenReader } from '@/features/graph/canvas/probe'

const STYLE_ID = 'mn-probe-test-style'

function installStyle(css: string): void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
}

beforeEach(() => {
  document.getElementById(STYLE_ID)?.remove()
  document.documentElement.removeAttribute('style')
  for (const probe of Array.from(document.body.querySelectorAll('span[aria-hidden="true"]'))) {
    probe.remove()
  }
})

describe('令牌名 → 载体类名', () => {
  it('callout 的类型令牌映射到 app.css 里那个类', () => {
    expect(calloutClassForToken('--mn-callout-note')).toBe('mn-callout--note')
    expect(calloutClassForToken('--mn-callout-tip')).toBe('mn-callout--tip')
    expect(calloutClassForToken('--mn-callout-example')).toBe('mn-callout--example')
  })

  it('载体本身与别的令牌都不映射（问 `--mn-callout-accent` 会绕回自己）', () => {
    expect(calloutClassForToken('--mn-callout-accent')).toBeNull()
    expect(calloutClassForToken('--mn-callout-')).toBeNull()
    expect(calloutClassForToken('--mn-fg')).toBeNull()
    expect(calloutClassForToken('--mn-callout')).toBeNull()
    expect(calloutClassForToken('')).toBeNull()
  })
})

describe('读取器', () => {
  it('根元素上声明的令牌直接读得到', () => {
    document.documentElement.style.setProperty('--mn-bg', '#14161a')
    const token = createTokenReader(document.body)

    expect(token('--mn-bg')).toBe('#14161a')
    expect(token('--mn-不存在的令牌')).toBeNull()
  })

  it('callout 的类型令牌走探针元素：读的是载体上的 `--mn-callout-accent`', () => {
    // 与 app.css 逐字同构的一段：名字只出现在 `var()` 的兜底位置，元素上才有 `--mn-callout-accent`
    installStyle('.mn-callout--warning { --mn-callout-accent: #ff9100; }')
    const token = createTokenReader(document.body)

    expect(token('--mn-callout-warning')).toBe('#ff9100')
    // 没有声明过的类型：老实返回 null（由画笔回落到引用竖线色），不编一个颜色出来
    expect(token('--mn-callout-bug')).toBeNull()
  })

  it('同一个类型只建一个探针元素（重复取值不带来越来越多的 DOM）', () => {
    installStyle('.mn-callout--note { --mn-callout-accent: #448aff; }')
    const token = createTokenReader(document.body)

    expect(token('--mn-callout-note')).toBe('#448aff')
    expect(token('--mn-callout-note')).toBe('#448aff')
    expect(document.querySelectorAll('.mn-callout--note')).toHaveLength(1)
  })
})

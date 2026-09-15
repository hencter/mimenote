// @vitest-environment jsdom
/**
 * 图标尺寸**刻度**（ADR-0033）。
 *
 * 用户报的"图标大小怎么是没有统一规范的"：这个仓库当时有 **78 个调用点、9 种字面尺寸**
 * （11/12/13/14/15/16/18/22/26）—— "同一个地方的两个图标差 1px"这种事谁也发现不了。
 *
 * 现在有两道闸：
 * 1. `size` 是**联合类型**（`IconSize`），写刻度外的名字**编译不过**；
 * 2. 这一层再补一把"字面数字"的闸 —— 源码里 `<Icon size={13}>` 这种写法必须是 0 处
 *    （类型系统拦不住它：`13` 不是 `IconSize`，但将来若有人把 prop 类型放宽，这道闸还在）。
 *
 * 另外把 CSS 侧的 `--icon-*` 令牌与组件刻度钉在一起：两处数字不一致时红。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Icon, ICON_SIZES } from '@/components/Icon'

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

/** 递归列出 `src/` 下的 ts/tsx 源码（跳过 node_modules 与 dist 之类）。 */
function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (full.endsWith('.ts') || full.endsWith('.tsx')) found.push(full)
    }
  }
  walk(root)
  return found
}

const SRC = resolve(process.cwd(), 'src')

describe('图标尺寸刻度', () => {
  it('五档、升序、与 VI 的 24 网格对齐（16/20/24 + 密集处两档）', () => {
    expect(ICON_SIZES).toEqual({ xs: 12, sm: 14, md: 16, lg: 20, xl: 24 })
    const values = Object.values(ICON_SIZES)
    expect([...values].sort((left, right) => left - right)).toEqual(values)
  })

  it('组件按刻度渲染宽高，缺省是 md（16）', () => {
    const small = render(<Icon name="x" size="xs" />)
    expect(small.container.querySelector('svg')?.getAttribute('width')).toBe('12')

    const fallback = render(<Icon name="x" />)
    const svgs = fallback.container.querySelectorAll('svg')
    expect(svgs[svgs.length - 1]?.getAttribute('width')).toBe('16')
  })

  it('源码里**不许**再出现裸数字：`<Icon size={13}>` 必须是 0 处', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const matched of text.matchAll(/<Icon\b[^>]*?size=\{\s*\d+\s*\}/gu)) {
        offenders.push(`${file.replace(SRC, 'src')}: ${matched[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('`size` 的实参只用刻度名（顺带挡住 `size={someNumber}` 这种变量写法）', () => {
    const offenders: string[] = []
    const allowed = new Set(Object.keys(ICON_SIZES))
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const matched of text.matchAll(/<Icon\b[^>]*?\bsize=(?:"([^"]*)"|\{([^}]*)\})/gu)) {
        const value = matched[1] ?? matched[2] ?? ''
        if (!allowed.has(value)) offenders.push(`${file.replace(SRC, 'src')}: size=${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('CSS 侧的 `--icon-*` 与组件刻度逐字一致（两处数字不许各写各的）', () => {
    const css = readAppCss()
    for (const [name, pixels] of Object.entries(ICON_SIZES)) {
      const matched = new RegExp(`--icon-${name}:\\s*(\\d+)px`, 'u').exec(css)
      expect(matched?.[1], `--icon-${name} 应当与 ICON_SIZES.${name} 一致`).toBe(String(pixels))
    }
  })
})

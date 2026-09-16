/**
 * 样式表纪律：**没有孤儿样式表** —— 每份 `.css` 都必须真的会被打进包里，而且被它的使用方加载。
 *
 * 为什么要有这条判据（ADR-0035 的教训）：把全局标签栏换成"每格一条标签条"时，
 * `features/tabs/TabBar.tsx` 被删掉，而 `tabs.css` 的唯一导入方就是它 —— 新组件
 * `features/layout/LeafTabs.tsx` 照旧渲染 `.mn-tabs*` 那一串类名，却没人再 import 那份样式表。
 * 后果不是"少了一点装饰"，而是**整份规则都没进产物**：界面上标签条成了一个没有样式的按钮堆，
 * 用户看到的就是"我的界面样式没了"。
 *
 * 更气人的是当时全绿的门禁：所有样式断言都是"从磁盘读 `tabs.css` 再看内容"（文件在、契约对），
 * 没有任何一条断言"它真的会被打包"。所以这里补的是**链接**，不是内容：
 *
 * 1. `src/**\/*.css` 每一份都必须被某个模块以路径字面量 import（否则等于没写）；
 * 2. 定义了 `.mn-*` 类名的样式表，至少要有一个导入方**真的在用**它定义的类名 ——
 *    拦住"导入了却没人用 / 导错了文件"这种半坏状态（`app.css` 这类共享样式表也满足：
 *    它的使用方一大堆）。
 *
 * 这里直接扫源码树，不依赖打包器（与 `tests/design-tokens.test.ts` 同一条思路）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/** 与其它测试一致的候选路径：`pnpm test` 可能从仓库根或 apps/desktop 起跑。 */
function srcRoot(): string {
  const candidates = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'apps/desktop/src')]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 换下一个候选路径
    }
  }
  throw new Error(`找不到前端源码目录（尝试过：${candidates.join('、')}）`)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/** CSS 里定义的选择器类名（`url(x.png)` 那种"点号 + 扩展名"要排掉）。 */
const EXTENSIONS = new Set(['png', 'svg', 'gif', 'jpg', 'jpeg', 'webp', 'woff', 'woff2', 'ttf', 'css', 'js', 'ts'])

function definedClasses(css: string): ReadonlySet<string> {
  const classes = new Set<string>()
  for (const matched of css.matchAll(/\.([a-zA-Z][\w-]*)/gu)) {
    const name = matched[1]!
    if (!EXTENSIONS.has(name.toLowerCase())) classes.add(name)
  }
  return classes
}

/** 源码里出现的 `mn-*` 类名（含模板串拼出来的那些片段）。 */
function usedClasses(source: string): ReadonlySet<string> {
  return new Set(source.match(/mn-[a-zA-Z0-9]+(?:[-_]{1,2}[a-zA-Z0-9]+)*/gu) ?? [])
}

const ROOT = srcRoot()
const ALL = walk(ROOT)
const SHEETS = ALL.filter((file) => file.endsWith('.css'))
const MODULES = ALL.filter((file) => /\.(ts|tsx)$/u.test(file)).map((file) => {
  const source = readFileSync(file, 'utf8')
  return { file, source, classes: usedClasses(source) }
})

/** 以路径字面量 import 了某份样式表的模块。 */
function importersOf(sheet: string): ReadonlyArray<{ file: string; classes: ReadonlySet<string> }> {
  const base = sheet.split(/[\\/]/u).pop()!
  const pattern = new RegExp(`['"\`][^'"\`]*${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"\`]`, 'u')
  return MODULES.filter((module) => pattern.test(module.source))
}

describe('样式表纪律（没有孤儿样式表）', () => {
  it('扫到的样式表数量是"像样的"（防止路径写错导致本条判据空转）', () => {
    expect(SHEETS.length).toBeGreaterThan(15)
  })

  it('每一份样式表都被某个模块 import（孤儿样式表 = 整份规则进不了产物）', () => {
    const orphans = SHEETS.filter((sheet) => importersOf(sheet).length === 0).map((sheet) =>
      sheet.slice(ROOT.length + 1).replace(/\\/gu, '/'),
    )
    expect(
      orphans,
      `这些样式表没有任何导入方，改完类名就等于没写：${orphans.join('、')}\n` +
        '（ADR-0035 的 `tabs.css` 就是这么掉线的：删掉旧的唯一导入方时，新组件忘了补上 import）',
    ).toEqual([])
  })

  it('定义了 mn-* 类名的样式表，至少有一个导入方真的在用它的类名', () => {
    const idle: string[] = []
    for (const sheet of SHEETS) {
      const classes = definedClasses(readFileSync(sheet, 'utf8'))
      const own = [...classes].filter((name) => name.startsWith('mn-'))
      if (own.length === 0) continue
      const used = importersOf(sheet).some((module) => own.some((name) => module.classes.has(name)))
      if (!used) idle.push(`${sheet.slice(ROOT.length + 1).replace(/\\/gu, '/')}（类名：${own.slice(0, 3).join('、')}…）`)
    }
    expect(idle, `这些样式表有导入方，但没人用它的类名（导入错文件？）：${idle.join('；')}`).toEqual([])
  })
})

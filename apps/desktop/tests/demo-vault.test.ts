/**
 * 示例 Vault 的**完整性守卫**（`examples/demo-vault/`）。
 *
 * 为什么值得一个测试：这个目录是 README 与 `examples/demo-vault/README.md` 里那几十条
 * **手工验收步骤**的载体。它不会被任何其它测试跑到（UI E2E 用内存 Mock Vault、应用层 E2E 用
 * 临时目录），因此它坏掉时没有任何东西会响 —— 而"照着文档点了三步发现图片是占位方块"
 * 恰恰会让人怀疑功能本身。**写这个测试的直接起因就是真事**：`写作示例.md` 在 Vault 根目录，
 * 却把图片写成 `../附件/示例图片.png`（越出 Vault 根）—— 逐文件授权会让它变成占位元素，
 * 而文档里写着"应该看到图片"。
 *
 * 断言分两类：
 * 1. **结构与引用**（任何改动都不该破坏）：frontmatter 若出现就必须闭合、wikilink 目标都解析得到、
 *    图片引用都在 Vault 内且文件真的存在、目录里不留原子写的临时文件；
 * 2. **文档承诺的内容还在**：`写作示例.md` 必须继续覆盖它被文档宣称覆盖的能力（多级标题、
 *    尺寸语法、本轮新加的"级别过滤/折叠"与"粘 URL 成链接"演示）—— 否则 README 的手工验收
 *    步骤会指向不存在的东西。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAssetResolver, isImageAssetTarget, type AssetEntry } from '@/domain/assets'
import { parseOutline } from '@/domain/outline'
import { stem } from '@/domain/paths'

/**
 * 示例 Vault 的位置：vitest 的工作目录既可能是 `apps/desktop`，也可能是仓库根
 * （`pnpm test` 与 `vitest run` 的调用方式不同）—— 两个候选都试一遍，找不到就直接报错，
 * 而不是让后面的断言在空目录上"通过"。
 */
function findVaultRoot(): string {
  const candidates = [
    resolve(process.cwd(), 'examples/demo-vault'),
    resolve(process.cwd(), '../../examples/demo-vault'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '写作示例.md'))) return candidate
  }
  throw new Error(`找不到示例 Vault，试过：${candidates.join('、')}`)
}

const VAULT_ROOT = findVaultRoot()

/** Vault 内所有文件的 Vault 相对路径（POSIX 分隔符，与应用内部口径一致）。 */
function listFiles(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      result.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return result.sort()
}

const FILES = listFiles(VAULT_ROOT)
const NOTES = FILES.filter((rel) => rel.toLowerCase().endsWith('.md'))

/**
 * **不属于夹具**的笔记：示例 Vault 同时也是"手工试用/临时写作"的地方，用户随时可能在里面
 * 新建一篇草稿来试渲染。那种草稿不该让夹具的一致性检查变红（它本来就不是夹具的一部分）。
 *
 * 为什么列成显式名单而不是"凡是没写进 README 的都跳过"：显式名单在新增草稿时只会影响
 * 这一条检查、而且**看得见**（有人往里加名字时，评审会看到这行）；反过来"没写进 README
 * 就跳过"会把真正的夹具文件漏掉都不报警 —— 那个方向的放宽要危险得多。
 *
 * ⚠️ 名字要跟着草稿走：这份草稿原来叫「未命名笔记 1.md」，用户自己改成
 * 「Markdown 全元素测试用例.md」之后，白名单没跟上 —— 于是他那张**故意写的外链图片**
 * （`https://example.com/image.png`，用来试渲染外链）把"图片引用必须都在 Vault 内"这条检查点红了。
 * 用户改名/新建草稿是常态，改到这一行时只需改名字，不要放宽判据。
 */
const NOT_FIXTURE = new Set(['Markdown 全元素测试用例.md'])
const ENTRIES: AssetEntry[] = FILES.map((relPath) => ({ relPath, isDir: false }))

const read = (rel: string): string => readFileSync(join(VAULT_ROOT, ...rel.split('/')), 'utf8')

/**
 * 去掉围栏代码块与行内代码，再做文本级匹配。
 *
 * 为什么必须先剥：文档里到处是"敲 `[[` 会怎样""写成 `![[图.png|120]]`"这种**示例字面量**，
 * 它们不是真引用。不剥掉的话这个测试只会逼着文档别写例子 —— 那才是本末倒置。
 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
}

/** `[[目标]]` / `[[目标|别名]]` / `![[目标]]` 里的目标（不含锚点与别名）。 */
function wikilinkTargets(text: string): string[] {
  const targets: string[] = []
  for (const match of stripCode(text).matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    const inner = (match[1] ?? '').split('|')[0] ?? ''
    const target = inner.split('#')[0]?.trim() ?? ''
    if (target !== '') targets.push(target)
  }
  return targets
}

/** `![](地址)` / `![说明](地址)` 里的地址。 */
function markdownImageHrefs(text: string): string[] {
  const hrefs: string[] = []
  for (const match of stripCode(text).matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]?.trim() ?? ''
    if (href !== '') hrefs.push(href)
  }
  return hrefs
}

/** 与应用同一套"裸文件名兜底"的消歧：先精确路径，再按文件名主干/全名找。 */
function resolvesToNote(target: string, entryNames: readonly string[]): boolean {
  const wanted = target.replaceAll('\\', '/').split('/').pop() ?? target
  const lower = wanted.toLowerCase()
  return entryNames.some((rel) => {
    const name = (rel.split('/').pop() ?? '').toLowerCase()
    return name === lower || stem(name) === stem(lower)
  })
}

describe('示例 Vault：结构与引用完整性', () => {
  it('目录里有笔记，且没有原子写残留的临时文件', () => {
    expect(NOTES.length).toBeGreaterThanOrEqual(8)
    const leftovers = FILES.filter((rel) => (rel.split('/').pop() ?? '').startsWith('.mimenote-'))
    // 原子写会短暂出现 `.mimenote-*.tmp`；手工验收时若看到它就很难判断是"正在写"还是"崩了"
    expect(leftovers).toEqual([])
  })

  it('每篇笔记都能解析：frontmatter 出现即闭合、大纲解析不抛错', () => {
    for (const rel of NOTES) {
      const text = read(rel)
      const lines = text.split(/\r?\n/)
      if (lines[0]?.trim() === '---') {
        const closing = lines.slice(1).findIndex((line) => line.trim() === '---')
        expect(closing, `${rel} 的 frontmatter 没有闭合`).toBeGreaterThanOrEqual(0)
      }
      expect(() => parseOutline(text), `${rel} 的大纲解析失败`).not.toThrow()
    }
  })

  it('所有 wikilink 目标都指向 Vault 里真实存在的文件', () => {
    const unresolved: string[] = []
    for (const rel of NOTES) {
      for (const target of wikilinkTargets(read(rel))) {
        if (!resolvesToNote(target, FILES)) unresolved.push(`${rel} → [[${target}]]`)
      }
    }
    expect(unresolved).toEqual([])
  })

  it('所有图片引用都在 Vault 内，且文件真实存在', () => {
    const resolver = createAssetResolver(ENTRIES)
    const problems: string[] = []
    for (const rel of NOTES) {
      // 用户在示例 Vault 里写的草稿不算夹具（见 `NOT_FIXTURE`）：试渲染时引用一张外链图片
      // 是完全合理的行为，不该让夹具的一致性检查变红。
      if (NOT_FIXTURE.has(rel)) continue
      const text = read(rel)
      const hrefs = [
        ...markdownImageHrefs(text),
        // `![[图.png]]` / `![[图.png|240]]`：别名是尺寸或图注，取目标本身
        ...wikilinkTargets(text),
      ]
      for (const href of hrefs) {
        if (!isImageAssetTarget(href)) continue
        const resolved = resolver(rel, href)
        if (resolved === null) {
          problems.push(`${rel} → ${href}（越出 Vault 或被拒绝）`)
          continue
        }
        if (!FILES.includes(resolved)) problems.push(`${rel} → ${href}（解析到 ${resolved}，但文件不存在）`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('示例 Vault：文档承诺的内容还在', () => {
  const demo = read('写作示例.md')

  it('覆盖大纲的级别过滤与折叠所需的多级结构', () => {
    const headings = parseOutline(demo)
    const levels = new Set(headings.map((heading) => heading.level))
    // 级别开关要有可点掉的级别，折叠要有"更深的子标题"可收起来
    for (const level of [1, 2, 3, 4]) {
      expect(levels.has(level), `写作示例.md 缺少 H${level} 标题`).toBe(true)
    }
    const hasSiblings = headings.filter((heading) => heading.level === 4).length >= 2
    expect(hasSiblings, 'H4 至少要两条同级标题，否则演示不了"收起一节会藏掉它下面更深的标题"').toBe(true)
  })

  it('覆盖图片的三种写法与尺寸语法', () => {
    expect(wikilinkTargets(demo)).toContain('示例图片.png')
    expect(markdownImageHrefs(demo)).toContain('附件/示例图片.png')
    // `![[图.png|240]]`：数字别名是尺寸（`parseImageSize` 的口径）
    expect(demo).toMatch(/!\[\[[^\]]+\|\d+\]\]/)
    expect(demo).toMatch(/!\[\[[^\]]+\|[^\d|\]]+\]\]/)
  })

  it('保留本轮新增能力的演示段落：粘 URL 成链接、标签面板、外部改动', () => {
    expect(demo).toContain('## 把 URL 粘到选中的文字上')
    expect(demo).toContain('## 标签：面板里直接改')
    expect(demo).toContain('## 大纲的级别过滤与章节折叠')
    // 演示"选中文字 + 粘地址"需要一个明确能被选中的短语
    expect(demo).toContain('参考文档')
    expect(read('README.md')).toContain('外部改动自动同步')
  })

  it('frontmatter 里有标签，供标签面板与图谱使用', () => {
    expect(demo).toMatch(/^---\n[\s\S]*?tags:\s*\[[^\]]+\]/m)
  })
})

describe('示例 Vault：README 与目录实际内容一致', () => {
  /**
   * README 里有一类"让你**自己新建**它来验证"的名字 —— 它们本来就不该存在于目录中。
   * 列成显式名单而不是放宽断言：新增一条"请你手动造个文件"的验收步骤时，
   * 这里会红一次，提醒写文档的人**确认那是有意的**。
   */
  const CREATED_BY_HAND = new Set(['测试同步.md'])

  it('README 表格里列出的每个文件都存在', () => {
    const readme = read('README.md')
    const missing: string[] = []
    for (const match of readme.matchAll(/`([^`]+\.(?:md|png|txt|css))`/g)) {
      const listed = (match[1] ?? '').trim()
      if (listed === '' || listed.includes('*') || CREATED_BY_HAND.has(listed)) continue
      // README 里既写 Vault 相对路径（`附件/示例图片.png`），也写裸文件名（`写作示例.md`）
      const exists = FILES.includes(listed) || FILES.some((rel) => rel.split('/').pop() === listed)
      if (!exists) missing.push(listed)
    }
    expect(missing).toEqual([])
  })

  it('README 里提到的 Vault 相对路径都能对上（防止目录改名后文档漂移）', () => {
    const readme = read('README.md')
    const paths = [...readme.matchAll(/`((?:[\w\u4e00-\u9fa5.-]+\/)+[\w\u4e00-\u9fa5.-]+)`/g)]
      .map((match) => match[1] ?? '')
      .filter((value) => !value.includes('://') && !value.startsWith('.mimenote/'))
    const missing = paths.filter((value) => !FILES.includes(value) && !value.endsWith('/'))
    expect(missing).toEqual([])
  })
})

// `posix` 只是为了避免"看起来像没用的 import"；这里显式用它拼一次 Vault 相对路径，
// 让"Vault 内路径一律用 POSIX 分隔符"这条口径在测试里也有出处。
expect(posix.join('项目', '设计文档.md')).toBe('项目/设计文档.md')

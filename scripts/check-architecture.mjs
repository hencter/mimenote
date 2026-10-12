#!/usr/bin/env node
/**
 * 前端架构门禁（无第三方依赖，Node 22 直接跑）。
 *
 * 它把 ADR-0060 定下的规则变成可执行判据。四组，每组都**只允许债务变小**：
 *
 * 1. **依赖方向**：`domain` 不得有值依赖向上；`ipc` / `theme` 不得依赖状态与界面；
 *    `state` 不得有值依赖 `features` / `app`；`components` 不得依赖 `state`。
 *    现状的越界逐条冻结在 `scripts/architecture-allowlist.json` 里 ——
 *    **修好一条就必须删掉那条登记**（登记还在就是红的），所以白名单只会变短。
 * 2. **模块级循环**：值导入构成的图上不允许出现新的强连通分量。
 * 3. **样式归属**：每个 `mn-*` BEM 块只能由**一个** CSS 文件定义；`!important` 按文件给预算；
 *    新 CSS 必须整体包在 `@layer mn.<层>` 里（层名由路径唯一决定）；CSS 文件必须被 import。
 * 4. **文件体积**：新文件 ≤ 600 行；存量超标的文件登记为"待拆"，登记值就是它的天花板。
 *
 * 为什么规则长这样（而不是 ESLint）：这个仓库已有的门禁（`check-ipc.mjs` / `check-version.mjs`）
 * 都是"零依赖 + 可被单测直接 import 的纯函数 + 一次跑全仓"的形状，并且它们的判据是
 * **三方一致性**而不是风格偏好。本脚本沿用同一形状：解析器是纯函数，规则是数据，违规清单是文件。
 *
 * 维护用法：
 *   node scripts/check-architecture.mjs                 # 校验（CI 与 `pnpm check` 走这条）
 *   node scripts/check-architecture.mjs --print-baseline # 打印"当前债务"的 allowlist JSON
 *
 * ⚠️ `--print-baseline` **只打印、绝不落盘**：它是把一次大规模重构后的新基线抄进 JSON 的工具，
 * 抄进去的部分会被 code review 看到。不要用它来消红。
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** 前端源码根（相对仓库根）。 */
const SRC = 'apps/desktop/src'
/** 债务登记文件。 */
const ALLOWLIST = 'scripts/architecture-allowlist.json'

/** 分层顺序：**只允许向下依赖**（数组里靠后的层可以 import 靠前的层）。 */
export const LAYERS = ['domain', 'ipc', 'theme', 'state', 'components', 'features', 'app']

/**
 * 每层允许 import 的层（值依赖）。type-only 依赖不在此列 —— 它会被 TS 擦除，
 * 不产生运行时耦合（`verbatimModuleSyntax: true`，见 `apps/desktop/tsconfig.json`）。
 * `src/*.tsx` 这类根文件是组合根，anything goes。
 *
 * 关于 `features → app`：这是**现状里有意为之**的一条向上调用（界面点一下 → 组合动作），
 * 39 处调用点，本轮不动它，所以列进放行名单而不是冻结成债务。真正要治的是
 * "**状态层**向上依赖界面/组合根"（`state → features|app`）—— 那会让纯逻辑无法单独测，
 * 也让纯模型被锁在 `features/**` 里（见 ADR-0060 §2）。
 */
export const ALLOWED_TARGETS = {
  domain: ['domain'],
  ipc: ['domain', 'ipc'],
  theme: ['ipc', 'theme'],
  state: ['domain', 'ipc', 'theme', 'state'],
  components: ['domain', 'ipc', 'components'],
  features: ['domain', 'ipc', 'theme', 'state', 'components', 'features', 'app'],
  app: LAYERS,
  root: [...LAYERS, 'root'],
}

/**
 * 分层规则只管**值依赖**：`import type` 会被 `verbatimModuleSyntax` 完全擦除，
 * 不产生运行时耦合，因此不构成架构约束（也就没有理由为搬一个类型去动代码）。
 * 门禁仍会在摘要里数出它们的条数，好让"类型漂移"保持可见。
 */

/** 四层样式与它们的书写顺序。顺序声明在每个文件顶部重复一遍，因此与打包顺序**无关**。 */
export const CSS_LAYER_ORDER = ['mn.tokens', 'mn.base', 'mn.components', 'mn.features']
export const CSS_LAYER_ORDER_STATEMENT = `@layer ${CSS_LAYER_ORDER.join(', ')};`

/** 新文件的物理行上限；存量超标文件走 allowlist 的 `oversizeFiles`。 */
export const NEW_FILE_LINE_LIMIT = 600

/** `domain` 里不许出现的 DOM/浏览器全局（`document.errors` 这类局部同名变量不会被误伤）。 */
const DOM_GLOBAL_PATTERN =
  /\b(?:document\.(?:createElement|createTextNode|body|head|documentElement|getElementById|querySelector|querySelectorAll|execCommand|addEventListener)|window\.|localStorage\.|sessionStorage\.|navigator\.(?:clipboard|platform|userAgent)|HTMLElement|DOMParser)\b/

// ---------------------------------------------------------------------------
// 文件收集与路径工具（纯函数，单测直接喂字符串）
// ---------------------------------------------------------------------------

/** 递归列出目录下全部普通文件的绝对路径。 */
export function walkFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

/** 仓库相对路径 → POSIX 形式（Windows 上 `\` 会破坏后面所有比较）。 */
export function toPosix(path) {
  return path.split('\\').join('/')
}

/** `apps/desktop/src/state/graph-store.ts` → `state`；根文件（`App.tsx`）→ `root`。 */
export function layerOf(relPath) {
  const inner = toPosix(relPath).replace(`${SRC}/`, '')
  const top = inner.split('/')[0]
  return LAYERS.includes(top) ? top : 'root'
}

/** CSS 文件应属于哪一层（由路径唯一决定，没有例外），未知位置返回 `null`。 */
export function expectedCssLayer(relPath) {
  const rel = toPosix(relPath)
  if (rel === `${SRC}/styles/tokens.css`) return 'mn.tokens'
  if (rel.startsWith(`${SRC}/styles/`)) return 'mn.base'
  if (rel.startsWith(`${SRC}/components/`)) return 'mn.components'
  if (rel.startsWith(`${SRC}/features/`)) return 'mn.features'
  return null
}

/** `mn-tree-row__chevron--open` → `mn-tree-row`（BEM 块 = 到第一个 `__` / `--` 为止）。 */
export function blockOf(className) {
  const cut = className.search(/__|--/)
  return cut === -1 ? className : className.slice(0, cut)
}

/** 去掉 `/* … *​/` 块注释（保留换行数，行号才不会漂）。 */
export function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
}

/**
 * 扫描式去掉注释与字符串内容（字符串里的 `{` `}` `!important` 不算数）。
 *
 * `stripBlockComments` 不够用：`content: "}"` 会让朴素的花括号计数错位。
 */
export function blankCommentsAndStrings(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      out += source.slice(i, Math.min(j + 1, source.length)).replace(/[^\n]/g, ' ')
      i = j + 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 解析一个 TS/TSX 文件里的 import / export…from。
 *
 * 返回 `{ specifier, typeOnly, line, sideEffect, dynamic }`。
 * `typeOnly` 用于判定"是否是运行时依赖"：
 * - `import type { X } from '…'` / `export type … from`；
 * - `import { type A, type B } from '…'`（**全部**具名导入都带 `type`）；
 * 两者都会被 `verbatimModuleSyntax` 擦掉。
 */
export function parseImports(source) {
  const out = []
  const lineOf = (index) => source.slice(0, index).split('\n').length
  const statement = /(^|\n)[ \t]*(import|export)\b([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/g
  let match
  while ((match = statement.exec(source)) !== null) {
    const head = match[2] + match[3]
    let typeOnly = /^\s*(import|export)\s+type\b/.test(head)
    const braced = head.match(/\{([\s\S]*)\}/)
    if (!typeOnly && braced !== null) {
      const items = braced[1]
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
      typeOnly = items.length > 0 && items.every((item) => /^type\s/.test(item))
    }
    out.push({ specifier: match[4], typeOnly, line: lineOf(match.index + match[1].length), dynamic: false })
  }
  const sideEffect = /(^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g
  while ((match = sideEffect.exec(source)) !== null) {
    out.push({ specifier: match[2], typeOnly: false, line: lineOf(match.index), sideEffect: true, dynamic: false })
  }
  const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = dynamic.exec(source)) !== null) {
    out.push({ specifier: match[1], typeOnly: false, dynamic: true, line: lineOf(match.index) })
  }
  return out
}

/**
 * 把 import 说明符解析成 `apps/desktop/src` 相对、去扩展名的模块 id。
 * `@/x` → `x`；`./x` / `../x` 按 `fromRel` 所在目录解析；包名（`react`）→ `null`。
 */
export function resolveSpecifier(specifier, fromRel) {
  const rel = toPosix(fromRel)
  const inner = rel.replace(`${SRC}/`, '')
  if (specifier === '@' || specifier.startsWith('@/')) {
    const tail = specifier === '@' ? '' : specifier.slice(2)
    return posix.normalize(tail)
  }
  if (specifier.startsWith('.')) {
    const base = posix.join(posix.dirname(inner), specifier)
    return posix.normalize(base)
  }
  return null
}

/** 模块 id → 仓库相对文件路径（补扩展名与 `index`）；找不到返回 `null`。 */
export function toRepoFile(moduleId, knownFiles) {
  const candidates = [
    moduleId,
    `${moduleId}.ts`,
    `${moduleId}.tsx`,
    `${moduleId}.css`,
    `${moduleId}/index.ts`,
    `${moduleId}/index.tsx`,
  ]
  for (const candidate of candidates) {
    const repoPath = `${SRC}/${candidate}`
    if (knownFiles.has(repoPath)) return repoPath
  }
  return null
}

/**
 * 收集一个仓库的快照：代码文件、CSS 文件、值依赖边、类型依赖边、按块归属的类名。
 *
 * `edges` 里的 `to` 是仓库相对路径（已补扩展名），`from` 也是。
 */
export function collectSnapshot(directory = root) {
  const srcDir = join(directory, SRC)
  const all = walkFiles(srcDir).map(toPosix).map((path) => toPosix(relative(directory, path)))
  const codeFiles = all.filter((path) => /\.(ts|tsx)$/.test(path))
  const cssFiles = all.filter((path) => path.endsWith('.css'))
  const known = new Set(all)

  const edges = []
  const importsByFile = new Map()
  for (const file of codeFiles) {
    const source = readFileSync(join(directory, file), 'utf8')
    const parsed = parseImports(source).map((item) => {
      const moduleId = resolveSpecifier(item.specifier, file)
      const target = moduleId === null ? null : toRepoFile(moduleId, known)
      return { ...item, moduleId, target }
    })
    importsByFile.set(file, parsed)
    for (const item of parsed) {
      if (item.target === null) continue
      edges.push({
        from: file,
        to: item.target,
        typeOnly: item.typeOnly,
        kind: item.typeOnly ? 'type' : 'value',
        line: item.line,
      })
    }
  }

  const cssText = new Map()
  const cssBlocks = new Map()
  for (const file of cssFiles) {
    const source = readFileSync(join(directory, file), 'utf8')
    cssText.set(file, source)
    const classes = new Set(
      [...stripBlockComments(source).matchAll(/\.(mn-[A-Za-z0-9_-]+)/g)].map((match) => match[1]),
    )
    const blocks = new Map()
    for (const className of classes) {
      const block = blockOf(className)
      if (!blocks.has(block)) blocks.set(block, new Set())
      blocks.get(block).add(className)
    }
    cssBlocks.set(file, blocks)
  }

  return { directory, codeFiles, cssFiles, edges, importsByFile, cssText, cssBlocks }
}

// ---------------------------------------------------------------------------
// 规则：依赖方向
// ---------------------------------------------------------------------------

/**
 * 依赖方向违规清单（只统计**值依赖**，type-only 一律放行，理由见 `ALLOWED_TARGETS` 上方）。
 */
export function dependencyViolations(snapshot) {
  const out = []
  for (const edge of snapshot.edges) {
    if (edge.typeOnly) continue
    const fromLayer = layerOf(edge.from)
    const toLayer = layerOf(edge.to)
    if (!ALLOWED_TARGETS[fromLayer].includes(toLayer)) {
      out.push({ ...edge, reason: `${fromLayer} 不得值依赖 ${toLayer}` })
    }
  }
  return out
}

/** `domain` 里出现 DOM/浏览器全局的清单（纯函数层应当能在 node 环境直接测）。 */
export function domViolations(snapshot) {
  const out = []
  for (const file of snapshot.codeFiles) {
    if (layerOf(file) !== 'domain') continue
    const source = stripBlockComments(readFileSync(join(snapshot.directory, file), 'utf8'))
    source.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (DOM_GLOBAL_PATTERN.test(line)) out.push({ file, line: index + 1, text: line.trim() })
    })
  }
  return out
}

/**
 * 值导入图上的强连通分量（Tarjan），只返回大小 ≥ 2 的那个分量里的边。
 *
 * 为什么只算值导入：`import type` 被擦除，不构成运行时环。
 */
export function findCycleEdges(snapshot) {
  const adjacency = new Map()
  const nodes = new Set(snapshot.codeFiles)
  for (const edge of snapshot.edges) {
    if (edge.typeOnly) continue
    if (!nodes.has(edge.to)) continue
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set())
    adjacency.get(edge.from).add(edge.to)
  }
  let counter = 0
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const cyclic = new Set()

  const visit = (node) => {
    index.set(node, counter)
    low.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)))
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = []
      let popped
      do {
        popped = stack.pop()
        onStack.delete(popped)
        component.push(popped)
      } while (popped !== node)
      if (component.length > 1) for (const member of component) cyclic.add(member)
    }
  }
  for (const node of nodes) if (!index.has(node)) visit(node)

  const out = []
  for (const edge of snapshot.edges) {
    if (edge.typeOnly) continue
    if (cyclic.has(edge.from) && cyclic.has(edge.to)) out.push(edge)
  }
  return out
}

// ---------------------------------------------------------------------------
// 规则：样式归属
// ---------------------------------------------------------------------------

/** 一个 CSS 文件是否整体包在它该在的 `@layer mn.<层> { … }` 里。 */
export function checkCssLayering(file, source) {
  const problems = []
  const body = blankCommentsAndStrings(source)
  const lines = body.split('\n')
  const nonEmpty = lines.map((line, index) => ({ text: line.trim(), number: index + 1 })).filter((row) => row.text !== '')
  const expected = expectedCssLayer(file)
  if (expected === null) {
    problems.push(`${file}：CSS 只允许住在 styles/ 、components/ 、features/ 三处`)
    return problems
  }
  if (nonEmpty.length === 0) {
    problems.push(`${file}：空文件`)
    return problems
  }
  if (nonEmpty[0].text !== CSS_LAYER_ORDER_STATEMENT) {
    problems.push(
      `${file}:${nonEmpty[0].number}：第一行必须是层序声明 \`${CSS_LAYER_ORDER_STATEMENT}\`` +
        `（每个文件都重复一遍，层序才与打包顺序无关）`,
    )
  }
  if (file === `${SRC}/styles/tokens.css`) return problems

  const second = nonEmpty[1]
  if (second === undefined) {
    problems.push(`${file}：只有层序声明一行，缺少 \`@layer ${expected} {\``)
    return problems
  }
  if (second.text !== `@layer ${expected} {`) {
    problems.push(`${file}:${second.number}：第二行必须是 \`@layer ${expected} {\``)
    return problems
  }
  const last = nonEmpty.at(-1)
  if (last.text !== '}') {
    problems.push(`${file}:${last.number}：最后一行必须是 \`}\`（把整个文件包进那一层）`)
    return problems
  }
  // 层序声明里没有花括号，因此"整体配对 + 最后一行是 }"就等价于"那一层包住了整个文件"。
  const openCount = (body.match(/\{/g) ?? []).length
  const closeCount = (body.match(/\}/g) ?? []).length
  if (openCount !== closeCount) {
    problems.push(`${file}：花括号不配对（${openCount} 个 { / ${closeCount} 个 }，层级包装没包住整个文件）`)
  }
  return problems
}

/** 每个 BEM 块被哪些 CSS 文件定义（跨文件的项就是归属冲突）。 */
export function sharedBlocks(snapshot) {
  const owners = new Map()
  for (const [file, blocks] of snapshot.cssBlocks) {
    for (const block of blocks.keys()) {
      if (!owners.has(block)) owners.set(block, new Set())
      owners.get(block).add(file)
    }
  }
  return [...owners.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([block, files]) => ({ block, files: [...files].sort() }))
    .sort((a, b) => a.block.localeCompare(b.block))
}

/** `!important` 的出现次数（注释与字符串里的不算）。 */
export function importantCount(source) {
  return (blankCommentsAndStrings(stripBlockComments(source)).match(/!important/g) ?? []).length
}

/** 对自定义属性（`--mn-*`）用 `!important` 的地方 —— 它会压过用户在设置页的字号覆盖。 */
export function importantOnTokens(source) {
  const body = blankCommentsAndStrings(stripBlockComments(source))
  const out = []
  body.split('\n').forEach((line, index) => {
    if (/--[A-Za-z0-9-]+\s*:[^;]*!important/.test(line)) out.push({ line: index + 1, text: line.trim() })
  })
  return out
}

/** 选择器里直接写 `.cm-*` 的次数（CodeMirror 的样式应由 `EditorView.theme` 装配）。 */
export function cmSelectorCount(source) {
  const body = blankCommentsAndStrings(stripBlockComments(source))
  const out = []
  body.split('\n').forEach((line, index) => {
    const prelude = line.split('{')[0]
    for (const match of prelude.matchAll(/\.cm-[A-Za-z0-9_-]+/g)) out.push({ line: index + 1, text: match[0] })
  })
  return out
}

/** 每个 CSS 文件应当被某个 TS/TSX 以 import 引入（否则是死样式）。 */
export function importedCssFiles(snapshot) {
  const imported = new Set()
  for (const [, parsed] of snapshot.importsByFile) {
    for (const item of parsed) if (item.target !== null && item.target.endsWith('.css')) imported.add(item.target)
  }
  return imported
}

// ---------------------------------------------------------------------------
// 规则：文件体积
// ---------------------------------------------------------------------------

/**
 * 物理行数：**与编辑器显示的一致**。
 *
 * 不能直接用 `split('\n').length`：文件以换行收尾时它会多算 1 行，
 * 于是"登记值"与 `git diff --stat`、编辑器行号全部对不上。
 */
export function physicalLines(source) {
  const breaks = (source.match(/\n/g) ?? []).length
  return source.endsWith('\n') ? breaks : breaks + 1
}

/** 收集超过体积阈值的文件（含 CSS 与 TS/TSX）。 */
export function oversizeFiles(snapshot, limit = NEW_FILE_LINE_LIMIT) {
  const out = []
  for (const file of [...snapshot.codeFiles, ...snapshot.cssFiles]) {
    const lines = physicalLines(readFileSync(join(snapshot.directory, file), 'utf8'))
    if (lines > limit) out.push({ file, lines })
  }
  return out.sort((a, b) => b.lines - a.lines)
}

// ---------------------------------------------------------------------------
// 汇总校验
// ---------------------------------------------------------------------------

/**
 * 读 allowlist。
 *
 * 文件**缺失时不抛异常**：`--print-baseline` 要用它在空仓库上先跑一遍；
 * 校验路径则由 `checkArchitecture` 显式报一条"登记文件缺失"的红 —— 缺了它，
 * 所有越界都会变成"没登记"的违规，行为是安全的（宁可红，不可静默放行）。
 */
export function readAllowlist(directory = root) {
  const path = join(directory, ALLOWLIST)
  let data = {}
  let missing = false
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    missing = true
  }
  return {
    missing,
    dependencyViolations: data.dependencyViolations ?? [],
    domViolations: data.domViolations ?? [],
    cycles: data.cycles ?? [],
    cssSharedBlocks: data.cssSharedBlocks ?? [],
    cssPendingLayers: data.cssPendingLayers ?? [],
    cssImportantBudget: data.cssImportantBudget ?? {},
    cssCmSelectors: data.cssCmSelectors ?? {},
    oversizeFiles: data.oversizeFiles ?? [],
    newFileLineLimit: data.newFileLineLimit ?? NEW_FILE_LINE_LIMIT,
  }
}

/** 白名单里的登记如果在现状里已经不存在了，就是"过期登记" —— 必须删掉。 */
function staleEntries(errors, kind, registered, current, describe = (item) => JSON.stringify(item)) {
  for (const item of registered) {
    if (!current.has(describe(item))) errors.push(`${kind} 白名单已过期，请删除这一条登记：${describe(item)}`)
  }
}

/**
 * 执行全部规则；失败时抛出**一次性汇总所有违规**的错误（不只报第一处）。
 * 返回统计摘要（供 CLI 打印与单测断言）。
 */
export function checkArchitecture(directory = root) {
  const snapshot = collectSnapshot(directory)
  const allowlist = readAllowlist(directory)
  const errors = []
  const notes = []

  if (allowlist.missing) {
    errors.push(`登记文件缺失：${ALLOWLIST}（没有它就无法区分"存量债务"与"新增违规"）`)
  }

  // --- 1. 依赖方向 ---
  const deps = dependencyViolations(snapshot)
  const depKeys = new Set(deps.map((item) => `${item.from} -> ${item.to}`))
  const allowedDeps = new Set(allowlist.dependencyViolations.map((item) => `${item.file} -> ${item.to}`))
  for (const item of deps) {
    const key = `${item.from} -> ${item.to}`
    if (!allowedDeps.has(key)) {
      errors.push(`依赖方向：${item.from}:${item.line} → ${item.to}（${item.reason}）`)
    }
  }
  staleEntries(errors, '依赖方向', allowlist.dependencyViolations, depKeys, (item) => `${item.file} -> ${item.to}`)

  // --- 2. domain 纯净 ---
  // 白名单按**文件**登记而不是按行号：行号会随任何一次编辑漂移，那种登记会在
  // 无关改动上变红，教人忽略红色（见 `docs/architecture-review.md` 的"门禁自证"一节）。
  const doms = domViolations(snapshot)
  const allowedDomFiles = new Set(allowlist.domViolations)
  const currentDomFiles = new Set(doms.map((item) => item.file))
  for (const file of currentDomFiles) {
    if (!allowedDomFiles.has(file)) {
      const hits = doms.filter((item) => item.file === file)
      errors.push(
        `domain 纯净性：${file} 使用了浏览器全局（${hits.map((hit) => `L${hit.line} ${hit.text}`).join('；')}）`,
      )
    }
  }
  staleEntries(errors, 'domain 纯净性（已达标）', allowlist.domViolations, currentDomFiles, (item) => item)

  // --- 3. 模块级循环 ---
  const cycles = findCycleEdges(snapshot)
  const allowedCycles = new Set(allowlist.cycles.map((item) => `${item.from} -> ${item.to}`))
  for (const edge of cycles) {
    if (!allowedCycles.has(`${edge.from} -> ${edge.to}`)) {
      errors.push(`循环依赖：${edge.from}:${edge.line} → ${edge.to} 落在同一个环里`)
    }
  }
  staleEntries(
    errors,
    '循环依赖',
    allowlist.cycles,
    new Set(cycles.map((edge) => `${edge.from} -> ${edge.to}`)),
    (item) => `${item.from} -> ${item.to}`,
  )

  // --- 4. 样式：层、归属、!important、死样式 ---
  const pendingLayers = new Set(allowlist.cssPendingLayers)
  const currentPending = new Set()
  for (const file of snapshot.cssFiles) {
    const problems = checkCssLayering(file, snapshot.cssText.get(file))
    if (problems.length > 0) {
      currentPending.add(file)
      if (!pendingLayers.has(file)) errors.push(`样式分层：${problems.join('；')}`)
    }
  }
  staleEntries(errors, '样式分层（已迁移）', allowlist.cssPendingLayers, currentPending, (item) => item)
  notes.push(`样式分层的待迁移文件：${pendingLayers.size} 个（迁移完一个就删一条登记）`)

  const shared = sharedBlocks(snapshot)
  const allowedShared = new Set(allowlist.cssSharedBlocks.map((item) => item.block))
  for (const item of shared) {
    if (!allowedShared.has(item.block)) {
      errors.push(`样式归属：BEM 块 ${item.block} 被多个文件定义（${item.files.join(' , ')}）`)
    }
  }
  staleEntries(errors, '样式归属', allowlist.cssSharedBlocks, new Set(shared.map((item) => item.block)), (item) => item.block)

  for (const file of snapshot.cssFiles) {
    const source = snapshot.cssText.get(file)
    const budget = allowlist.cssImportantBudget[file] ?? 0
    const count = importantCount(source)
    if (count > budget) {
      errors.push(`样式 !important：${file} 有 ${count} 处，超出预算 ${budget}（必要时先写进 allowlist 并说明理由）`)
    }
    for (const hit of importantOnTokens(source)) {
      errors.push(`样式 !important：${file}:${hit.line} 对自定义属性用了 !important（${hit.text}）`)
    }
    const cmBudget = allowlist.cssCmSelectors[file] ?? 0
    const cmCount = cmSelectorCount(source).length
    if (cmCount > cmBudget) {
      errors.push(`样式 CodeMirror：${file} 里有 ${cmCount} 处 .cm-* 选择器，超出预算 ${cmBudget}`)
    }
  }

  const imported = importedCssFiles(snapshot)
  for (const file of snapshot.cssFiles) {
    if (!imported.has(file)) errors.push(`死样式：${file} 没有被任何 TS/TSX import`)
  }

  // --- 5. 文件体积 ---
  const limit = allowlist.newFileLineLimit
  const registered = new Map(allowlist.oversizeFiles.map((item) => [item.file, item.lines]))
  const currentOversize = oversizeFiles(snapshot, limit)
  for (const item of currentOversize) {
    const cap = registered.get(item.file)
    if (cap === undefined) {
      errors.push(`文件体积：${item.file} 有 ${item.lines} 行，超过 ${limit} 行且没有登记为待拆`)
    } else if (item.lines > cap) {
      errors.push(`文件体积：${item.file} 从 ${cap} 行涨到 ${item.lines} 行 —— 待拆文件只许变小`)
    }
  }
  staleEntries(
    errors,
    '文件体积（已达标）',
    allowlist.oversizeFiles,
    new Set(currentOversize.map((item) => item.file)),
    (item) => item.file,
  )

  if (errors.length > 0) throw new Error(`架构校验失败：\n${errors.join('\n')}`)

  return {
    codeFiles: snapshot.codeFiles.length,
    cssFiles: snapshot.cssFiles.length,
    valueEdges: snapshot.edges.filter((edge) => !edge.typeOnly).length,
    typeEdges: snapshot.edges.filter((edge) => edge.typeOnly).length,
    crossLayerTypeEdges: snapshot.edges.filter(
      (edge) => edge.typeOnly && layerOf(edge.from) !== layerOf(edge.to),
    ).length,
    allowedDeps: allowlist.dependencyViolations.length,
    allowedCycles: allowlist.cycles.length,
    pendingLayers: pendingLayers.size,
    sharedBlocks: shared.length,
    importantTotal: snapshot.cssFiles.reduce((sum, file) => sum + importantCount(snapshot.cssText.get(file)), 0),
    pendingSplit: allowlist.oversizeFiles.length,
    notes,
  }
}

/** 打印"当前债务"的 allowlist JSON（**只打印**，绝不落盘）。 */
export function printBaseline(directory = root) {
  const snapshot = collectSnapshot(directory)
  const allowlist = readAllowlist(directory)
  const deps = dependencyViolations(snapshot).map((item) => ({
    file: item.from,
    to: item.to,
    why: item.reason,
  }))
  const doms = [...new Set(domViolations(snapshot).map((item) => item.file))]
  const cycles = findCycleEdges(snapshot).map((edge) => ({ from: edge.from, to: edge.to }))
  const shared = sharedBlocks(snapshot)
  const pendingLayers = snapshot.cssFiles.filter((file) => checkCssLayering(file, snapshot.cssText.get(file)).length > 0)
  const importantBudget = {}
  for (const file of snapshot.cssFiles) {
    const count = importantCount(snapshot.cssText.get(file))
    if (count > 0) importantBudget[file] = count
  }
  const cmSelectors = {}
  for (const file of snapshot.cssFiles) {
    const count = cmSelectorCount(snapshot.cssText.get(file)).length
    if (count > 0) cmSelectors[file] = count
  }
  const oversize = oversizeFiles(snapshot, allowlist.newFileLineLimit).map((item) => ({ file: item.file, lines: item.lines }))
  return JSON.stringify(
    {
      $comment: 'ADR-0060 的债务登记：每个条目都是"只允许变小"的。修好一条就删掉那一条。',
      newFileLineLimit: allowlist.newFileLineLimit,
      dependencyViolations: deps,
      domViolations: doms,
      cycles,
      cssSharedBlocks: shared,
      cssPendingLayers: pendingLayers,
      cssImportantBudget: importantBudget,
      cssCmSelectors: cmSelectors,
      oversizeFiles: oversize,
    },
    null,
    2,
  )
}

/** 这个模块是"被直接运行"还是"被测试 import"（`realpathSync` 的理由见 check-version.mjs）。 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  try {
    if (process.argv.includes('--print-baseline')) {
      console.log(printBaseline(root))
    } else {
      const stats = checkArchitecture(root)
      console.log(
        `架构校验通过：${stats.codeFiles} 个源文件 / ${stats.cssFiles} 个样式表、` +
          `${stats.valueEdges} 条值依赖（冻结越界 ${stats.allowedDeps} 条、冻结环 ${stats.allowedCycles} 条）、` +
          `!important ${stats.importantTotal} 处、跨文件共享块 ${stats.sharedBlocks} 个、` +
          `待迁移分层 ${stats.pendingLayers} 个、待拆文件 ${stats.pendingSplit} 个`,
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

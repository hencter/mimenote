import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CSS_LAYER_ORDER_STATEMENT,
  blockOf,
  checkArchitecture,
  checkCssLayering,
  cmSelectorCount,
  dependencyViolations,
  domViolations,
  expectedCssLayer,
  findCycleEdges,
  importantCount,
  importantOnTokens,
  layerOf,
  parseImports,
  physicalLines,
  printBaseline,
  readAllowlist,
  resolveSpecifier,
  stripBlockComments,
} from './check-architecture.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = 'apps/desktop/src'

// ---------------------------------------------------------------------------
// 解析器单测（喂内联字符串，不碰仓库文件）
// ---------------------------------------------------------------------------

test('layerOf：顶层目录即层，src 根文件算组合根', () => {
  assert.equal(layerOf(`${SRC}/domain/tree.ts`), 'domain')
  assert.equal(layerOf(`${SRC}/features/graph/GraphCanvas.tsx`), 'features')
  assert.equal(layerOf(`${SRC}/App.tsx`), 'root')
  assert.equal(layerOf(`${SRC}/main.tsx`), 'root')
})

test('expectedCssLayer：层名由路径唯一决定', () => {
  assert.equal(expectedCssLayer(`${SRC}/styles/tokens.css`), 'mn.tokens')
  assert.equal(expectedCssLayer(`${SRC}/styles/base.css`), 'mn.base')
  assert.equal(expectedCssLayer(`${SRC}/components/ui-controls.css`), 'mn.components')
  assert.equal(expectedCssLayer(`${SRC}/features/graph/graph.css`), 'mn.features')
  assert.equal(expectedCssLayer(`${SRC}/domain/oops.css`), null)
})

test('blockOf：BEM 块到第一个 __ / -- 为止', () => {
  assert.equal(blockOf('mn-tree'), 'mn-tree')
  assert.equal(blockOf('mn-tree-row__chevron--open'), 'mn-tree-row')
  assert.equal(blockOf('mn-button--small'), 'mn-button')
})

test('parseImports：多行 import、import type、行内 type、副作用与动态 import', () => {
  const source = `
import { create } from 'zustand'
import {
  buildLayout,
  type GraphView,
} from '@/features/graph/layout'
import type { ForceParams } from '@/features/graph/force'
import { type A, type B } from '@/ipc/types'
import './graph.css'
const lazy = await import('@/ipc/mock-adapter')
`
  const parsed = parseImports(source)
  const bySpecifier = new Map(parsed.map((item) => [item.specifier, item]))
  assert.equal(bySpecifier.get('zustand').typeOnly, false)
  // 多行 import 里混了 `type GraphView`，但不是"全部都是 type" ⇒ 仍是值依赖
  assert.equal(bySpecifier.get('@/features/graph/layout').typeOnly, false)
  assert.equal(bySpecifier.get('@/features/graph/force').typeOnly, true)
  assert.equal(bySpecifier.get('@/ipc/types').typeOnly, true)
  assert.equal(bySpecifier.get('./graph.css').sideEffect, true)
  assert.equal(bySpecifier.get('@/ipc/mock-adapter').dynamic, true)
})

test('resolveSpecifier：@/ 与相对路径都解析到 src 相对模块 id', () => {
  assert.equal(resolveSpecifier('@/state/note-store', `${SRC}/app/actions.ts`), 'state/note-store')
  assert.equal(resolveSpecifier('./ui-store', `${SRC}/state/tabs-store.ts`), 'state/ui-store')
  assert.equal(resolveSpecifier('../ipc/types', `${SRC}/state/tabs-store.ts`), 'ipc/types')
  assert.equal(resolveSpecifier('react', `${SRC}/App.tsx`), null)
})

test('physicalLines：与编辑器行号一致（结尾换行不算多一行）', () => {
  assert.equal(physicalLines('a\nb\n'), 2)
  assert.equal(physicalLines('a\nb'), 2)
  assert.equal(physicalLines(''), 1)
})

// ---------------------------------------------------------------------------
// 规则的纯函数部分
// ---------------------------------------------------------------------------

const edge = (from, to, typeOnly = false) => ({ from, to, typeOnly, kind: typeOnly ? 'type' : 'value', line: 1 })

test('dependencyViolations：只报值依赖，type-only 放行', () => {
  const snapshot = {
    edges: [
      edge(`${SRC}/state/graph-store.ts`, `${SRC}/features/graph/layout.ts`),
      edge(`${SRC}/state/graph-store.ts`, `${SRC}/features/graph/force.ts`, true),
      edge(`${SRC}/features/graph/model.ts`, `${SRC}/domain/paths.ts`),
      // features → app 是放行方向（界面触发组合动作），不该报
      edge(`${SRC}/features/vault/FileTree.tsx`, `${SRC}/app/actions.ts`),
      // 组合根自己的两个文件互引不该报
      edge(`${SRC}/main.tsx`, `${SRC}/App.tsx`),
    ],
  }
  const violations = dependencyViolations(snapshot)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].to, `${SRC}/features/graph/layout.ts`)
})

test('dependencyViolations：domain / ipc / theme / components 的越界都报', () => {
  const snapshot = {
    edges: [
      edge(`${SRC}/domain/tree.ts`, `${SRC}/state/notes.ts`),
      edge(`${SRC}/ipc/client.ts`, `${SRC}/state/note-store.ts`),
      edge(`${SRC}/theme/apply.ts`, `${SRC}/features/theme/x.ts`),
      edge(`${SRC}/components/Button.tsx`, `${SRC}/state/ui-store.ts`),
    ],
  }
  assert.equal(dependencyViolations(snapshot).length, 4)
})

test('findCycleEdges：只报环内的边，单向链不报', () => {
  const snapshot = {
    codeFiles: [`${SRC}/a.ts`, `${SRC}/b.ts`, `${SRC}/c.ts`],
    edges: [edge(`${SRC}/a.ts`, `${SRC}/b.ts`), edge(`${SRC}/b.ts`, `${SRC}/a.ts`), edge(`${SRC}/b.ts`, `${SRC}/c.ts`)],
  }
  const cycles = findCycleEdges(snapshot)
  assert.deepEqual(
    cycles.map((item) => `${item.from} -> ${item.to}`).sort(),
    [`${SRC}/a.ts -> ${SRC}/b.ts`, `${SRC}/b.ts -> ${SRC}/a.ts`],
  )
})

test('checkCssLayering：缺层序声明 / 层名不对 / 没包住整个文件都要报', () => {
  const path = `${SRC}/features/graph/graph.css`
  assert.deepEqual(checkCssLayering(path, `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.features {\n.a { color: red }\n}\n`), [])
  assert.match(checkCssLayering(path, '.a { color: red }')[0], /第一行必须是层序声明/)
  assert.match(
    checkCssLayering(path, `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.base {\n.a { color: red }\n}\n`)[0],
    /第二行必须是 `@layer mn\.features \{`/,
  )
  assert.match(
    checkCssLayering(path, `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.features {\n.a { color: red }\n`)[0],
    /最后一行必须是/,
  )
})

test('checkCssLayering：字符串里的花括号不影响配对判断', () => {
  const path = `${SRC}/features/graph/graph.css`
  const source = `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.features {\n.a::after { content: "}" }\n}\n`
  assert.deepEqual(checkCssLayering(path, source), [])
})

test('checkCssLayering：CSS 住在不认识的目录里要报', () => {
  assert.match(checkCssLayering(`${SRC}/domain/oops.css`, `${CSS_LAYER_ORDER_STATEMENT}\n`)[0], /只允许住在/)
})

test('importantCount / importantOnTokens：注释里的 !important 不算数', () => {
  assert.equal(importantCount('/* 用 !important 就正好相反 */\n.a { color: red }'), 0)
  assert.equal(importantCount('.a { color: red !important }'), 1)
  // 变量上加 !important 会压过设置页的字号覆盖，必须单独拦一条
  assert.equal(importantOnTokens(':root { --mn-font-size-ui: 16px !important; }').length, 1)
  assert.equal(importantOnTokens('html { tab-size: 4; }').length, 0)
})

test('cmSelectorCount：只数选择器前奏里的 .cm-*，注释里的不算', () => {
  assert.equal(cmSelectorCount('/* .cm-editor 在这里管不到 */\n.a { color: red }').length, 0)
  assert.equal(cmSelectorCount('.mn-editor__surface .cm-editor { height: 100% }').length, 1)
})

test('stripBlockComments：删内容但保留行数', () => {
  const source = 'a\n/* x\ny */\nb\n'
  const stripped = stripBlockComments(source)
  assert.equal(stripped.split('\n').length, source.split('\n').length)
  assert.doesNotMatch(stripped, /x/)
})

test('domViolations：只查 domain，且局部同名变量不误伤', () => {
  const snapshot = {
    directory: 'fixtures',
    codeFiles: [`${SRC}/domain/frontmatter-edit.ts`],
    edges: [],
  }
  // `document.errors` 是 js-yaml 的局部变量名，不是浏览器全局
  const violations = domViolations({ ...snapshot, directory: makeFixture({ [`${SRC}/domain/frontmatter-edit.ts`]: 'if (document.errors.length) throw document.errors[0]' }) })
  assert.deepEqual(violations, [])
})

// ---------------------------------------------------------------------------
// 端到端：临时目录里造一个"违规仓库"，门禁必须变红
// ---------------------------------------------------------------------------

/** 造一个最小仓库：`files` 是相对仓库根的文本文件，另有空 allowlist。 */
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-arch-'))
  const write = (rel, content) => {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  for (const [rel, content] of Object.entries(files)) write(rel, content)
  write('scripts/architecture-allowlist.json', JSON.stringify({ newFileLineLimit: 600 }, null, 2))
  return dir
}

/** 干净的对照仓库：一个 domain 文件 + 一个合规的样式表。 */
function cleanFixture(extra = {}) {
  return makeFixture({
    [`${SRC}/domain/paths.ts`]: "export const parentOf = (p: string): string => p.split('/')[0] ?? ''\n",
    [`${SRC}/features/graph/graph.ts`]: "import { parentOf } from '@/domain/paths'\nexport const x = parentOf('a/b')\nimport './graph.css'\n",
    [`${SRC}/features/graph/graph.css`]: `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.features {\n.mn-graph { color: red }\n}\n`,
    ...extra,
  })
}

test('端到端：干净的最小仓库通过', (t) => {
  const dir = cleanFixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stats = checkArchitecture(dir)
  assert.equal(stats.codeFiles, 2)
  assert.equal(stats.cssFiles, 1)
})

test('端到端：state → features 的值依赖会让门禁变红', (t) => {
  const dir = cleanFixture({
    [`${SRC}/state/store.ts`]: "import { x } from '@/features/graph/graph'\nexport const y = x\n",
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => checkArchitecture(dir), /state 不得值依赖 features/)
})

test('端到端：未分层的新 CSS 会让门禁变红', (t) => {
  const dir = cleanFixture({
    [`${SRC}/features/graph/extra.css`]: '.mn-graph-extra { color: blue }\n',
    [`${SRC}/features/graph/extra.ts`]: "import './extra.css'\nexport const extra = 1\n",
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => checkArchitecture(dir), /第一行必须是层序声明/)
})

test('端到端：没人 import 的样式表会让门禁变红（死样式）', (t) => {
  const dir = cleanFixture({
    [`${SRC}/features/graph/orphan.css`]: `${CSS_LAYER_ORDER_STATEMENT}\n@layer mn.features {\n.mn-orphan { color: blue }\n}\n`,
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => checkArchitecture(dir), /死样式/)
})

test('端到端：超 600 行且没登记的文件会让门禁变红', (t) => {
  const dir = cleanFixture({
    [`${SRC}/domain/big.ts`]: 'export const a = 1\n'.repeat(601),
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => checkArchitecture(dir), /超过 600 行且没有登记为待拆/)
})

test('端到端：已登记的待拆文件长胖也会变红（只许变小）', (t) => {
  // 700 行的文件（必须登记）登记成 650 行 —— 长胖必须红
  const dir = cleanFixture({ [`${SRC}/domain/big.ts`]: 'export const a = 1\n'.repeat(700) })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'scripts/architecture-allowlist.json'),
    JSON.stringify({
      newFileLineLimit: 600,
      oversizeFiles: [{ file: `${SRC}/domain/big.ts`, lines: 650 }],
    }),
  )
  assert.throws(() => checkArchitecture(dir), /只许变小/)
})

test('端到端：待拆文件缩到阈值以下后，旧登记必须一起删（否则红）', (t) => {
  const dir = cleanFixture({ [`${SRC}/domain/big.ts`]: 'export const a = 1\n'.repeat(700) })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, `${SRC}/domain/big.ts`), 'export const a = 1\n'.repeat(10))
  writeFileSync(
    join(dir, 'scripts/architecture-allowlist.json'),
    JSON.stringify({
      newFileLineLimit: 600,
      oversizeFiles: [{ file: `${SRC}/domain/big.ts`, lines: 700 }],
    }),
  )
  assert.throws(() => checkArchitecture(dir), /白名单已过期/)
})

test('端到端：白名单条目过期（债已还清却还留着登记）也会变红', (t) => {
  const dir = cleanFixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'scripts/architecture-allowlist.json'),
    JSON.stringify({
      newFileLineLimit: 600,
      dependencyViolations: [{ file: `${SRC}/state/store.ts`, to: `${SRC}/features/graph/graph.ts` }],
    }),
  )
  assert.throws(() => checkArchitecture(dir), /白名单已过期/)
})

test('端到端：登记文件缺失直接变红（不许静默放行）', (t) => {
  const dir = cleanFixture()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(join(dir, 'scripts/architecture-allowlist.json'))
  assert.throws(() => checkArchitecture(dir), /登记文件缺失/)
})

test('端到端：module 级循环会让门禁变红', (t) => {
  const dir = cleanFixture({
    [`${SRC}/state/a.ts`]: "import { b } from './b'\nexport const a = b\n",
    [`${SRC}/state/b.ts`]: "import { a } from './a'\nexport const b = a\n",
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 这两个模块都在 state 里，依赖方向不违规 —— 红只可能来自循环规则
  assert.throws(() => checkArchitecture(dir), /循环依赖/)
})

// ---------------------------------------------------------------------------
// 对真实仓库的集成校验：当前必须全绿
// ---------------------------------------------------------------------------

test('真实仓库架构门禁全绿，且债务清单确实存在', () => {
  const stats = checkArchitecture(ROOT)
  assert.ok(stats.codeFiles > 150)
  assert.ok(stats.cssFiles >= 29)
  // 冻结的债务：这些数字下降是好事，但**不许上升**
  assert.ok(stats.allowedDeps <= 10)
  assert.ok(stats.allowedCycles <= 2)
  assert.ok(stats.pendingLayers <= 29)
  assert.ok(stats.pendingSplit <= 24)
  assert.ok(stats.sharedBlocks <= 19)
  assert.ok(stats.importantTotal <= 9)
})

test('真实仓库的 allowlist 能被解析，且 key 一致', () => {
  const allowlist = readAllowlist(ROOT)
  assert.equal(allowlist.missing, false)
  for (const item of allowlist.dependencyViolations) {
    assert.match(item.file, /^apps\/desktop\/src\//)
    assert.match(item.to, /^apps\/desktop\/src\//)
  }
})

test('printBaseline：只打印不写盘，输出是合法 JSON 且与 allowlist 键一致', () => {
  const baseline = JSON.parse(printBaseline(ROOT))
  assert.deepEqual(Object.keys(baseline).sort(), [
    '$comment',
    'cssCmSelectors',
    'cssImportantBudget',
    'cssPendingLayers',
    'cssSharedBlocks',
    'cycles',
    'dependencyViolations',
    'domViolations',
    'newFileLineLimit',
    'oversizeFiles',
  ])
  // 打印出来的基线必须与仓库里登记的**逐条一致**，否则"当前状态"与"冻结状态"已经漂了
  const allowlist = readAllowlist(ROOT)
  assert.deepEqual(
    baseline.oversizeFiles.map((item) => item.file).sort(),
    allowlist.oversizeFiles.map((item) => item.file).sort(),
  )
  assert.deepEqual(baseline.cssPendingLayers.sort(), allowlist.cssPendingLayers.sort())
  assert.deepEqual(
    baseline.dependencyViolations.map((item) => `${item.file} -> ${item.to}`).sort(),
    allowlist.dependencyViolations.map((item) => `${item.file} -> ${item.to}`).sort(),
  )
})

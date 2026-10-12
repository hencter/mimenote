/**
 * 层序门禁的单测：解析器与判据都喂内联字符串（不碰仓库文件），并单独确认真实仓库当前是绿的。
 *
 * 这里刻意把 B1 实测的四种压缩器行为都钉成用例 —— 门禁的判据本身也要"自证会红/会绿"。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CSS_LAYER_ORDER, expectedCssLayer } from './check-architecture.mjs'
import {
  artifactCssFiles,
  checkArtifactLayerOrder,
  checkCssLayers,
  checkEntryImportOrder,
  layerOrderSnapshot,
  resolveLayerOrder,
} from './check-css-layers.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const LAYERS = CSS_LAYER_ORDER.join(', ')
const [TOKENS, BASE, COMPONENTS, FEATURES] = CSS_LAYER_ORDER

// ---------------------------------------------------------------------------
// 解析器：层序 = 声明定位 + 块首次出现
// ---------------------------------------------------------------------------

test('resolveLayerOrder：声明在块之前 → 按声明定序（压缩器也是这样重排的）', () => {
  const css = `@layer ${LAYERS};@layer ${FEATURES}{a{color:red}}@layer ${TOKENS}{b{color:blue}}`
  assert.deepEqual(resolveLayerOrder(css), [...CSS_LAYER_ORDER])
})

test('resolveLayerOrder：没有声明 → 退化为首次出现顺序', () => {
  const css = `@layer ${FEATURES}{a{color:red}}@layer ${TOKENS}{b{color:blue}}`
  assert.deepEqual(resolveLayerOrder(css), [FEATURES, TOKENS].filter((name) => name !== undefined))
})

test('resolveLayerOrder：声明在块之后 → 后置声明是空操作（与规范一致）', () => {
  const css = `@layer ${TOKENS}{b{color:blue}}@layer ${BASE}{c{color:green}}@layer ${TOKENS}, ${BASE};`
  assert.deepEqual(resolveLayerOrder(css), [TOKENS, BASE])
})

test('resolveLayerOrder：声明里多一个没有块的层（哨兵）也按位置参与定序', () => {
  const css = `@layer ${TOKENS}, zzz;@layer zzz2{a{color:red}}`
  assert.deepEqual(resolveLayerOrder(css), [TOKENS, 'zzz', 'zzz2'])
})

test('layerOrderSnapshot：只保留四层（哨兵层不进快照）', () => {
  const css = `@layer ${TOKENS}, zzz;@layer ${BASE}{a{color:red}}`
  assert.deepEqual(layerOrderSnapshot(css), [TOKENS, BASE])
})

// ---------------------------------------------------------------------------
// 产物判据
// ---------------------------------------------------------------------------

test('产物判据：四层齐全且顺序正确 → 通过', () => {
  const css = CSS_LAYER_ORDER.map((name) => `@layer ${name}{.${name}{color:red}}`).join('')
  assert.deepEqual(checkArtifactLayerOrder(css, 'x.css'), [])
})

test('产物判据：顺序被打乱 → 红（这正是"声明被删、层序靠打包顺序"的后果）', () => {
  const css = [FEATURES, COMPONENTS, BASE, TOKENS].map((name) => `@layer ${name}{a{color:red}}`).join('')
  const problems = checkArtifactLayerOrder(css, 'x.css')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /层序是 mn\.features -> mn\.components/)
})

test('产物判据：缺一层 → 红（整层被删或样式表没被 import）', () => {
  const css = [TOKENS, BASE, COMPONENTS].map((name) => `@layer ${name}{a{color:red}}`).join('')
  const problems = checkArtifactLayerOrder(css, 'x.css')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /没有这些层的层块：mn\.features/)
})

// ---------------------------------------------------------------------------
// 源侧判据（入口 import 顺序）
// ---------------------------------------------------------------------------

const OK_ENTRY = [
  "import { bootstrap } from '@/app/bootstrap'",
  "import './styles/tokens.css'",
  "import './styles/base.css'",
  "import './components/splitter.css'",
  "import './features/layout/shell.css'",
  "import { App } from '@/App'",
].join('\n')

test('源侧判据：分组正确且在 @/App 之前 → 通过', () => {
  const { problems, layers } = checkEntryImportOrder(OK_ENTRY, 'apps/desktop/src/main.tsx')
  assert.deepEqual(problems, [])
  assert.deepEqual(layers, [TOKENS, BASE, COMPONENTS, FEATURES])
})

test('源侧判据：层序不单调 → 红', () => {
  const source = OK_ENTRY.replace("import './styles/base.css'", "import './features/vault/tree.css'")
  const { problems } = checkEntryImportOrder(source, 'apps/desktop/src/main.tsx')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /层序必须单调不减/)
})

test('源侧判据：样式 import 排在 @/App 之后 → 红（层序会退化为打包顺序）', () => {
  const source = [
    "import { App } from '@/App'",
    "import './styles/tokens.css'",
    "import './styles/base.css'",
  ].join('\n')
  const { problems } = checkEntryImportOrder(source, 'apps/desktop/src/main.tsx')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /排在 `@\/App`/)
})

test('源侧判据：CSS 不在三处之一 → 红', () => {
  const source = ["import './misc/other.css'", "import { App } from '@/App'"].join('\n')
  const { problems } = checkEntryImportOrder(source, 'apps/desktop/src/main.tsx')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /不在 styles\/、components\/、features\/ 三处/)
})

// ---------------------------------------------------------------------------
// 端到端：临时仓库里"有产物就查产物、没产物就跳过"
// ---------------------------------------------------------------------------

function makeTempRepo({ withArtifact, artifactCss }) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-layers-'))
  mkdirSync(join(dir, 'apps/desktop/src'), { recursive: true })
  writeFileSync(join(dir, 'apps/desktop/src/main.tsx'), OK_ENTRY)
  if (withArtifact) {
    mkdirSync(join(dir, 'apps/desktop/dist/assets'), { recursive: true })
    writeFileSync(join(dir, 'apps/desktop/dist/assets/index-x.css'), artifactCss)
  }
  return dir
}

test('端到端：没有产物 → 只跑源侧，且给出"跳过产物校验"的提示', () => {
  const dir = makeTempRepo({ withArtifact: false })
  try {
    const { problems, notes } = checkCssLayers(dir)
    assert.deepEqual(problems, [])
    assert.ok(notes.some((note) => note.includes('跳过')))
    assert.deepEqual(artifactCssFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：--require-artifact 时没有产物 → 红（CI 用）', () => {
  const dir = makeTempRepo({ withArtifact: false })
  try {
    const { problems } = checkCssLayers(dir, { requireArtifact: true })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /没有构建产物/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：产物顺序正确 → 通过；顺序错 → 红', () => {
  const good = CSS_LAYER_ORDER.map((name) => `@layer ${name}{a{color:red}}`).join('')
  const bad = [FEATURES, TOKENS, BASE, COMPONENTS].map((name) => `@layer ${name}{a{color:red}}`).join('')
  const dirGood = makeTempRepo({ withArtifact: true, artifactCss: good })
  const dirBad = makeTempRepo({ withArtifact: true, artifactCss: bad })
  try {
    assert.deepEqual(checkCssLayers(dirGood).problems, [])
    const problems = checkCssLayers(dirBad).problems
    assert.equal(problems.length, 1)
    assert.match(problems[0], /期望 mn\.tokens -> mn\.base -> mn\.components -> mn\.features/)
  } finally {
    rmSync(dirGood, { recursive: true, force: true })
    rmSync(dirBad, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 真实仓库（B1 之后：源侧 + 产物侧都应是绿的）
// ---------------------------------------------------------------------------

test('真实仓库：入口层序与（若已构建的）产物层序都等于声明序', () => {
  const { problems, notes } = checkCssLayers(ROOT)
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.ok(notes.some((note) => note.includes('入口')))
  // 层名映射仍然只有一份：确认新脚本没有另写一份映射
  assert.equal(expectedCssLayer('apps/desktop/src/styles/tokens.css'), TOKENS)
})

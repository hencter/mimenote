#!/usr/bin/env node
/**
 * 层序门禁：证明「层序不靠巧合」—— 源侧查构造顺序，产物侧查真实顺序。
 *
 * ## 为什么需要它（B1 的实测结论）
 *
 * Vite 8 的 CSS 压缩器是 **lightningcss**，它对 `@layer a, b;` 独立声明的处理是
 * **「按语义用掉，然后删掉」**：先按声明把层块重排到声明序，再把这条已经冗余的声明删掉。
 * 最小复现（同一份 Vite 8.3.0，四种输入 → 产物）：
 *
 * | 输入（模块顺序） | 产物 |
 * | --- | --- |
 * | `@layer a, b;` 在前，块 `b` → `a` | `@layer a{…}@layer b{…}`（**按声明重排**，声明消失） |
 * | `@layer a, b;` 在前，块 `b` → `a`，声明里多一个没有块的 `zzz` | 同上 + `@layer zzz;`（无法推断的部分被保留） |
 * | 没有声明，块 `b` → `a` | `@layer b{…}@layer a{…}`（**层序 = 首次出现顺序**，错） |
 * | 声明在块**之后** | 同上一行（后置声明是空操作，被删） |
 *
 * 也就是说：压缩产物里"谁先出现谁更低层"这条规则一旦失去声明兜底，就只能靠**打包顺序**。
 * 打包顺序 = 模块求值顺序 ⇒ 入口 `main.tsx` 的样式 import 必须排在 `@/App` 之前且按层序分组。
 * 这就是本脚本要钉的两条判据：
 *
 * 1. **源侧（总是跑）**：`apps/desktop/src/main.tsx` 里的 CSS import 必须
 *    （a）层序单调不减，（b）全部出现在 `@/App` 的 import 之前。
 * 2. **产物侧（有 dist 就跑）**：按真实 CSS 语义算出各层的**首次出现顺序**，必须等于层序；
 *    四层都得出现。没有产物时打印明确提示后跳过 —— 它要在 build 之后跑才有意义。
 *
 * ## 纪律
 *
 * 层序与层名映射**只有一份**：`CSS_LAYER_ORDER` 与 `expectedCssLayer` 都从
 * `check-architecture.mjs` 复用，本脚本不另写一套（ADR-0060「每条规则只有一个判据」）。
 *
 * 用法：
 *   node scripts/check-css-layers.mjs              # 校验（接进 pnpm check）
 *   node scripts/check-css-layers.mjs --print      # 只打印产物里的层序快照
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CSS_LAYER_ORDER, expectedCssLayer } from './check-architecture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const SRC = 'apps/desktop/src'
/** 组合根：入口的 import 顺序决定 CSS 拼接顺序（打包器按模块求值顺序拼）。 */
const ENTRY = `${SRC}/main.tsx`
/** 主界面组合根：入口的样式 import 必须排在它之前，四层锚才先于任何组件子树里的 CSS。 */
const APP_SPECIFIER = '@/App'
const DIST_DIR = 'apps/desktop/dist/assets'

/**
 * 按真实 CSS 语义算出各层的出现顺序。
 *
 * 规则（与浏览器一致）：独立声明 `@layer a, b;` 在**它所在的位置**给 a、b 定位；层块
 * `@layer a{…}` 如果 a 还没定位，就在**它所在的位置**给 a 定位。返回按位置排列、去重后的名字。
 */
export function resolveLayerOrder(css) {
  const matches = []
  for (const match of css.matchAll(/@layer\s+([^{};]+)\s*([;{])/g)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
    matches.push({ index: match.index, names, statement: match[2] === ';' })
  }
  matches.sort((a, b) => a.index - b.index)
  const order = []
  for (const match of matches) {
    for (const name of match.names) if (!order.includes(name)) order.push(name)
  }
  return order
}

/** 产物里的层序快照（去掉与层序无关的额外层，例如"哨兵"）。 */
export function layerOrderSnapshot(css) {
  return resolveLayerOrder(css).filter((name) => CSS_LAYER_ORDER.includes(name))
}

/**
 * 产物判据：四层都要出现，且首次出现顺序必须等于层序。返回问题清单（空数组 = 通过）。
 */
export function checkArtifactLayerOrder(css, label = '产物') {
  const snapshot = layerOrderSnapshot(css)
  const problems = []
  const missing = CSS_LAYER_ORDER.filter((name) => !snapshot.includes(name))
  if (missing.length > 0) {
    problems.push(
      `${label}：产物里没有这些层的层块：${missing.join('、')} —— 要么对应样式表没被 import，要么整层被删`,
    )
    return problems
  }
  if (snapshot.join(' -> ') !== CSS_LAYER_ORDER.join(' -> ')) {
    problems.push(
      `${label}：层序是 ${snapshot.join(' -> ')}，期望 ${CSS_LAYER_ORDER.join(' -> ')}` +
        '（压缩器删掉 @layer 声明后，层序退化为"首次出现顺序"——必须由入口的 import 顺序兜住）',
    )
  }
  return problems
}

/**
 * 源侧判据：入口里的 CSS import 必须层序单调不减，且都排在 `@/App` 之前。
 * 返回 `{ problems, layers }`。
 */
export function checkEntryImportOrder(source, entryRel = ENTRY) {
  const lines = source.split('\n')
  const imports = []
  lines.forEach((line, index) => {
    const css = /^\s*import\s+['"]([^'"]+\.css)['"]/.exec(line)
    if (css !== null) {
      // 与 main.tsx 同目录的相对路径 → 仓库相对路径，再交给 check-architecture 的唯一映射
      const repoPath = posix.normalize(posix.join(posix.dirname(entryRel), css[1]))
      imports.push({ line: index + 1, specifier: css[1], layer: expectedCssLayer(repoPath) })
      return
    }
    const app = /^\s*import\b[^\n]*from\s+['"]@\/App['"]/.exec(line)
    if (app !== null) imports.push({ line: index + 1, specifier: APP_SPECIFIER, layer: null, isApp: true })
  })

  const cssImports = imports.filter((item) => item.specifier.endsWith('.css'))
  const app = imports.find((item) => item.isApp === true)
  const problems = []

  if (cssImports.length === 0) problems.push(`${entryRel}：找不到任何 CSS import（层序失去了构造保证）`)

  let previous = -1
  for (const item of cssImports) {
    if (item.layer === null) {
      problems.push(`${entryRel}:${item.line}：${item.specifier} 不在 styles/、components/、features/ 三处`)
      continue
    }
    const position = CSS_LAYER_ORDER.indexOf(item.layer)
    if (position < previous) {
      problems.push(
        `${entryRel}:${item.line}：${item.specifier} 属于 ${item.layer}，` +
          `排在比它更高的层之后（层序必须单调不减：${CSS_LAYER_ORDER.join(' -> ')}）`,
      )
    } else previous = position
  }

  if (app === undefined) {
    problems.push(`${entryRel}：找不到 \`${APP_SPECIFIER}\` 的 import —— 无法判定样式锚是否先于组件子树`)
  } else {
    const late = cssImports.filter((item) => item.line > app.line)
    if (late.length > 0) {
      problems.push(
        `${entryRel}：这些 CSS import 排在 \`${APP_SPECIFIER}\`(第 ${app.line} 行)之后：` +
          `${late.map((item) => `L${item.line} ${item.specifier}`).join('、')} —— ` +
          '打包器按模块求值顺序拼 CSS，那样第一种层块可能来自组件子树，层序就退化为打包顺序',
      )
    }
  }
  return { problems, layers: cssImports.map((item) => item.layer) }
}

/** 读 `dist/assets/*.css`（没有产物时返回空数组）。 */
export function artifactCssFiles(directory = root) {
  const dir = join(directory, DIST_DIR)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => ({ path: `${DIST_DIR}/${name}`, text: readFileSync(join(dir, name), 'utf8') }))
}

/** 跑全部判据；返回 `{ problems, notes }`。 */
export function checkCssLayers(directory = root, { requireArtifact = false } = {}) {
  const problems = []
  const notes = []

  const entrySource = readFileSync(join(directory, ENTRY), 'utf8')
  const entry = checkEntryImportOrder(entrySource, ENTRY)
  problems.push(...entry.problems)
  notes.push(`入口 ${ENTRY} 的 CSS import 层序：${entry.layers.join(' -> ')}`)

  const artifacts = artifactCssFiles(directory)
  if (artifacts.length === 0) {
    const message = `没有构建产物（${DIST_DIR}/*.css）—— 产物侧判据未跑；跑一次 pnpm build 后再执行本脚本`
    if (requireArtifact) problems.push(message)
    else notes.push(`⚠️ 跳过：${message}`)
  } else {
    for (const artifact of artifacts) {
      problems.push(...checkArtifactLayerOrder(artifact.text, artifact.path))
      notes.push(`${artifact.path} 的层序：${layerOrderSnapshot(artifact.text).join(' -> ')}`)
    }
  }
  return { problems, notes }
}

/** 这个模块是"被直接运行"还是"被测试 import"。 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  const printOnly = process.argv.includes('--print')
  const { problems, notes } = checkCssLayers(root, { requireArtifact: process.argv.includes('--require-artifact') })
  for (const note of notes) console.log(note)
  if (printOnly) process.exitCode = 0
  else if (problems.length > 0) {
    console.error(`层序校验失败：\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    process.exitCode = 1
  } else console.log('层序校验通过：源侧构造顺序与产物层序都等于声明序')
}

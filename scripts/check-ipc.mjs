#!/usr/bin/env node
/**
 * Rust ↔ TypeScript IPC 契约一致性检查（无第三方依赖，Node 22 直接跑）。
 *
 * 四层校验，对应"人工镜像"最容易漂移的四处：
 *
 * 1. **命令名三方一致**：Rust `tauri::generate_handler![]`（lib.rs）↔ 前端 client.ts
 *    的 `call<…>('…')` ↔ mock-adapter.ts 的 `case '…'`。任何一侧改名/漏改都会在这里报出
 *    "哪一侧多、哪一侧少"。
 * 2. **ErrorCode 集合一致**：`mn_core::ErrorCode::as_str()` 的字符串 + 宿主 error.rs 新增码
 *    （`UNSUPPORTED_MEDIA` / `INDEX_NOT_READY` / `INTERNAL`）↔ TS 的 `ErrorCode` 联合与
 *    `KNOWN_CODES` 白名单。TS 侧允许两个不出现在 Rust 的码：`CANCELLED`（用户取消对话框）
 *    与 `UNKNOWN`（兜底，且不允许进 KNOWN_CODES）。
 * 3. **DTO 字段逐字段一致**：`DTO_MANIFEST` 列出的每个 TS interface ↔ Rust struct，
 *    按 `#[serde(rename_all = "camelCase")]` 换算后比较字段名集合
 *    （`interface extends` 会先展开基类字段）。
 * 4. **字符串枚举一致**：`ENUM_MANIFEST` 列出的 TS 字面量联合 ↔ Rust 单元枚举，
 *    按各自的 `rename_all`（lowercase / kebab-case）换算后比较。
 *
 * 新增命令 / DTO 时：改 Rust、改 TS、顺手把新 DTO 加进 MANIFEST —— 这个脚本会盯着你做完。
 */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** 这个模块是"被直接运行"还是"被测试 import"（`realpathSync` 的理由见 check-version.mjs）。 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

const HOST = 'apps/desktop/src-tauri/src'
const CORE = 'crates/mn-core/src'
const INDEX = 'crates/mn-index/src'
const TS_TYPES = 'apps/desktop/src/ipc/types.ts'
const TS_CLIENT = 'apps/desktop/src/ipc/client.ts'
const TS_MOCK = 'apps/desktop/src/ipc/mock-adapter.ts'

/** [TS interface, Rust 文件, Rust struct]。字段名按 camelCase 换算后必须完全一致。 */
export const DTO_MANIFEST = [
  ['EntryMeta', `${CORE}/scanner.rs`, 'EntryMeta'],
  ['VaultInfo', `${HOST}/commands/vault.rs`, 'VaultInfo'],
  ['VaultSnapshot', `${HOST}/commands/vault.rs`, 'VaultSnapshot'],
  ['NoteContent', `${HOST}/commands/notes.rs`, 'NoteContent'],
  ['WriteOutcome', `${HOST}/commands/notes.rs`, 'WriteOutcome'],
  ['SetTagsOutcome', `${HOST}/commands/tags.rs`, 'SetTagsOutcome'],
  ['TrashRecord', `${CORE}/trash.rs`, 'TrashRecord'],
  ['TrashEntry', `${HOST}/commands/trash.rs`, 'TrashEntry'],
  ['RestoreSummary', `${HOST}/commands/trash.rs`, 'RestoreSummary'],
  ['TagFilterResult', `${HOST}/commands/tags.rs`, 'TagFilterResult'],
  ['SnippetFile', `${HOST}/commands/system.rs`, 'SnippetFile'],
  ['VersionInfo', `${HOST}/commands/system.rs`, 'VersionInfo'],
  ['TextStats', `${CORE}/text_stats.rs`, 'TextStats'],
  ['DocumentStats', `${HOST}/commands/notes.rs`, 'DocumentStats'],
  ['ResolvedLink', `${INDEX}/lib.rs`, 'ResolvedLink'],
  ['BacklinkRef', `${INDEX}/lib.rs`, 'BacklinkRef'],
  ['NoteLinks', `${INDEX}/lib.rs`, 'NoteLinks'],
  ['TagRef', `${CORE}/tags.rs`, 'TagRef'],
  ['FrontmatterField', `${CORE}/frontmatter.rs`, 'FrontmatterField'],
  ['NoteTags', `${HOST}/commands/tags.rs`, 'NoteTags'],
  ['TagSummary', `${HOST}/commands/tags.rs`, 'TagSummaryDto'],
  ['TagNotes', `${HOST}/commands/tags.rs`, 'TagNotes'],
  ['TagRenameFile', `${HOST}/commands/tags.rs`, 'TagRenameFile'],
  ['TagRenameSkip', `${HOST}/commands/tags.rs`, 'TagRenameSkip'],
  ['TagRenameOutcome', `${HOST}/commands/tags.rs`, 'TagRenameOutcome'],
  ['AssetGrant', `${HOST}/assets.rs`, 'AssetGrant'],
  ['AssetBytes', `${HOST}/assets.rs`, 'AssetBytes'],
  ['AttachmentInput', `${HOST}/attachments.rs`, 'AttachmentInput'],
  ['AttachmentSaved', `${HOST}/attachments.rs`, 'AttachmentSaved'],
  ['ExportWriteOutcome', `${HOST}/export.rs`, 'ExportWriteOutcome'],
  ['SitePage', `${INDEX}/site.rs`, 'SitePage'],
  ['SiteLink', `${INDEX}/site.rs`, 'SiteLink'],
  ['SiteRename', `${CORE}/site.rs`, 'PageRename'],
  ['SiteStats', `${INDEX}/site.rs`, 'SiteStats'],
  ['SitePreviousExport', `${INDEX}/site.rs`, 'SitePreviousExport'],
  ['SitePlan', `${INDEX}/site.rs`, 'SitePlan'],
  ['SiteSkip', `${HOST}/site_export.rs`, 'SiteSkip'],
  ['NotesBatch', `${HOST}/commands/notes.rs`, 'NotesBatch'],
  ['SiteFile', `${HOST}/site_export.rs`, 'SiteFile'],
  ['SiteWriteOutcome', `${HOST}/site_export.rs`, 'SiteWriteOutcome'],
  ['SiteAssetInput', `${HOST}/site_export.rs`, 'SiteAssetInput'],
  ['SiteAssetOutcome', `${HOST}/site_export.rs`, 'SiteAssetOutcome'],
  ['SearchHit', `${HOST}/commands/search.rs`, 'SearchHit'],
  ['SearchResult', `${HOST}/commands/search.rs`, 'SearchResult'],
  ['GraphNode', `${INDEX}/graph.rs`, 'GraphNode'],
  ['GraphEdge', `${INDEX}/graph.rs`, 'GraphEdge'],
  ['GraphData', `${INDEX}/graph.rs`, 'GraphData'],
  ['RenameLinkUpdate', `${HOST}/commands/notes.rs`, 'RenameLinkUpdate'],
  ['RenameOutcome', `${HOST}/commands/notes.rs`, 'RenameOutcome'],
  ['IndexStatus', `${HOST}/indexer.rs`, 'IndexStatus'],
  ['IpcErrorPayload', `${HOST}/error.rs`, 'IpcError'],
]

/**
 * [TS 字面量联合, Rust 文件, Rust 单元枚举]。
 * 注意 `FrontmatterValue` 不在此列：它是带数据的标记联合，不是字符串枚举。
 */
export const ENUM_MANIFEST = [
  ['LinkKind', `${CORE}/links.rs`, 'LinkKind'],
  ['TagSource', `${CORE}/tags.rs`, 'TagSource'],
  ['IndexPhase', `${HOST}/indexer.rs`, 'IndexPhase'],
  ['TagSkipReason', `${HOST}/commands/tags.rs`, 'TagSkipReason'],
]

/** TS 侧允许存在、但 Rust 永远不发的码（前端自己造的错误）。 */
const FRONTEND_ONLY_CODES = ['CANCELLED']
/** 兜底码：必须存在于 ErrorCode 联合，但**不允许**进 KNOWN_CODES 白名单。 */
const FALLBACK_CODE = 'UNKNOWN'

// ---------------------------------------------------------------------------
// 解析工具（纯函数，单测直接喂字符串）
// ---------------------------------------------------------------------------

/** 去掉块注释与"整行是 // 注释"的行（契约文件里没有含注释标记的字符串字面量）。 */
export function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/** 从 `openIndex`（必须是 `{`）开始配对到对应的 `}`，返回两者之间的内容。 */
export function extractBraced(text, openIndex) {
  if (text[openIndex] !== '{') throw new Error(`期望 {，实际位置 ${openIndex}`)
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  throw new Error('花括号不配对')
}

export function snakeToCamel(name) {
  return name.replaceAll(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

/** PascalCase → kebab-case（`ExternalChange` → `external-change`）。 */
export function pascalToKebab(name) {
  return name.replaceAll(/(?<!^)(?=[A-Z])/g, '-').toLowerCase()
}

/** 解析 TS interface（含 `extends` 展开），返回 `Map<名称, 字段名数组>`。 */
export function parseTsInterfaces(source) {
  const text = stripComments(source)
  const interfaces = new Map()
  const pattern = /export\s+interface\s+(\w+)(?:\s+extends\s+([\w\s,]+?))?\s*\{/g
  for (const match of text.matchAll(pattern)) {
    const [, name, bases] = match
    const body = extractBraced(text, match.index + match[0].length - 1)
    // 只取 interface 直接一层的字段（排除理论上可能存在的内联嵌套对象类型）
    const fields = []
    let depth = 0
    for (const line of body.split('\n')) {
      if (depth === 0) {
        const field = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/)
        if (field !== null) fields.push(field[1])
      }
      for (const ch of line) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
    }
    interfaces.set(name, { fields, bases: bases === undefined ? [] : bases.split(/\s*,\s*/) })
  }
  // 展开 extends（基类字段在前）
  const resolved = new Map()
  const resolveFields = (name, seen) => {
    if (resolved.has(name)) return resolved.get(name)
    if (seen.has(name)) throw new Error(`interface 循环继承：${name}`)
    const entry = interfaces.get(name)
    if (entry === undefined) throw new Error(`TS 里找不到 interface ${name}`)
    seen.add(name)
    const inherited = entry.bases.flatMap((base) => resolveFields(base, seen))
    const fields = [...inherited, ...entry.fields]
    resolved.set(name, fields)
    return fields
  }
  for (const name of interfaces.keys()) resolveFields(name, new Set())
  return resolved
}

/** 解析 TS 字面量联合类型（`export type X = 'a' | 'b'`，成员间允许有已被剥掉的注释空行）。 */
export function parseTsUnion(source, name) {
  const text = stripComments(source)
  const start = text.search(new RegExp(`export\\s+type\\s+${name}\\s*=`))
  if (start < 0) throw new Error(`TS 里找不到 type ${name}`)
  const literals = []
  const lines = text.slice(start).split('\n')
  // 第一行是 `export type X = ...`；联合成员是以 `|` 开头的行。遇到第一个
  // 非空且不以 `|` 开头的后续行，联合即结束。
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line.trim() !== '' && !/^\s*\|/.test(line)) break
    literals.push(...[...line.matchAll(/'([^'\n]+)'/g)].map((match) => match[1]))
  }
  return literals
}

/** 解析 `const KNOWN_CODES: … = new Set<ErrorCode>([ ... ])` 里的字符串字面量。 */
export function parseKnownCodes(source) {
  const text = stripComments(source)
  const match = text.match(/KNOWN_CODES[^=]*=\s*new\s+Set[^(]*\(\[([\s\S]*?)\]\)/)
  if (match === null) throw new Error('TS 里找不到 KNOWN_CODES')
  return [...match[1].matchAll(/'([^'\n]+)'/g)].map((item) => item[1])
}

/** 解析 Rust struct 的 `pub` 字段名（按 camelCase 换算后返回）。 */
export function parseRustStructFields(source, structName) {
  const text = stripComments(source)
  const pattern = new RegExp(`pub\\s+struct\\s+${structName}\\s*\\{`)
  const match = pattern.exec(text)
  if (match === null) throw new Error(`Rust 里找不到 struct ${structName}`)
  const body = extractBraced(text, match.index + match[0].length - 1)
  const fields = []
  for (const line of body.split('\n')) {
    const field = line.match(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/)
    if (field !== null) fields.push(snakeToCamel(field[1]))
  }
  return fields
}

/** 找 `pub enum <name>` 前面最近的 `#[serde(rename_all = "…")]`（缺省返回 null）。 */
function enumRenameRule(text, enumIndex) {
  const before = text.slice(Math.max(0, enumIndex - 400), enumIndex)
  const rules = [...before.matchAll(/rename_all\s*=\s*"([a-zA-Z-]+)"/g)]
  return rules.length === 0 ? null : rules.at(-1)[1]
}

/** 解析 Rust 单元枚举的变体，按它的 `rename_all` 规则换算成 IPC 字符串。 */
export function parseRustEnumLiterals(source, enumName) {
  const text = stripComments(source)
  const pattern = new RegExp(`pub\\s+enum\\s+${enumName}\\s*\\{`)
  const match = pattern.exec(text)
  if (match === null) throw new Error(`Rust 里找不到 enum ${enumName}`)
  const rule = enumRenameRule(text, match.index)
  const body = extractBraced(text, match.index + match[0].length - 1)
  const variants = []
  for (const line of body.split('\n')) {
    const variant = line.match(/^\s*([A-Z][A-Za-z0-9]*)\s*,?\s*$/)
    if (variant !== null) variants.push(variant[1])
  }
  return variants.map((variant) => {
    if (rule === 'lowercase') return variant.toLowerCase()
    if (rule === 'kebab-case') return pascalToKebab(variant)
    if (rule === 'camelCase') return variant.charAt(0).toLowerCase() + variant.slice(1)
    throw new Error(`enum ${enumName} 缺少可识别的 serde rename_all（实际：${String(rule)}）`)
  })
}

/** 解析 `mn_core::ErrorCode::as_str()` 返回的全部稳定码字符串。 */
export function parseCoreErrorCodes(source) {
  const text = stripComments(source)
  return [...text.matchAll(/Self::\w+\s*=>\s*"([A-Z0-9_]+)"/g)].map((match) => match[1])
}

/** 解析宿主 error.rs 新增码：`pub const X: &str = "…"` 与 `code: "…"` 字面量。 */
export function parseHostErrorCodes(source) {
  const text = stripComments(source)
  const codes = new Set()
  for (const match of text.matchAll(/pub\s+const\s+\w+\s*:\s*&str\s*=\s*"([A-Z0-9_]+)"/g)) codes.add(match[1])
  for (const match of text.matchAll(/code:\s*"([A-Z0-9_]+)"/g)) codes.add(match[1])
  return [...codes]
}

/** 解析 lib.rs `tauri::generate_handler![…]` 里的命令名（`module::…::command` 取最后一段）。 */
export function parseRustCommands(source) {
  const text = stripComments(source)
  const start = text.indexOf('generate_handler!')
  if (start < 0) throw new Error('lib.rs 里找不到 generate_handler!')
  const end = text.indexOf('])', start)
  if (end < 0) throw new Error('generate_handler! 列表没有闭合')
  return [...text.slice(start, end).matchAll(/\w+(?:::\w+)*::(\w+)/g)].map((match) => match[1])
}

/** 解析 client.ts 里 `call<…>('command', …)` 的命令名。 */
export function parseClientCommands(source) {
  return [...stripComments(source).matchAll(/call<[^\n]*?>\('([a-z_0-9]+)'/g)].map((match) => match[1])
}

/** 解析 mock-adapter.ts 里 `case 'command'` 的命令名。 */
export function parseMockCommands(source) {
  return [...stripComments(source).matchAll(/case\s+'([a-z_0-9]+)'/g)].map((match) => match[1])
}

// ---------------------------------------------------------------------------
// 比较与报告
// ---------------------------------------------------------------------------

function diffSets(name, leftName, left, rightName, right, errors) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const onlyLeft = left.filter((item) => !rightSet.has(item))
  const onlyRight = right.filter((item) => !leftSet.has(item))
  for (const item of onlyLeft) errors.push(`${name}：仅${leftName}有 ${JSON.stringify(item)}`)
  for (const item of onlyRight) errors.push(`${name}：仅${rightName}有 ${JSON.stringify(item)}`)
}

function readRepo(directory, rel) {
  return readFileSync(resolve(directory, rel), 'utf8')
}

/**
 * 执行全部四层校验；失败时抛出汇总了**所有**差异的错误（不只是第一处）。
 * 返回统计摘要（供 CLI 打印）。
 */
export function checkIpc(directory = root) {
  const errors = []

  // 1. 命令名三方一致
  const rustCommands = parseRustCommands(readRepo(directory, `${HOST}/lib.rs`))
  const clientCommands = parseClientCommands(readRepo(directory, TS_CLIENT))
  const mockCommands = parseMockCommands(readRepo(directory, TS_MOCK))
  diffSets('命令', 'Rust handler', rustCommands, 'TS client', clientCommands, errors)
  diffSets('命令', 'Rust handler', rustCommands, 'TS mock', mockCommands, errors)

  // 2. ErrorCode 集合
  const typesSource = readRepo(directory, TS_TYPES)
  const coreCodes = parseCoreErrorCodes(readRepo(directory, `${CORE}/error.rs`))
  const hostCodes = parseHostErrorCodes(readRepo(directory, `${HOST}/error.rs`))
  const rustCodes = [...new Set([...coreCodes, ...hostCodes])]
  const tsUnion = parseTsUnion(typesSource, 'ErrorCode')
  const knownCodes = parseKnownCodes(typesSource)
  // KNOWN_CODES = ErrorCode − UNKNOWN；ErrorCode = Rust 码 + CANCELLED + UNKNOWN
  diffSets('KNOWN_CODES', 'ErrorCode 联合', tsUnion.filter((code) => code !== FALLBACK_CODE), 'KNOWN_CODES', knownCodes, errors)
  diffSets('ErrorCode', 'Rust 可发码', rustCodes, 'TS 可分支码', knownCodes.filter((code) => !FRONTEND_ONLY_CODES.includes(code)), errors)
  if (!tsUnion.includes(FALLBACK_CODE)) errors.push(`ErrorCode 联合缺少兜底码 ${FALLBACK_CODE}`)

  // 3. DTO 字段
  const interfaces = parseTsInterfaces(typesSource)
  const rustSources = new Map()
  for (const [tsName, rustFile, rustName] of DTO_MANIFEST) {
    try {
      if (!rustSources.has(rustFile)) rustSources.set(rustFile, readRepo(directory, rustFile))
      const rustFields = parseRustStructFields(rustSources.get(rustFile), rustName)
      const tsFields = interfaces.get(tsName)
      if (tsFields === undefined) throw new Error(`TS 里找不到 interface ${tsName}`)
      diffSets(`DTO ${tsName} ↔ ${rustName}`, 'Rust', rustFields, 'TS', tsFields, errors)
    } catch (error) {
      errors.push(`DTO ${tsName} ↔ ${rustName}：${error.message}`)
    }
  }

  // 4. 字符串枚举
  for (const [tsName, rustFile, rustName] of ENUM_MANIFEST) {
    try {
      if (!rustSources.has(rustFile)) rustSources.set(rustFile, readRepo(directory, rustFile))
      const rustLiterals = parseRustEnumLiterals(rustSources.get(rustFile), rustName)
      const tsLiterals = parseTsUnion(typesSource, tsName)
      diffSets(`枚举 ${tsName} ↔ ${rustName}`, 'Rust', rustLiterals, 'TS', tsLiterals, errors)
    } catch (error) {
      errors.push(`枚举 ${tsName} ↔ ${rustName}：${error.message}`)
    }
  }

  if (errors.length > 0) throw new Error(`IPC 契约校验失败：\n${errors.join('\n')}`)
  return {
    commands: rustCommands.length,
    errorCodes: rustCodes.length,
    dtos: DTO_MANIFEST.length,
    enums: ENUM_MANIFEST.length,
  }
}

if (isMainModule()) {
  try {
    if (process.argv.length > 2) throw new Error('用法：node scripts/check-ipc.mjs')
    const stats = checkIpc(root)
    console.log(
      `IPC 契约校验通过：${stats.commands} 条命令三方一致、${stats.errorCodes} 个错误码、` +
        `${stats.dtos} 组 DTO 字段、${stats.enums} 组字符串枚举`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

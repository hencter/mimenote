/**
 * Vault 配置文件（`.mimenote/config.<toml|yaml|json>`）的**读写与形状判据**（ADR-0055）。
 *
 * 这一层只回答三个问题：
 * 1. 该读哪一个文件（候选顺序）、写回哪个文件名（格式 → 规范文件名）；
 * 2. 这份文本能不能解析成一个对象（解析失败要**如实报错**，不是回退默认值就完事）；
 * 3. 这份文本里有没有注释 —— 有注释就**拒绝改写**。
 *
 * **字段的含义、默认值与取值范围不在这里**：那是 `state/settings-store.ts` 的职责
 * （它才是偏好的唯一事实来源）。把 schema 也搬进来会立刻长出第二份默认值，
 * 而那正是 ADR-0048 在 frontmatter 上吃过一次的亏。
 *
 * 格式选择沿用 frontmatter 的既有依赖（`smol-toml` / `yaml` / 原生 `JSON`），
 * **不为配置文件新增任何依赖**。
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** 应用在 Vault 内的私有目录（扫描器忽略它，见 `crates/mn-core` 的 scanner）。 */
export const CONFIG_DIR = '.mimenote'

/**
 * 配置 schema 版本。
 *
 * 读到**更大**的版本号时只读不写：写入会把新版本才有的字段抹掉，
 * 而用户可能同时在另一台机器上用着更新的版本（配置文件会被 git 同步）。
 */
export const CONFIG_SCHEMA_VERSION = 1

export type ConfigFormat = 'toml' | 'yaml' | 'json'

/**
 * 候选文件与优先级（**只有第一个存在的生效**）。
 *
 * 为什么固定成四个名字而不是"扫一遍 `.mimenote/` 找 config.*"：扫描会给"用户随手丢进来的
 * `config.bak.md`"这种东西以解释权，也会让"当前生效的是哪一个"变得不可预测。
 * 四个名字、一个顺序，界面里直接显示命中的那一个 —— 用户改错文件时一眼能看出来。
 */
export const CONFIG_FILE_CANDIDATES: readonly { readonly fileName: string; readonly format: ConfigFormat }[] = [
  { fileName: 'config.toml', format: 'toml' },
  { fileName: 'config.yaml', format: 'yaml' },
  { fileName: 'config.yml', format: 'yaml' },
  { fileName: 'config.json', format: 'json' },
]

/** 允许写入的扩展名（宿主侧的白名单与它同源，见 `config_write` 的说明）。 */
export const CONFIG_WRITE_EXTENSIONS: readonly string[] = ['toml', 'yaml', 'yml', 'json']

/**
 * 格式 → **应用自己写回时**用的规范文件名。
 *
 * `yaml` 只写 `.yaml`：`.yml` 是给别人手工放进来的兼容入口，应用不主动制造第二种拼法
 * （否则同一个 Vault 里会同时出现 `config.yaml` 与 `config.yml`，谁生效要靠文档解释）。
 */
export function configFileNameOf(format: ConfigFormat): string {
  if (format === 'toml') return 'config.toml'
  if (format === 'yaml') return 'config.yaml'
  return 'config.json'
}

/** 文件名 → 格式（不认识的名字返回 `null`）。 */
export function configFormatOf(fileName: string): ConfigFormat | null {
  const hit = CONFIG_FILE_CANDIDATES.find((candidate) => candidate.fileName === fileName)
  return hit?.format ?? null
}

/** 展示用的 Vault 内相对路径。 */
export function configRelPathOf(fileName: string): string {
  return `${CONFIG_DIR}/${fileName}`
}

export type ConfigParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * 解析配置文本。
 *
 * 失败**不抛异常**（与 `MimenoteError` 的"错误是数据"同一条思路）：配置文件是用户会手改的
 * 东西，语法错必须能显示在设置页上，而不是把 bootstap 炸掉。空文件等价于"全用默认值"。
 */
export function parseConfigText(text: string, format: ConfigFormat): ConfigParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: {} }

  try {
    const parsed: unknown =
      format === 'toml' ? parseToml(trimmed) : format === 'yaml' ? parseYaml(trimmed) : JSON.parse(trimmed)
    if (!isPlainObject(parsed)) {
      return { ok: false, message: '配置文件的顶层必须是一个表（对象），而不是数组或标量。' }
    }
    return { ok: true, value: parsed }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, message: `${format.toUpperCase()} 解析失败：${detail}` }
  }
}

export type ConfigSerializeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string }

/**
 * 序列化配置。
 *
 * 三格式的输出都**不带注释**：应用自己写的文件永远能被应用再写一次，
 * 于是"含注释就拒绝改写"这条纪律不会把用户锁死（一改注释就再也改不动配置，
 * 那种设计是拿纪律当借口）。用户手工加注释之后，写权交还给用户 —— 见 {@link hasConfigComments}。
 */
export function serializeConfigText(value: Record<string, unknown>, format: ConfigFormat): ConfigSerializeResult {
  const nullPath = findNullPath(value)
  if (nullPath !== null) {
    // TOML 没有 null：让它悄悄变成字符串 "null" 比报错糟得多
    return { ok: false, message: `配置里 ${nullPath} 为空值，${format.toUpperCase()} 无法表示 —— 删掉这个键即可恢复默认。` }
  }

  try {
    if (format === 'toml') return { ok: true, text: ensureTrailingNewline(stringifyToml(value as never)) }
    if (format === 'yaml') return { ok: true, text: ensureTrailingNewline(stringifyYaml(value)) }
    return { ok: true, text: ensureTrailingNewline(JSON.stringify(value, null, 2)) }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, message: `${format.toUpperCase()} 序列化失败：${detail}` }
  }
}

/**
 * 这份文本里有没有注释。
 *
 * 为什么必须有这个判据：`smol-toml` 与 `yaml` 的序列化都不带注释，直接改写会把用户
 * 手写的说明整段吃掉。ADR-0048 在 frontmatter 上已经定过这条纪律，这里沿用同一个答案：
 * **宁可让用户去源码里改，也不静默丢注释**。
 *
 * 保守实现：YAML 的块标量（`|` / `>`）里以 `#` 开头的行会被判成注释 —— 代价是一次
 * 多余的"请手工编辑"提示，比反向漏判（吃掉注释）安全得多。
 */
export function hasConfigComments(text: string, format: ConfigFormat): boolean {
  if (format === 'json') return false
  if (format === 'toml') return tomlHasComment(text)
  return yamlHasComment(text)
}

function tomlHasComment(text: string): boolean {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '#') return true
    if (char === '"' || char === "'") {
      const quote = char
      const triple = text.startsWith(quote.repeat(3), index)
      const closer = triple ? quote.repeat(3) : quote
      index += closer.length
      while (index < text.length) {
        // 基本串（含多行基本串）里 `\` 仍然转义；字面量串（单引号）里没有转义
        if (quote === '"' && text[index] === '\\') {
          index += 2
          continue
        }
        if (text.startsWith(closer, index)) {
          index += closer.length
          break
        }
        index += 1
      }
      continue
    }
    index += 1
  }
  return false
}

function yamlHasComment(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    let inSingle = false
    let inDouble = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (inDouble) {
        if (char === '\\') index += 1
        else if (char === '"') inDouble = false
        continue
      }
      if (inSingle) {
        if (char === "'") {
          if (line[index + 1] === "'") index += 1
          else inSingle = false
        }
        continue
      }
      if (char === '"') {
        inDouble = true
        continue
      }
      if (char === "'") {
        inSingle = true
        continue
      }
      // YAML 的注释只在行首或空白之后开始：`a#b` 是一个普通标量，不是注释
      if (char === '#' && (index === 0 || line[index - 1] === ' ' || line[index - 1] === '\t')) return true
    }
  }
  return false
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 找出第一个值为 `null` 的键路径（仅供错误提示用）。 */
function findNullPath(value: Record<string, unknown>): string | null {
  const walk = (current: unknown, path: string): string | null => {
    if (current === null) return path
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const hit = walk(current[index], `${path}[${index}]`)
        if (hit !== null) return hit
      }
      return null
    }
    if (isPlainObject(current)) {
      for (const [key, child] of Object.entries(current)) {
        const hit = walk(child, path === '' ? key : `${path}.${key}`)
        if (hit !== null) return hit
      }
    }
    return null
  }
  return walk(value, '')
}

/**
 * frontmatter 三种写法的**解析与改写**（属性表/属性编辑器的事实来源）。
 *
 * ## 三种围栏
 * - `---` YAML（本应用与 OKF 的默认形态）
 * - `+++` TOML（Hugo / Zola 的事实标准）
 * - `;;;` JSON（Hexo 风格）
 *
 * 认这三个是 ADR-0047 的决定：笔记是"普通文件夹里的普通 Markdown"，要能直接搬去
 * 这些工具里用，而不是要求用户先转成 YAML。三种格式在**这里**收敛成同一个
 * `Record<string, unknown>`，上层（`FrontmatterEditor` / 属性输入控件）不必分叉。
 *
 * ## 三条纪律
 * 1. **保真优先**：围栏之外的正文、BOM、CRLF/LF 逐字保留（见 {@link replaceMetadata}）；
 *    YAML 走 `yaml` 的文档模型（保留注释、字段顺序与其它值的原始写法），
 *    TOML 走 `smol-toml` 的重建，JSON 走 `JSON.stringify`。
 * 2. **读不懂就报错，不改写**：解析失败一律抛错（调用方把错误原话显示出来），
 *    绝不做"尽力而为"的猜测改写 —— 看不懂的结构不配拥有改写权（与
 *    `crates/mn-core` 的 frontmatter 改写纪律同一条）。
 * 3. **会丢东西的操作要拦**：TOML 里带注释时，改名/排序/改字段都会**抛错并让用户
 *    去源码里改**，而不是静默把注释吃掉（`smol-toml` 序列化不带注释）。
 *
 * ## 与宿主（Rust）的分工
 * Rust 侧的 `mn-core::frontmatter` 负责**索引口径**（标签抽取、链接改写时的字段改写），
 * 这里负责**界面上的编辑**。两者都认这三个围栏 —— 一条纪律写在两处时必须同时改，
 * 边界见 ADR-0047 的 §1。
 */

import { isMap, isScalar, parseDocument, stringify as stringifyYaml } from 'yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/** 三种 frontmatter 写法。 */
export type MetadataFormat = 'yaml' | 'toml' | 'json'

/**
 * 这段 TOML 里**真的**有注释吗（引号内的 `#` 不算）。
 *
 * 为什么不能直接 `/^\s*#|\s+#/`：`title = "C # 教程"` 里那个 `#` 是**值的一部分**，
 * 按"空白 + `#`"判会把一份完全没有注释的区块判成含注释，于是用户改一个字段
 * 也会被赶去源码里改（YAML 同名值却没事 —— 同一件事两种行为）。
 *
 * 判法：先把字符串字面量（基本串 `"…"`、字面串 `'…'`、两种多行串）整段抠掉，
 * 再看剩下的部分有没有 `#`。**不追求复刻 TOML 词法**：未闭合的引号会让正则
 * 匹配不到尾部，那个尾巴里的 `#` 会被当成注释 ⇒ 结果是"拒绝改写"，
 * 也就是往**安全**那一侧退化（宁可不改，也不吃掉注释）。
 */
export function tomlHasComment(source: string): boolean {
  const withoutStrings = source.replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*'/g,
    '',
  )
  return /#/.test(withoutStrings)
}

/**
 * 字段改名（属性表里改键名）。
 *
 * YAML 用文档模型原地改键（注释与排版都留着）；TOML/JSON 走"解析 → 重建"，
 * 因此**含注释的 TOML 直接拒绝**（见模块文档第 3 条）。
 *
 * @throws 名称为空 / 目标名已存在 / 原名不存在 / 复杂键 / 含注释的 TOML
 */
export function renameMetadata(source: string, format: MetadataFormat, from: string, to: string): string {
  to = to.trim()
  if (!to) throw new Error('属性名称不能为空')
  if (from === to) return source
  const data = parseMetadata(source, format)
  if (Object.hasOwn(data, to)) throw new Error('属性名称已存在')
  if (!Object.hasOwn(data, from)) throw new Error('原属性已不存在')
  if (format === 'yaml') {
    const doc = parseDocument(source)
    if (isMap(doc.contents)) {
      const pair = doc.contents.items.find((item) => String(item.key) === from)
      // `isScalar` 才改得动：`? [a, b]` 这种复杂键交给用户去源码里改（改错了比不改更糟）
      if (pair && isScalar(pair.key)) pair.key.value = to
      else if (pair) throw new Error('复杂键请在源码中修改')
    }
    return doc.toString()
  }
  if (format === 'toml' && tomlHasComment(source)) throw new Error('含注释的 TOML 请在源码中重命名，以保留注释。')
  return serializeMetadata(Object.fromEntries(Object.entries(data).map(([key, value]) => [key === from ? to : key, value])), format)
}

/**
 * 字段排序（属性表里拖动调整顺序）。
 *
 * 只搬 `moved` 到 `before` **之前**（不是"交换"）：拖动表达的是"我要它排在这里"。
 * 名字对不上时原样返回 —— 排序是增强，不是必须成功的事。
 */
export function reorderMetadata(source: string, format: MetadataFormat, moved: string, before: string): string {
  if (moved === before) return source
  if (format === 'yaml') {
    const doc = parseDocument(source)
    if (doc.errors.length) throw doc.errors[0]
    if (!isMap(doc.contents)) return source
    const items = doc.contents.items
    const from = items.findIndex((item) => String(item.key) === moved)
    if (from < 0 || !items.some((item) => String(item.key) === before)) return source
    const [item] = items.splice(from, 1)
    if (item) items.splice(items.findIndex((item) => String(item.key) === before), 0, item)
    return doc.toString()
  }
  if (format === 'toml' && tomlHasComment(source)) throw new Error('含注释的 TOML 请在源码中排序，以保留注释。')
  const data = parseMetadata(source, format)
  const keys = Object.keys(data)
  if (!keys.includes(moved) || !keys.includes(before)) return source
  const sorted = keys.filter((key) => key !== moved)
  sorted.splice(sorted.indexOf(before), 0, moved)
  return serializeMetadata(Object.fromEntries(sorted.map((key) => [key, data[key]])), format)
}

/** 区块在全文里的位置与内容。 */
export interface MetadataBlock {
  format: MetadataFormat
  /** 两个围栏**之间**的原文（行尾 `\r` 已剥掉）。 */
  source: string
  /** 正文起点（全文偏移）：围栏之后那一行的开头。 */
  to: number
  /** 结束围栏的**0 起**行号（供需要行号的调用方用）。 */
  endLine: number
}

/**
 * 找出开头的 frontmatter 区块。
 *
 * 没有区块（或围栏未闭合）返回 `null` —— "没有"不是错误，正文照常。
 * `source` 剥掉行尾 `\r` 是为了让解析器只面对 `\n`；`to` 则按**原文**字符数算，
 * 所以 CRLF 文件的正文起点仍然正确。
 */
export function metadataBlock(text: string): MetadataBlock | null {
  const lines = text.split('\n')
  const head = (lines[0] ?? '').replace(/^\uFEFF/, '').trimEnd()
  const format: MetadataFormat | null = head === '---' ? 'yaml' : head === '+++' ? 'toml' : head === ';;;' ? 'json' : null
  if (format === null) return null
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === head)
  if (end < 0) return null
  // 前 end+1 行按 `\n` 拼回来的长度 = 结束围栏那一行的末尾；还有后续行时 +1 就是正文起点
  const to = lines.slice(0, end + 1).join('\n').length + (end < lines.length - 1 ? 1 : 0)
  return { format, source: lines.slice(1, end).map((line) => line.replace(/\r$/, '')).join('\n'), to, endLine: end }
}

/**
 * 区块原文 → 普通对象。
 *
 * 顶层必须是键值对象：数组/标量（`+++\n[1,2]\n+++`）在这里就报错，
 * 而不是让它以"没有属性"的样子混过去。
 */
export function parseMetadata(source: string, format: MetadataFormat): Record<string, unknown> {
  let data: unknown
  if (format === 'yaml') {
    const document = parseDocument(source)
    if (document.errors.length) throw document.errors[0]
    // `contents === null` = **空区块**（`---\n---`，或者块里只有注释）：给 `{}`，
    // 否则空 frontmatter 一打开就是红色报错。而显式写了 `null` / `~` 的区块
    // `contents` 是 Scalar(null)，会走到下面的对象检查并被拒绝 —— 与 JSON 分支一致。
    data = document.contents === null ? {} : document.toJS({ maxAliasCount: 100 })
  } else if (format === 'toml') data = parseToml(source)
  // 空白串与空串一样按"空区块"处理：`''` 与 `'  '` 不该有不同结局
  else data = source.trim() === '' ? {} : JSON.parse(source)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('属性必须是键值对象')
  return data as Record<string, unknown>
}

/** 普通对象 → 区块原文（不含围栏）。 */
export function serializeMetadata(data: Record<string, unknown>, format: MetadataFormat): string {
  if (format === 'yaml') return stringifyYaml(data)
  if (format === 'toml') return stringifyToml(data)
  return JSON.stringify(data, null, 2)
}

/**
 * 改（或删）一个字段的值，返回新的区块原文。
 *
 * YAML 用文档模型（注释、字段顺序、其它值的引号写法都留着）；TOML/JSON 重建整块。
 * 含注释的 TOML 一律拒绝 —— `smol-toml` 的序列化不带注释，静默吃注释比报错糟得多。
 */
export function editMetadataField(source: string, format: MetadataFormat, key: string, value: unknown, remove = false): string {
  if (format === 'yaml') {
    const doc = parseDocument(source)
    if (doc.errors.length) throw doc.errors[0]
    if (remove) doc.delete(key)
    else doc.set(key, value)
    return doc.toString()
  }
  if (format === 'toml' && tomlHasComment(source)) throw new Error('这份 TOML 含注释，请使用源码编辑以保留注释。')
  const data = parseMetadata(source, format)
  if (remove) delete data[key]
  // `defineProperty` 而不是 `data[key] = value`：键名可能就是 `__proto__`，
  // 赋值会挂到原型上（静默丢失），定义自有属性才是"写进这一条"。
  else Object.defineProperty(data, key, { value, enumerable: true, writable: true, configurable: true })
  return serializeMetadata(data, format)
}

/**
 * 把新的区块原文写回全文。
 *
 * 先解析一次新原文（写回前再确认它合法），然后**只替换两个围栏之间的部分**：
 * BOM、正文、CRLF/LF 都按原文逐字保留 —— 属性编辑不该产生"保存一次 = 全文 diff"。
 * 原本没有区块时（用户第一次加属性）按这个格式新造一个。
 */
export function replaceMetadata(text: string, source: string, format: MetadataFormat): string {
  parseMetadata(source, format)
  const block = metadataBlock(text)
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = block ? text.slice(block.to) : text.slice(bom.length)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const fence = format === 'yaml' ? '---' : format === 'toml' ? '+++' : ';;;'
  return `${bom}${fence}${eol}${source.replace(/\r\n/g, '\n').trimEnd().replace(/\n/g, eol)}${eol}${fence}${eol}${body}`
}

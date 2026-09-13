/**
 * 换行风格与 BOM 的检测/还原（ADR-0002：写入必须"看起来像人类写的"）。
 *
 * 编辑器内部统一用 `\n`（CodeMirror 的行分隔符），保存时再还原磁盘上的原始风格，
 * 避免"打开一个 CRLF 文件、保存后整个文件被 Git 视为全部改动"。
 */

/** 磁盘上的换行风格。 */
export type Eol = '\n' | '\r\n'

/** 文本格式元信息。 */
export interface TextFormat {
  /** 是否带 UTF-8 BOM。 */
  bom: boolean
  /** 磁盘换行风格。 */
  eol: Eol
}

/** 编辑器态文本 + 格式。 */
export interface EditorText {
  text: string
  format: TextFormat
}

const BOM = '\uFEFF'

/** 检测原始文本的格式。 */
export function detectFormat(raw: string): TextFormat {
  const bom = raw.startsWith(BOM)
  let crlf = 0
  let lf = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== 10) continue
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf += 1
    else lf += 1
  }
  // 混合换行时以多数为准（CRLF 至少出现且不少于 LF）
  const eol: Eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n'
  return { bom, eol }
}

/** 原始文本 → 编辑器态（去 BOM，换行归一化为 `\n`）。 */
export function toEditorText(raw: string): EditorText {
  const format = detectFormat(raw)
  const body = format.bom ? raw.slice(1) : raw
  const text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return { text, format }
}

/** 编辑器态 → 磁盘文本（还原换行风格与 BOM）。 */
export function fromEditorText(text: string, format: TextFormat): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = format.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  return format.bom ? BOM + body : body
}

/**
 * 图片附件的**命名与路径规则**（纯函数，无 React / 无 IPC / 不碰文件系统）。
 *
 * 为什么单独成模块：这些规则决定"用户粘进来的图叫什么、放在哪、笔记里写什么路径"，
 * 而它们全是**可枚举的边界**（通用名、无扩展名、MIME 缺失、重名、空格、保留名……）。
 * 放在纯函数里能用 vitest 逐条钉死，也能让 Mock 适配器（`ipc/mock-adapter.ts`）复用
 * **同一份**实现 —— 假适配器与真实宿主一旦在命名上漂移，测试就会绿得毫无意义。
 *
 * 权威判定仍然在宿主（`src-tauri/src/attachments.rs`）：这里只保证"送过去的东西是合理的"，
 * 越界、符号链接、Windows 保留名由 `path_guard` 最终裁决（见 ADR-0007 的同一姿态）。
 */

import { hasIllegalChars, isImageAssetTarget, isReservedName } from './assets'
import { extensionOf, parentOf, stem } from './paths'

/** 默认附件目录（设置页的默认值；空串表示 Vault 根目录）。 */
export const DEFAULT_ATTACHMENT_DIR = '附件'

/** 单张附件上限（与宿主 `MAX_ATTACHMENT_BYTES` 一致，前端只是**提前**提示）。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** 一批附件上限（与宿主 `MAX_ATTACHMENT_BATCH_BYTES` 一致）。 */
export const MAX_ATTACHMENT_BATCH_BYTES = 32 * 1024 * 1024
/** 一次最多接受的张数（与宿主 `MAX_ATTACHMENTS_PER_REQUEST` 一致）。 */
export const MAX_ATTACHMENTS = 32

/**
 * MIME → 扩展名。
 *
 * 只列宿主白名单里有的类型（`image/tiff`、`image/heic` 之类刻意**没有** —— 它们既渲染不了
 * 也导出不了，收下来只会变成一个永远显示占位的文件）。
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/**
 * 剪贴板/截图工具给不出版权信息的"通用名"。
 *
 * 这些名字**必须**被换掉：连着粘三张截图，它们会全部叫 `image.png`，
 * 于是后两张被去重成 `image 1.png` / `image 2.png` —— 用户在文件树里看到的是一堆
 * 猜不出内容的文件名。带时间戳的名字至少能对上"我什么时候粘的"。
 */
const GENERIC_STEMS: ReadonlySet<string> = new Set([
  'image',
  'blob',
  'untitled',
  'clipboard',
  'pastedimage',
  'paste',
  '图片',
  '未命名',
])

/** 通用名的替换主干（与时间戳拼起来：`粘贴图片 2025-01-01 123456.png`）。 */
const GENERIC_STEM = '粘贴图片'

/**
 * 扩展名推断：MIME 优先，其次原文件名的扩展名。
 *
 * 两者都拿不到（例如拖进来的文件既没有类型信息、名字也没有扩展名）→ `null`，调用方必须
 * **明确拒绝**：宿主只接受白名单扩展名，蒙一个扩展名等于给"任意文件写进 Vault"开门。
 */
export function extensionForImage(mime: string, fileName: string): string | null {
  const normalized = mime.trim().toLowerCase()
  const fromMime = MIME_EXTENSIONS[normalized]
  if (fromMime !== undefined) return fromMime
  // 是图片类型、但我们不支持（`image/tiff` / `image/heic`）：**直接拒绝**，不要退回文件名。
  // 这类文件即使名字写着 `.png`，里面的字节也不是 PNG —— 按名字落盘等于造一个"扩展名撒谎"
  // 的文件（渲染器打不开、导出的 data URL 也是错的类型）。
  if (normalized.startsWith('image/')) return null
  // MIME 缺失（`''`）或不是图片类型（`application/octet-stream`、某些拖放实现就是这样）：
  // 这时文件名是唯一线索，但它必须落在与宿主一致的白名单里
  const ext = extensionOf(fileName)
  if (ext === '' || !isImageAssetTarget(fileName)) return null
  return ext
}

/** 名字是否"没有信息量"（通用名、无扩展名、空名、只有扩展名）→ 该换成时间戳名。 */
export function isGenericImageName(fileName: string): boolean {
  const name = fileName.trim()
  if (name === '') return true
  // 无扩展名：名字里连类型都没有（`blob` 就是这类），扩展名只能靠 MIME 补
  if (extensionOf(name) === '') return true
  const bare = stem(name).trim().toLowerCase()
  if (bare === '') return true
  return GENERIC_STEMS.has(bare)
}

/** `YYYY-MM-DD HHmmss`（本地时间；文件名里不能出现 `:`，所以时分秒连写）。 */
export function attachmentTimestamp(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${date} ${time}`
}

/**
 * 文件名主干的安全化（与 `mn_core::path_guard::sanitize_file_stem` 同一套口径）。
 *
 * 与宿主的区别只有一处：这里**不做**「保留名 + 后缀」的花样处理，而是把整个名字交给调用方
 * 换成时间戳名（见 {@link attachmentFileName}）—— 附件不需要"con 这个名字必须留下"，
 * 需要的是"一定能落盘"。
 *
 * 非法时返回**空串**，由调用方决定退路（当前是换成时间戳名）。
 */
export function sanitizeAttachmentStem(input: string): string {
  let sanitized = ''
  // "这个名字里有没有真的字符"：全是非法字符或分隔符的名字（`***`、`///`）会被替换成一串 `-`，
  // 那串 `-` 本身合法却毫无信息量 —— 与"什么都不剩"同等对待，交给调用方换名
  let meaningful = false
  for (const char of input) {
    // 控制字符、Windows 非法字符与路径分隔符一律换成 `-`
    //（不删除：删掉会让两个不同名字撞在一起）
    if (char.charCodeAt(0) < 0x20 || hasIllegalChars(char) || char === '/' || char === '\\') {
      sanitized += '-'
      continue
    }
    sanitized += char
    if (char.trim() !== '') meaningful = true
  }
  if (!meaningful) return ''
  // 折叠空白、去首尾空格与尾随点（Windows 会静默截断它们，留着就会"名字对不上"）
  const collapsed = sanitized.split(/\s+/).filter((part) => part !== '').join(' ')
  const trimmed = collapsed.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '')
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return ''
  if (isReservedName(trimmed)) return ''
  return truncateBytes(trimmed, 120)
}

/** 按 UTF-8 字节截断（Windows 单段上限 255 字节，留足扩展名与去重后缀的余量）。 */
function truncateBytes(input: string, maxBytes: number): string {
  if (new TextEncoder().encode(input).length <= maxBytes) return input
  let out = ''
  let used = 0
  for (const char of input) {
    const size = new TextEncoder().encode(char).length
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** 命名输入（`File` 能提供的全部信息 + 一个时刻）。 */
export interface AttachmentNameInput {
  /** `File.name`（可能是 `image.png`、`blob`、甚至空串）。 */
  name: string
  /** `File.type`（可能为空串）。 */
  mime: string
  /** 用于生成时间戳名的时刻（测试里传固定值，保证可预期）。 */
  at: Date
}

/**
 * 决定附件落盘时用的文件名（不含目录）。
 *
 * 规则（顺序即优先级）：
 * 1. 扩展名由 MIME 推断，MIME 缺失/不认识时退到原文件名的扩展名；两者都拿不到 → `null`（拒绝）；
 * 2. 名字"有信息量"就**原样保留**（`屏幕截图 2025-01-01.png` 保持原样 —— 用户认得出它）；
 * 3. 名字是通用名/空名/无扩展名，或者安全化之后什么都不剩（全是非法字符、保留名）
 *    → 换成 `粘贴图片 2025-01-01 123456.png`。
 *
 * 注意这里**不做重名去重**：磁盘上有什么只有宿主知道（`uniqueAttachmentName` 负责那一半，
 * 由宿主与 Mock 各自调用）。
 */
export function attachmentFileName(input: AttachmentNameInput): string | null {
  const ext = extensionForImage(input.mime, input.name)
  if (ext === null) return null

  const generic = isGenericImageName(input.name)
  const sanitized = generic ? '' : sanitizeAttachmentStem(stem(input.name.trim()))
  const base = sanitized === '' ? `${GENERIC_STEM} ${attachmentTimestamp(input.at)}` : sanitized
  return `${base}.${ext}`
}

/**
 * 同名去重：`图.png` 已存在 → `图 1.png` → `图 2.png` …（**绝不覆盖**）。
 *
 * `isTaken` 由调用方给出（宿主查磁盘、Mock 查内存表、测试给一个集合）。
 * 用尽尝试次数返回 `null`（宿主侧对应 `ALREADY_EXISTS`），**不**回退成覆盖。
 */
export function uniqueAttachmentName(
  baseName: string,
  isTaken: (candidate: string) => boolean,
  maxAttempts = 1000,
): string | null {
  if (!isTaken(baseName)) return baseName
  const dot = baseName.lastIndexOf('.')
  const base = dot <= 0 ? baseName : baseName.slice(0, dot)
  const ext = dot <= 0 ? '' : baseName.slice(dot)
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const candidate = `${base} ${attempt}${ext}`
    if (!isTaken(candidate)) return candidate
  }
  return null
}

/**
 * 相对路径：从 `fromRelPath`（笔记）指到 `toRelPath`（附件）。
 *
 * 与既有图片解析口径一致（`domain/assets.ts` 的 `resolveVaultAssetRel`）：**相对路径优先**。
 * 写绝对路径（`/附件/图.png`）也能用，但笔记被移到别的目录后它仍然指向 Vault 根，
 * 相对路径则会跟着笔记走 —— 这里选择后者。
 */
export function relativeAssetHref(fromRelPath: string, toRelPath: string): string {
  const fromDir = parentOf(fromRelPath)
  const fromSegments = fromDir === '' ? [] : fromDir.split('/')
  const toSegments = toRelPath.split('/')

  let common = 0
  // 最多比到目标的**倒数第二段**：最后一段是文件名，绝不能当成共同前缀吃掉
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1
  }
  const up = fromSegments.slice(common).map(() => '..')
  return [...up, ...toSegments.slice(common)].join('/')
}

/**
 * Markdown 图片地址里必须转义的字符。
 *
 * 为什么不能直接把路径塞进 `![](…)`：CommonMark 的地址在遇到空白时**就结束了**，
 * 而附件名里空格很常见（`屏幕截图 2025-01-01.png`、`粘贴图片 2025-01-01 123456.png`）——
 * 不转义的话链接会被截断成 `![](屏幕截图)`，图片永远显示不出来。
 * `(` / `)` 同理（括号数量不配平时地址同样解析不出来），`%` 必须转义否则会与已有编码混淆。
 *
 * 只转义这些"语法敏感"字符，中文等非 ASCII 字符**保持原样**：既好读，也与
 * `resolveVaultAssetRel` 的解码口径一致（它只做一次 `decodeURIComponent`）。
 */
const HREF_UNSAFE = /[\s()<>"`#%[\]{}\\]/g

/** 单段路径的百分号编码（只处理语法敏感字符，中文保持可读）。 */
function encodeSegment(segment: string): string {
  return segment.replace(HREF_UNSAFE, (char) => {
    const code = char.charCodeAt(0)
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`
  })
}

/** 把 Vault 相对路径编码成可以安全放进 `![](…)` 的写法（逐段编码，分隔符保留）。 */
export function encodeMarkdownHref(relPath: string): string {
  return relPath.split('/').map(encodeSegment).join('/')
}

/**
 * 插入编辑器的那段 Markdown：`![](相对路径)`。
 *
 * 为什么 alt 留空：粘贴进来的截图我们并不知道它画的是什么，编一个说明反而会在阅读视图里
 * 多出一行图注；留空则只显示图片本身（用户想加说明随时可以在方括号里补）。
 */
export function attachmentMarkdown(noteRelPath: string, attachmentRelPath: string): string {
  return `![](${encodeMarkdownHref(relativeAssetHref(noteRelPath, attachmentRelPath))})`
}

/**
 * 归一化设置页里的"附件目录"值。
 *
 * 合法值 = 若干合法路径段（可空 = Vault 根）；其余（绝对路径、`..`、非法字符、保留名）
 * **回退到默认值**而不是留着让宿主每次都报 `PATH_INVALID` —— 设置项里存着一个永远失败的值，
 * 用户只会看到"粘贴没反应"。
 */
export function normalizeAttachmentDir(value: string): string {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (normalized === '') return ''
  const segments = normalized.split('/')
  const invalid = segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.trim() !== segment ||
      segment.endsWith('.') ||
      hasIllegalChars(segment) ||
      isReservedName(segment),
  )
  return invalid ? DEFAULT_ATTACHMENT_DIR : normalized
}

/**
 * base64 文本 → 原始字节数的**上界**（4 字符最多 3 字节）。
 *
 * 与宿主 `attachments.rs::estimated_bytes` 同一口径：Mock 用它做与宿主一致的"先估后解"
 * 两段式校验，于是"超大载荷"的测试不必真的构造一个 8 MiB 的字符串。
 */
export function estimatedDecodedBytes(encodedLength: number): number {
  return Math.floor(encodedLength / 4) * 3
}

/** 字节 → 标准 base64（RFC 4648，含 `=` 填充）。与宿主 `assets::base64_encode` 同口径。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    out += ALPHABET[(triple >> 18) & 0x3f]
    out += ALPHABET[(triple >> 12) & 0x3f]
    out += second === undefined ? '=' : ALPHABET[(triple >> 6) & 0x3f]
    out += third === undefined ? '=' : ALPHABET[triple & 0x3f]
  }
  return out
}

/**
 * Vault 内资源的路径解析（给预览的 `asset:` 协议用）。
 *
 * 领域层规则：纯字符串处理、不碰文件系统、不 import React/Tauri —— 这样"越界拒绝"
 * 这类安全判定可以在 vitest 里逐条钉死，而不是等到真实 WebView 里才发现。
 *
 * 输出是**Vault 相对路径**（POSIX 风格），与 IPC 契约一致（跨 IPC 只传相对路径）；
 * 由宿主用 `mn_core::path_guard` 把它变成磁盘绝对路径 —— 那一步才会逐级检查符号链接，
 * 避免"Vault 内的符号链接指向外部文件"被读出来（见 ADR-0007）。
 */

import { parentOf } from './paths'

/** 是否是外部/内联地址（http(s)、data:、blob:、asset:、协议相对 `//`）。 */
export function isExternalAssetHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim())
}

/**
 * 允许按图片渲染的扩展名。
 *
 * ⚠️ 必须与宿主的授权白名单（`src-tauri/src/assets.rs::ALLOWED_IMAGE_EXTENSIONS`）**逐字一致**：
 * 这里判"该不该按图片渲染"，宿主判"能不能读"。两边不同步就会出现
 * "渲染成 `<img>` 却永远拿不到授权"的占位态 —— 那种状态最容易被当成"图片功能坏了"。
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'ico',
])

/**
 * 目标是否指向一张图片（只看扩展名，大小写不敏感）。
 *
 * 只做字符串判断：目录里到底有没有这张图由宿主说了算（这里放行不代表能读）。
 * 主要给 `![[…]]` 嵌入（Obsidian 风格）分流用：图片走图片路径，`![[另一篇笔记]]` 退回链接。
 */
export function isImageAssetTarget(target: string): boolean {
  const name = target.trim().split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // `dot <= 0`：没有扩展名，或者文件名以 `.` 开头（`.gitignore` 不是图片）
  if (dot <= 0 || dot === name.length - 1) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Windows 保留设备名（与 `mn_core::path_guard` 的口径一致；导出理由见 `hasIllegalChars`）。 */
export function isReservedName(segment: string): boolean {
  const stem = (segment.split('.')[0] ?? '').toUpperCase()
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

/** `![[图.png|300]]` 里那种尺寸标记（宽 / 宽x高）。 */
export interface ImageSize {
  /** 宽度（像素）。 */
  width: number
  /** 高度（像素）；只写宽度时为 `null`（按原图比例缩放）。 */
  height: number | null
}

/** 尺寸上限：写 `|999999` 出来的图会把整页排版撑爆，超过就当它不是尺寸标记。 */
const MAX_SIZE = 4000

/**
 * 解析 `![[图.png|别名]]` 里的别名：**纯数字**（或 `宽x高`）当尺寸，其余当图注。
 *
 * 这是 Obsidian 的既有约定：从它迁移过来的笔记里 `![[图.png|300]]` 到处都是，
 * 而我们此前一律当图注渲染 —— 结果那些笔记的图片尺寸设置全部失效，
 * 图上还多出一行"300"的文字。判据刻意很窄（只认十进制数字与 `x`/`X` 分隔），
 * 因为"300 字以内"这种**看起来像数字的图注**在中文笔记里同样常见（⚠️ 见下方取舍）：
 *
 * - `|300` → 宽 300，高度按比例；
 * - `|300x200` → 宽 300、高 200；
 * - `|300 字以内`、`|图注`、`|0`、`|999999` → 不是尺寸（当图注）。
 */
export function parseImageSize(alias: string | null | undefined): ImageSize | null {
  if (alias === undefined || alias === null) return null
  const match = /^\s*(\d{1,4})(?:\s*[xX×]\s*(\d{1,4}))?\s*$/u.exec(alias)
  if (match === null) return null

  const width = Number(match[1])
  const height = match[2] === undefined ? null : Number(match[2])
  if (!Number.isFinite(width) || width <= 0 || width > MAX_SIZE) return null
  if (height !== null && (!Number.isFinite(height) || height <= 0 || height > MAX_SIZE)) return null
  return { width, height }
}

/** 图片解析器需要的最小条目信息（Vault 快照里的 `EntryMeta` 子集）。 */
export interface AssetEntry {
  relPath: string
  isDir: boolean
}

/** 图片解析器：`(当前笔记, 原始地址) -> Vault 相对路径 | null`。 */
export type AssetResolver = (noteRelPath: string, href: string) => string | null

/**
 * 造一个**带全库索引**的图片解析器（Obsidian 口径的兜底）。
 *
 * 规则（顺序即优先级）：
 * 1. 相对当前笔记、或 `/` 开头的 Vault 绝对路径 —— 解析出来的文件**确实存在**就直接用；
 * 2. 否则按**文件名**在整库图片里找唯一匹配（同名多张时按"路径更短 → 字典序"选一个）。
 *
 * 为什么需要第 2 条：从 Obsidian 过来的用户写 `![[图.png]]` 时，图往往不在当前目录，
 * 而在 `附件/` 之类的固定目录。只按"相对当前笔记"解析会让这类引用全部变成占位元素 ——
 * 用户看到的是"图片功能坏了"，而不是"路径写错了"。
 *
 * 索引只在构造时建一次（`O(条目数)`），之后每次解析是 `O(1)`（一次 Map 查表）；
 * 目录与空文件名不参与匹配。**这里放行不等于能读**：真正的读取授权仍由宿主按
 * `path_guard` 逐级校验（ADR-0007）。
 */
export function createAssetResolver(entries: readonly AssetEntry[]): AssetResolver {
  const byName = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.isDir) continue
    const name = (entry.relPath.split('/').pop() ?? '').toLowerCase()
    if (name === '') continue
    const list = byName.get(name)
    if (list === undefined) byName.set(name, [entry.relPath])
    else list.push(entry.relPath)
  }
  // 同名多张：按"路径更短 → 字典序"定序，保证同一份 Vault 每次解析结果一致。
  // 字典序用**码位序**（与 `tag-filter.ts` 的 comparePaths 同一约定）：`localeCompare`
  // 的默认 locale 随运行环境变（中文 Windows 是拼音序，CI 是码位序），会破坏"结果可复现"。
  for (const list of byName.values()) {
    list.sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))
  }

  return (noteRelPath, href) => {
    if (isExternalAssetHref(href)) return null
    const direct = resolveVaultAssetRel(noteRelPath, href)
    // 1) 相对当前笔记 / Vault 绝对写法的目标**确实存在** → 用它（就近优先，符合直觉）
    if (direct !== null && entries.some((entry) => !entry.isDir && entry.relPath === direct)) {
      return direct
    }
    // 2) **只有裸文件名**才走"全库同名兜底"（`![[图.png]]` 的 Obsidian 用法）。
    //    带路径的写法（`../图.png`、`a/b.png`）绝不兜底 —— 否则一个被拒绝的越界写法
    //    会静默落到另一个同名文件上，那比直接失败更糟。
    const normalized = safeDecode(href.trim()).replaceAll('\\', '/')
    const name = normalized.split('/').pop()?.toLowerCase() ?? ''
    if (!normalized.includes('/') && name !== '') {
      const match = byName.get(name)?.[0]
      if (match !== undefined) return match
    }
    // 3) 都没有 → 交回"相对解析"的结果，让宿主去判定它到底存不存在
    //    （保持既有失败语义：拿不到授权就是占位元素，而不是这里提前判死）
    return direct
  }
}

/**
 * 段里是否有 Windows 非法字符或控制字符。
 *
 * 与 `isReservedName` 一起对外导出：附件命名（`domain/attachments.ts`）要用**同一套**
 * 口径判断"这个文件名/目录名能不能落盘"。这两条规则的第二份实现迟早会与宿主漂移。
 */
export function hasIllegalChars(segment: string): boolean {
  return /[<>:"|?*\u0000-\u001f]/.test(segment)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法百分号编码（`%zz`）：按原样处理，后续校验会决定是否放行
    return value
  }
}

/**
 * 把 Markdown 里的资源地址解析成**Vault 相对路径**（POSIX）。
 *
 * 支持三种写法（与 Obsidian 一致）：
 * - 相对当前笔记：`图.png`、`./子目录/图.png`、`../附件/图.png`
 * - Vault 根绝对：`/附件/图.png`
 *
 * 返回 `null` 的场合（调用方应回退到占位元素，而不是拼出一个越界路径）：
 * 空串、外部地址、`..` 越出 Vault、含 Windows 非法字符或保留设备名、只解析到根目录。
 *
 * 口径（`![[…]]` 嵌入也走同一个函数，因此两种写法必须理解成同一套规则）：
 * `图.png` 与 `附件/图.png` 都**相对当前笔记**解析（`笔记/图片.md` + `附件/图.png`
 * → `笔记/附件/图.png`），只有以 `/` 开头才是 Vault 根。
 * 注意这与 Obsidian 不同：Obsidian 的 `![[附件/图.png]]` 从 Vault 根解析、裸文件名还会全库搜；
 * 这里刻意与 `![](…)` 保持一致（见 domain/markdown.ts 的 `mn_embed` 规则注释）。
 */
export function resolveVaultAssetRel(noteRelPath: string, href: string): string | null {
  const raw = href.trim()
  if (raw === '' || isExternalAssetHref(raw)) return null

  // 统一分隔符：笔记里可能写成 `图\图.png`（Windows 习惯），不能当成转义
  const normalized = safeDecode(raw).replaceAll('\\', '/')
  const fromRoot = normalized.startsWith('/')

  const segments: string[] = []
  if (!fromRoot) {
    for (const part of parentOf(noteRelPath).split('/')) {
      if (part !== '' && part !== '.') segments.push(part)
    }
  }

  for (const part of normalized.replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // 越界：口径是"过程中任何时候越出根都拒绝"（哪怕后文又用子目录绕回来）——
      // 允许"出去再回来"会让判定依赖整条路径，容易在后续改动里被绕过。
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    if (hasIllegalChars(part) || isReservedName(part)) return null
    segments.push(part)
  }

  if (segments.length === 0) return null
  return segments.join('/')
}

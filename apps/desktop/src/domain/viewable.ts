/**
 * 「**第二类可打开的文件**」的判据：哪些附件能打开成**只读预览**，以及预览成什么。
 *
 * ## 为什么需要它
 * 本应用长久以来的判据是"只有 Markdown 才是笔记"（`domain/paths.ts` 的 `isMarkdown`）：
 * 文件树里点一张图片只会把它**选中**，什么都不显示 —— 用户报的"图片选择后无法预览"就是这条
 * 判据的直接后果，不是灯箱坏了（灯箱只服务**正文里**的图片）。
 *
 * 于是这里把"哪些文件可以被打开、用哪种查看器打开"收成**一份判据**：文件树的点击分派、
 * 主区该渲染哪个查看器、标题栏该显示谁，都问它 —— 以后加一类（JSON / TOML / CSV）只改这一处。
 *
 * ## 两条纪律
 * 1. **只读**：这一层不引入任何写路径。打开一个文件不会让它变成"可编辑的文档"——
 *    编辑仍然只发生在 Markdown 笔记上（`note-store` 那一条流水线：冲突令牌、原子写、索引同步）。
 * 2. **扩展名白名单只有一份**：图片那一支直接复用 `domain/assets.ts` 的 `isImageAssetTarget`
 *    （它与宿主 `assets.rs::ALLOWED_IMAGE_EXTENSIONS` 逐字一致）。在别处再抄一遍名单，
 *    结果就是"渲染成图片却永远拿不到授权"那种最像"功能坏了"的状态。
 */

import { isImageAssetTarget } from './assets'

/** 查看器种类。加一类 = 在这里加一个字面量 + 在 `features/viewer/` 里加一个组件。 */
export type ViewerKind = 'image'

/** 这个相对路径该用哪种查看器打开；`null` = 不提供预览（保持"只选中"的既有行为）。 */
export function viewerKindOf(relPath: string): ViewerKind | null {
  if (isImageAssetTarget(relPath)) return 'image'
  return null
}

/** 能否打开（供文件树的点击分派用）。 */
export function isViewable(relPath: string): boolean {
  return viewerKindOf(relPath) !== null
}

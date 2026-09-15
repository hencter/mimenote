/**
 * 附件查看器：把**不在正文里**的文件打开成只读预览。
 *
 * 为什么单独一层：主区要显示的对象现在有两类 —— 笔记（三种视图）与附件（按类型选查看器）。
 * `domain/viewable.ts` 给出"这属于哪一类"，这里只负责"按那一类渲染"，把分派收在一处，
 * `App.tsx` 那一段就只剩"有没有打开文件"这一个判断。
 *
 * 只读：查看器不写盘、不进标签页、不改 `note-store` 的当前文档 —— 标签页仍然是
 * "我开着哪几篇**笔记**"（ADR-0026 的口径），编辑只发生在 Markdown 上。
 */

import { displayPath } from '@/domain/paths'
import { viewerKindOf } from '@/domain/viewable'

import { ImageViewer } from './ImageViewer'
import './viewer.css'

export function FileViewer({ relPath }: { relPath: string }) {
  const kind = viewerKindOf(relPath)

  if (kind === 'image') {
    return <ImageViewer relPath={relPath} />
  }

  /*
   * 兜底：`viewerKindOf` 说不认识 —— 理论上到不了这里（文件树的点击分派只在
   * `isViewable` 为真时才打开），但"打开了一个没人认识的路径"必须有个如实的画面，
   * 而不是一片空白（那种空白最容易被当成"应用坏了"）。
   */
  return (
    <div className="mn-viewer mn-viewer--unknown" data-viewer-kind="unknown">
      <p className="mn-viewer__note">
        这一类文件暂时没有内置预览：{displayPath(relPath)}
      </p>
    </div>
  )
}

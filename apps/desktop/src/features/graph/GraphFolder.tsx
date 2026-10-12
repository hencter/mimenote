/**
 * 图谱世界层里的**一个文件夹容器**（只收 props 的子组件）。
 *
 * 为什么它留在 DOM 里（而卡片与连线画在 canvas 上）：容器头要可点、可折叠、可被 e2e
 * 用 `.mn-graph-folder*` 选中 —— 几百个 DOM 节点不是负担，而它在世界层里走的仍是同一套
 * `transform: translate/scale`（与 canvas 共用一套坐标）。
 */

import { Icon } from '@/components/Icon'
import type { GraphFolderBox } from '@/domain/graph/layout'

/** 一个文件夹容器（展开时是圆角区域，收起时是紧凑的"文件夹卡片"）。 */
export function GraphFolder({
  folder,
  onToggle,
}: {
  folder: GraphFolderBox
  onToggle: (path: string) => void
}) {
  const action = folder.collapsed ? '展开' : '收起'
  return (
    <div
      className={`mn-graph-folder${folder.collapsed ? ' mn-graph-folder--chip' : ''}`}
      style={{ left: folder.x, top: folder.y, width: folder.width, height: folder.height }}
      data-folder={folder.path}
      data-depth={folder.depth}
    >
      <button
        type="button"
        className="mn-graph-folder__header"
        data-mn-graph-nopan
        aria-expanded={!folder.collapsed}
        aria-label={`${action} ${folder.label}（${folder.noteCount} 篇）`}
        title={
          folder.collapsed
            ? `${folder.label}：${folder.noteCount} 篇（点击展开）`
            : `${folder.label}：${folder.noteCount} 篇（点击收起）`
        }
        onClick={() => onToggle(folder.path)}
      >
        <Icon name={folder.collapsed ? 'folder' : 'folderOpen'} size="xs" />
        <span className="mn-graph-folder__label">{folder.label}</span>
        <span className="mn-graph-folder__count">{folder.noteCount}</span>
      </button>
    </div>
  )
}

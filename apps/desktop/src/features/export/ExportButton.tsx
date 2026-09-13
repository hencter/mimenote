/**
 * 标题栏里的「导出」按钮。
 *
 * 为什么放在标题栏右侧：导出是"对当前这篇笔记"的整体动作，与 保存/重命名 同级，而不是
 * 文件树或编辑器内部的操作；标题栏是所有视图（编辑/阅读/图谱）都常驻的唯一一条横向空间。
 * 样式（`.mn-export-launch` 的 `margin-left: auto`）写在 `export.css` 里，**不动共享的
 * `styles/app.css`** —— 那个文件是全局布局的落点，改它会影响所有界面。
 */

import { Icon } from '@/components/Icon'
import { useNoteStore } from '@/state/note-store'

import { requestExport } from './export-events'

export function ExportButton() {
  const hasDocument = useNoteStore((state) => state.doc !== null)

  return (
    <button
      type="button"
      className="mn-button mn-export-launch"
      title={
        hasDocument
          ? '导出当前笔记（自包含 HTML / 打印为 PDF）'
          : '先打开一篇笔记，再导出它'
      }
      disabled={!hasDocument}
      onClick={requestExport}
    >
      <Icon name="save" size={14} />
      导出
    </button>
  )
}

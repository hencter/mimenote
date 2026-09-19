/**
 * 「导出」按钮：导出是"对当前这篇笔记"的整体动作。
 *
 * ADR-0038 之后它从标题栏下移进**文件树工具栏**（业务控件不再和窗口按钮挤出一条 chrome）：
 * 那里是内容层的工具区域（新建/重命名/移动/排序都在同一行），导出与它们同属"对文档的操作"。
 * 文件树被收起时仍可从命令面板（`export.html` / `export.pdf` / `export.site`）触达。
 * 样式（`.mn-export-launch`）写在 `export.css` 里，**不动共享的 `styles/app.css`**。
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
      <Icon name="save" size="sm" />
      导出
    </button>
  )
}

/** 文件树工具栏：过滤、展开/折叠、新建、重扫、切换 Vault。 */

import { useEffect, useRef } from 'react'

import { FOCUS_FILTER_EVENT } from '@/app/dom-events'
import { createNoteHere, openVaultInteractive, rescanVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { useVaultStore } from '@/state/vault-store'

export function TreeToolbar() {
  const filter = useVaultStore((state) => state.filter)
  const setFilter = useVaultStore((state) => state.setFilter)
  const expandAll = useVaultStore((state) => state.expandAll)
  const collapseAll = useVaultStore((state) => state.collapseAll)
  const info = useVaultStore((state) => state.info)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener(FOCUS_FILTER_EVENT, focus)
    return () => {
      window.removeEventListener(FOCUS_FILTER_EVENT, focus)
    }
  }, [])

  return (
    <div className="mn-tree-toolbar">
      <div className="mn-search-field">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="search"
          className="mn-search-field__input"
          placeholder="过滤笔记…"
          aria-label="过滤文件树"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setFilter('')
          }}
        />
        {filter !== '' && (
          <button
            type="button"
            className="mn-icon-button"
            aria-label="清除过滤"
            onClick={() => setFilter('')}
          >
            <Icon name="x" size={13} />
          </button>
        )}
      </div>

      <div className="mn-tree-toolbar__actions">
        <button
          type="button"
          className="mn-icon-button"
          title="新建笔记（Ctrl+N）"
          aria-label="新建笔记"
          onClick={() => void createNoteHere()}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="展开全部目录（Ctrl+Alt+E）"
          aria-label="展开全部目录"
          onClick={expandAll}
        >
          <Icon name="panelLeft" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="折叠全部目录（Ctrl+Alt+W）"
          aria-label="折叠全部目录"
          onClick={collapseAll}
        >
          <Icon name="columns" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title="重新扫描 Vault（Ctrl+Alt+R）"
          aria-label="重新扫描 Vault"
          onClick={() => void rescanVault()}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          title={`切换 Vault（当前：${info?.rootPath ?? '未打开'}）`}
          aria-label="切换 Vault"
          onClick={() => void openVaultInteractive()}
        >
          <Icon name="folderOpen" />
        </button>
      </div>
    </div>
  )
}

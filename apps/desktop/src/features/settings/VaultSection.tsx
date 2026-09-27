/**
 * 设置页 · Vault 分区：CSS 片段开关 + 索引与缓存。
 *
 * 这里的所有动作都走既有落点：片段开关改 `ui-store`（应用/卸载由 App 的 effect 统一负责）、
 * 重新扫描走 `@/app/actions` 的 `rescanVault`、刷新索引进度走 `links-store.refreshStatus`。
 * 组件自己不 invoke IPC（architecture.md §2 规则 5）。
 */

import { useState } from 'react'

import { rescanVault } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { Switch } from '@/components/Switch'
import { formatDuration } from '@/domain/format'
import type { IndexPhase } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useSettingsStore } from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const INDEX_PHASE_LABEL: Record<IndexPhase, string> = {
  idle: '空闲（尚未构建）',
  building: '构建中…',
  ready: '就绪',
  cancelled: '已取消',
  failed: '失败',
}

export function VaultSection() {
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)
  const setSnippetsEnabled = useUiStore((state) => state.setSnippetsEnabled)
  const frontmatterTimestamps = useSettingsStore((state) => state.frontmatterTimestamps)
  const setFrontmatterTimestamps = useSettingsStore((state) => state.setFrontmatterTimestamps)
  const info = useVaultStore((state) => state.info)
  const status = useLinksStore((state) => state.status)
  const [scanning, setScanning] = useState(false)

  const hasVault = info !== null
  const progressMax = status.total > 0 ? status.total : 1

  return (
    <>
      <h3 className="mn-settings__section-title">Vault</h3>
      <p className="mn-settings__section-hint">
        这些是当前 Vault 的运行时设置与缓存状态；Vault 本身仍是普通文件夹里的普通 Markdown 文件。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-snippets-title">
        <h4 className="mn-settings__group-title" id="mn-settings-snippets-title">
          <Icon name="palette" size="sm" />
          Vault CSS 片段
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">
              启用 <code className="mn-settings__path">.mimenote/snippets/*.css</code>
            </span>
            <span className="mn-settings__row-hint">
              {hasVault
                ? '用户样式片段只从你自己的 Vault 目录读取，不加载任何远程 CSS；停用会整体卸载'
                : '还没有打开 Vault'}
            </span>
          </span>
          <span className="mn-settings__row-control">
            {hasVault && (
              <span className="mn-settings__value">{snippetsEnabled ? '已启用' : '已停用'}</span>
            )}
            <Switch
              label="启用 Vault CSS 片段"
              checked={snippetsEnabled}
              disabled={!hasVault}
              onCheckedChange={(next) => {
                // 只改开关值：`App` 里已有 `useEffect(..., [rootPath, snippetsEnabled])`
                // 负责 applyVaultSnippets。这里再调一次会跟它抢着卸载/注入 <style>，
                // 于是"同一件事只有一条执行路径"被破坏（两条路径还会互相覆盖）。
                setSnippetsEnabled(next)
              }}
            />
          </span>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-timestamps-title">
        <h4 className="mn-settings__group-title" id="mn-settings-timestamps-title">
          <Icon name="save" size="sm" />
          时间戳保护
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">用 frontmatter 记录创建与修改时间</span>
            <span className="mn-settings__row-hint">
              同步盘/拷贝经常丢文件 mtime，而 frontmatter 跟着正文走 —— 新建时写入
              <code className="mn-settings__path">created</code> /{' '}
              <code className="mn-settings__path">updated</code>（UTC），每次保存刷新
              <code className="mn-settings__path">updated</code>；
              <code className="mn-settings__path">created</code> 只写一次、永不覆盖；
              没有 frontmatter 的旧笔记不擅自建块
            </span>
          </span>
          <span className="mn-settings__row-control">
            <Switch
              label="用 frontmatter 记录创建与修改时间"
              checked={frontmatterTimestamps}
              onCheckedChange={(next) => setFrontmatterTimestamps(next)}
            />
          </span>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-index-title">
        <h4 className="mn-settings__group-title" id="mn-settings-index-title">
          <Icon name="refresh" size="sm" />
          索引与缓存
        </h4>

        <dl className="mn-settings__facts">
          <dt>索引阶段</dt>
          <dd>{INDEX_PHASE_LABEL[status.phase]}</dd>
          <dt>已索引</dt>
          <dd className="mn-settings__mono">
            {status.indexed} / {status.total} 篇
          </dd>
          <dt>耗时</dt>
          <dd className="mn-settings__mono">{formatDuration(status.durationMs)}</dd>
          <dt>链接</dt>
          <dd className="mn-settings__mono">{status.links} 条</dd>
        </dl>

        {status.phase === 'building' && (
          <progress
            className="mn-settings__progress"
            aria-label="索引进度"
            value={status.indexed}
            max={progressMax}
          />
        )}

        <div className="mn-settings__actions">
          <button
            type="button"
            className="mn-button"
            aria-label="重新扫描 Vault"
            disabled={!hasVault || scanning}
            onClick={() => {
              setScanning(true)
              void rescanVault().finally(() => setScanning(false))
            }}
          >
            <Icon name="refresh" size="xs" />
            {scanning ? '扫描中…' : '重新扫描 Vault'}
          </button>
          <button
            type="button"
            className="mn-button"
            aria-label="刷新索引状态"
            disabled={!hasVault}
            onClick={() => {
              void useLinksStore.getState().refreshStatus()
            }}
          >
            <Icon name="info" size="xs" />
            刷新索引状态
          </button>
        </div>

        <p className="mn-settings__note">
          索引是可重建的缓存：全文搜索的倒排索引在{' '}
          <code className="mn-settings__path">&lt;Vault&gt;/.mimenote/cache/search.db</code>
          ，删掉它下次打开 Vault 会自动重建。当前每次打开 Vault 都会重建一次（跨会话增量索引属于 M5）。
        </p>
      </section>
    </>
  )
}

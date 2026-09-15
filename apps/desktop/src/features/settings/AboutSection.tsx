/** 设置页 · 关于分区：版本、当前 Vault 统计、日志文件位置。 */

import { Icon } from '@/components/Icon'
import { formatDuration } from '@/domain/format'
import { currentAdapterKind } from '@/ipc/client'
import { describeError } from '@/ipc/types'
import { useSettingsStore } from '@/state/settings-store'
import { useVaultStore } from '@/state/vault-store'

/**
 * 日志文件位置（README「常见问题」里给出的是同一个路径）。
 *
 * 直接展示文案而不是让用户点按钮打开：宿主没有"打开目录"的能力声明
 * （`capabilities/default.json` 只放开 `core:default` + `dialog:allow-open`），
 * 加一个 shell 打开能力会在安全模型上多开一个口子，不值当。
 */
const LOG_PATH = '%LOCALAPPDATA%\\app.mimenote.desktop\\logs\\mimenote.log'

export function AboutSection() {
  const info = useVaultStore((state) => state.info)
  const versionInfo = useSettingsStore((state) => state.versionInfo)
  const versionError = useSettingsStore((state) => state.versionError)
  const loadVersionInfo = useSettingsStore((state) => state.loadVersionInfo)

  return (
    <>
      <h3 className="mn-settings__section-title">关于</h3>
      <p className="mn-settings__section-hint">
        Mimenote 是本地优先的 Markdown 知识库：默认离线，无遥测、无出站请求。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-version-title">
        <h4 className="mn-settings__group-title" id="mn-settings-version-title">
          <Icon name="info" size="sm" />
          版本
        </h4>
        {versionInfo === null ? (
          <p className="mn-settings__note mn-settings__note--warn">
            {versionError === null ? '正在读取版本信息…' : describeError(versionError, '读取版本信息失败')}
          </p>
        ) : (
          <dl className="mn-settings__facts">
            <dt>Mimenote</dt>
            <dd className="mn-settings__mono">{versionInfo.app}</dd>
            <dt>mn-core</dt>
            <dd className="mn-settings__mono">{versionInfo.core}</dd>
            <dt>Tauri</dt>
            <dd className="mn-settings__mono">{versionInfo.tauri}</dd>
            <dt>IPC 适配器</dt>
            <dd className="mn-settings__mono">{currentAdapterKind() ?? '未初始化'}</dd>
          </dl>
        )}
        <div className="mn-settings__actions">
          <button
            type="button"
            className="mn-button"
            aria-label="重新读取版本信息"
            onClick={() => {
              void loadVersionInfo()
            }}
          >
            <Icon name="refresh" size="xs" />
            重新读取
          </button>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-vault-stat-title">
        <h4 className="mn-settings__group-title" id="mn-settings-vault-stat-title">
          <Icon name="folder" size="sm" />
          当前 Vault
        </h4>
        {info === null ? (
          <p className="mn-settings__note">还没有打开 Vault</p>
        ) : (
          <dl className="mn-settings__facts">
            <dt>名称</dt>
            <dd>{info.name}</dd>
            <dt>根路径</dt>
            <dd className="mn-settings__mono">{info.rootPath}</dd>
            <dt>条目 / 笔记</dt>
            <dd className="mn-settings__mono">
              {info.entryCount} 条目 · {info.noteCount} 篇笔记 · {info.folderCount} 个目录
            </dd>
            <dt>扫描耗时</dt>
            <dd className="mn-settings__mono">{formatDuration(info.scanMs)}</dd>
            {(info.truncated || info.skipped > 0) && (
              <>
                <dt>注意</dt>
                <dd className="mn-settings__note mn-settings__note--warn">
                  {info.truncated ? '条目数超过上限，只显示了一部分' : ''}
                  {info.truncated && info.skipped > 0 ? '；' : ''}
                  {info.skipped > 0 ? `${info.skipped} 个条目被跳过（权限或符号链接）` : ''}
                </dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-log-title">
        <h4 className="mn-settings__group-title" id="mn-settings-log-title">
          <Icon name="file" size="sm" />
          日志文件位置
        </h4>
        <p className="mn-settings__note">
          运行日志写在 <code className="mn-settings__path">{LOG_PATH}</code>
          （单文件超过 2MB 会自动重建）。排查启动问题看其中的「IPC 握手成功」一行：它同时证明
          WebView 渲染、前端 JS 执行与 IPC 通道都正常。
        </p>
      </section>
    </>
  )
}

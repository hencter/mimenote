/**
 * 设置页 · 配置分区（ADR-0055）：当前生效的配置文件、它的状态与问题。
 *
 * 这一页**不提供配置编辑器**：配置文件是给人手写的（TOML / YAML / JSON 三选一），
 * 应用只负责"写回自己那份"。所以这里要做的是把三件事说清楚：
 * 1. 现在生效的到底是哪一个文件（四个候选名里命中的那个）；
 * 2. 它能不能被改写（含注释 / 版本更新 → 只读，原因原样列出）；
 * 3. 它有没有问题（解析失败、字段类型不对），**逐条原样展示**，不吞。
 */

import { useState } from 'react'

import { Icon } from '@/components/Icon'
import { CONFIG_DIR, CONFIG_FILE_CANDIDATES } from '@/domain/config-file'
import { useSettingsStore } from '@/state/settings-store'

export function ConfigSection() {
  const configPath = useSettingsStore((state) => state.configPath)
  const configFormat = useSettingsStore((state) => state.configFormat)
  const configRootPath = useSettingsStore((state) => state.configRootPath)
  const configWritable = useSettingsStore((state) => state.configWritable)
  const configIssues = useSettingsStore((state) => state.configIssues)
  const reloadConfig = useSettingsStore((state) => state.reloadConfig)
  const writeConfigNow = useSettingsStore((state) => state.writeConfigNow)

  const [busy, setBusy] = useState<'reload' | 'write' | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const run = async (kind: 'reload' | 'write'): Promise<void> => {
    setBusy(kind)
    setDone(null)
    try {
      if (kind === 'reload') {
        await reloadConfig()
        setDone('已重新读取配置文件。')
      } else {
        await writeConfigNow()
        setDone('已写盘。')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h3 className="mn-settings__section-title">配置</h3>
      <p className="mn-settings__section-hint">
        偏好值写在 Vault 内的 <code className="mn-settings__path">{CONFIG_DIR}/config.*</code> 里
        —— 换 Vault 就换一套偏好，而且它能被 git 管理。三种格式同构：TOML、YAML、JSON 任选其一。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-config-current">
        <h4 className="mn-settings__group-title" id="mn-settings-config-current">
          <Icon name="fileCode" size="sm" />
          当前生效
        </h4>

        <dl className="mn-settings__facts">
          <dt>Vault</dt>
          <dd className="mn-settings__mono">{configRootPath ?? '（还没有打开 Vault）'}</dd>
          <dt>配置文件</dt>
          <dd className="mn-settings__mono">{configPath ?? '（还没有 — 保存任一偏好时会自动创建）'}</dd>
          <dt>格式</dt>
          <dd>{configFormat ?? '—'}</dd>
          <dt>可写</dt>
          <dd>
            {configRootPath === null
              ? '—（未打开 Vault）'
              : configWritable
                ? '是'
                : '否（只读：见下面的原因）'}
          </dd>
        </dl>

        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">重新读取 / 立刻写盘</span>
            <span className="mn-settings__row-hint">
              在外部编辑过配置文件之后用「重新读取」；应用内的改动会自动合并写盘（300ms 防抖），
              「立刻写盘」只是不等那个窗口
            </span>
          </span>
          <span className="mn-settings__row-control">
            <button
              type="button"
              className="mn-button mn-button--ghost"
              disabled={busy !== null || configRootPath === null}
              onClick={() => void run('reload')}
            >
              {busy === 'reload' ? '读取中…' : '重新读取'}
            </button>
            <button
              type="button"
              className="mn-button mn-button--ghost"
              disabled={busy !== null || !configWritable || configRootPath === null}
              onClick={() => void run('write')}
            >
              {busy === 'write' ? '写入中…' : '立刻写盘'}
            </button>
          </span>
        </div>

        {done !== null && <p className="mn-settings__note" role="status">{done}</p>}
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-config-issues">
        <h4 className="mn-settings__group-title" id="mn-settings-config-issues">
          <Icon name="alert" size="sm" />
          问题
        </h4>
        {configIssues.length === 0 ? (
          <p className="mn-settings__note">没有问题。</p>
        ) : (
          <ul className="mn-settings__issues">
            {configIssues.map((issue) => (
              <li key={issue} className="mn-settings__note mn-settings__note--warn">
                {issue}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-config-rules">
        <h4 className="mn-settings__group-title" id="mn-settings-config-rules">
          <Icon name="info" size="sm" />
          规则
        </h4>
        <p className="mn-settings__note">
          按顺序找**第一个存在**的文件：
          {CONFIG_FILE_CANDIDATES.map((candidate, index) => (
            <span key={candidate.fileName}>
              {index === 0 ? ' ' : ' → '}
              <code className="mn-settings__path">{candidate.fileName}</code>
            </span>
          ))}
          。写入时只写规范名（YAML 写 <code className="mn-settings__path">config.yaml</code>，
          不产生 <code className="mn-settings__path">config.yml</code>）。
        </p>
        <p className="mn-settings__note">
          应用写出的文件**不带注释**，因此它可以被反复改写；一旦你手工加了注释，应用就不再动它
          （TOML/YAML 的序列化都会吃掉注释），此时请直接在源码里编辑 —— 这条纪律与 frontmatter 一致。
        </p>
      </section>
    </>
  )
}

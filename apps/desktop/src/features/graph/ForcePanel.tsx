/**
 * 「力度管理」面板（ADR-0023）：把力导向的每一个旋钮都摆出来，边看边拧。
 *
 * 为什么要有它（而不是只留 HUD 上那排预设）：预设解决的是"一键换手感"，而用户的下一句话
 * 往往是"再松一点""让有关的卡片靠得更紧""别让卡片叠在一起" —— 那些都要**逐项**调。
 * 面板上每一项都写清"往两边拧分别会发生什么"，因为力导向的参数名（斥力、阻尼、衰减）
 * 对没写过物理模拟的人是没有意义的。
 *
 * 为什么不是 floating 面板（复用 `FloatingNote` 那套拖拽）：面板要贴着 HUD 看参数，
 * 拖走了反而更难对照；而且它的内容与 HUD 同源（都读同一个 store），没有"拎出来读"的需求。
 * 它也不需要持久化（打开状态是瞬时的）。
 */

import type { JSX } from 'react'

import { Icon } from '@/components/Icon'
import {
  FORCE_HOP_OPTIONS,
  FORCE_PARAM_RANGES,
  FORCE_SLIDER_KEYS,
  formatForceParam,
  useGraphStore,
} from '@/state/graph-store'
import { FORCE_PRESETS, forcePreset } from './force-presets'
import './force-panel.css'

/** 当前参数是不是就等于某个预设那一套（是的话界面显示预设名，否则显示"自定义"）。 */
function matchesPreset(params: unknown, presetId: string): boolean {
  const preset = forcePreset(presetId).params as unknown as Record<string, number>
  const current = params as unknown as Record<string, number>
  for (const key of Object.keys(preset)) {
    if (current[key] !== preset[key]) return false
  }
  return true
}

export function ForcePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const forceParams = useGraphStore((state) => state.forceParams)
  const forcePresetId = useGraphStore((state) => state.forcePreset)
  const setForcePreset = useGraphStore((state) => state.setForcePreset)
  const setForceParam = useGraphStore((state) => state.setForceParam)
  const resetForceParams = useGraphStore((state) => state.resetForceParams)

  const values = forceParams as unknown as Record<string, number>
  const custom = !matchesPreset(forceParams, forcePresetId)

  return (
    <div
      className="mn-force"
      data-mn-graph-nopan
      role="group"
      aria-label="力度管理"
      data-force-custom={custom ? 'true' : 'false'}
    >
      <div className="mn-force__head">
        <span className="mn-force__title">
          <Icon name="settings" size="xs" />
          力度管理
        </span>
        <span className="mn-force__badge" data-force-current>
          {custom ? `自定义（基于${forcePreset(forcePresetId).label}）` : forcePreset(forcePresetId).label}
        </span>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="关闭力度管理"
          onClick={onClose}
        >
          <Icon name="x" size="xs" />
        </button>
      </div>

      <div className="mn-force__presets" role="group" aria-label="力度预设">
        {FORCE_PRESETS.map((preset) => {
          const active = !custom && preset.id === forcePresetId
          return (
            <button
              key={preset.id}
              type="button"
              className={`mn-graph__chip${active ? ' mn-graph__chip--active' : ''}`}
              aria-pressed={active}
              data-force-preset={preset.id}
              title={preset.hint}
              onClick={() => setForcePreset(preset.id)}
            >
              {preset.label}
            </button>
          )
        })}
      </div>

      <div className="mn-force__rows">
        {FORCE_SLIDER_KEYS.map((key) => {
          const range = FORCE_PARAM_RANGES[key]
          if (range === undefined) return null
          const value = values[key] ?? range.min
          return (
            <label className="mn-force__row" key={key} title={range.hint}>
              <span className="mn-force__label">{range.label}</span>
              <input
                className="mn-force__slider"
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={value}
                aria-label={range.label}
                data-force-param={key}
                onChange={(event) => setForceParam(key, Number(event.target.value))}
              />
              <span className="mn-force__value" data-force-value={key}>
                {formatForceParam(key, value)}
              </span>
            </label>
          )
        })}

        <label className="mn-force__row" title="只对几跳以内的边施加弹簧力：调小只让『直接相关』的卡片互相靠近">
          <span className="mn-force__label">弹簧范围</span>
          <select
            className="mn-force__select"
            aria-label="弹簧范围"
            value={String(values['linkMaxHop'] ?? Number.POSITIVE_INFINITY)}
            onChange={(event) => setForceParam('linkMaxHop', Number(event.target.value))}
          >
            {FORCE_HOP_OPTIONS.map((option) => (
              <option key={String(option)} value={String(option)}>
                {Number.isFinite(option) ? `${option} 跳以内` : '全部'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mn-force__actions">
        <button
          type="button"
          className="mn-graph__chip"
          data-force-action="reset"
          title="把上面每一项都恢复成当前预设的那一套"
          onClick={() => resetForceParams()}
        >
          恢复预设
        </button>
        <span className="mn-force__hint">
          碰撞强度为 1 时，<strong>落定之后卡片不会重叠</strong>
        </span>
      </div>
    </div>
  )
}

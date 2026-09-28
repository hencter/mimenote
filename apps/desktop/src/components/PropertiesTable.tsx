/**
 * frontmatter 属性表（Obsidian 式：类型图标 + 键 + 类型化值）。
 *
 * 两处共用同一份观感：标签面板的"属性"区与阅读视图正文顶部的属性块 ——
 * "同一份数据在两个地方长得不一样"是最廉价的困惑，所以判据（类型 → 图标）与
 * 值渲染只有这一份。编辑是下一批（需要新的写命令，见 ADR-0045 的后续），
 * 本批只读：值是纯展示，标签 pills 不可点。
 *
 * 类型推断学 Obsidian：先看**键名**（date/datetime/tags/created/updated…），
 * 再看值形状（bool/number/list/null）。键名匹配大小写不敏感。
 */

import type { FrontmatterField, FrontmatterValue } from '@/ipc/types'

import { frontmatterValueText, isFrontmatterEmpty } from '@/domain/frontmatter'
import { Icon, type IconName } from './Icon'
import './properties.css'

/** 按键名推断的固定类型（Obsidian 对这几个名字有特殊输入框，这里先对齐图标）。 */
function iconForKey(key: string): IconName | null {
  const lower = key.toLowerCase()
  if (lower === 'date') return 'calendar'
  if (
    lower === 'datetime' ||
    lower === 'time' ||
    lower === 'created' ||
    lower === 'updated' ||
    lower === 'created_at' ||
    lower === 'updated_at'
  ) {
    return 'clock'
  }
  if (lower === 'tags' || lower === 'tag') return 'tag'
  return null
}

/** 字段的类型图标（键名优先，其次值形状）。纯函数，测试直接断它。 */
export function propertyIconFor(key: string, value: FrontmatterValue): IconName {
  const byKey = iconForKey(key)
  if (byKey !== null) return byKey
  switch (value.kind) {
    case 'bool':
      return 'check'
    case 'number':
      return 'hash'
    case 'list':
    case 'map':
    case 'mapList':
      return 'list'
    default:
      return 'type'
  }
}

/** 标签值渲染成 pills（只读展示，不可点 —— 点标签去标签面板，那里才是入口）。 */
function TagsValue({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <span className="mn-props__empty">空</span>
  return (
    <span className="mn-props__pills">
      {items.map((tag) => (
        <span key={tag} className="mn-props__pill">
          {tag}
        </span>
      ))}
    </span>
  )
}

/** 一级映射的子行（`k: v` 各占一行，键等宽、值正文 —— OKF 的 generated 这类）。 */
function MapValue({ fields }: { fields: readonly FrontmatterField[] }) {
  if (fields.length === 0) return <span className="mn-props__empty">空</span>
  return (
    <span className="mn-props__map">
      {fields.map((field) => (
        <span key={`${field.key}-${field.line}`} className="mn-props__map-row">
          <span className="mn-props__map-key">{field.key}</span>
          <span className="mn-props__map-value">{frontmatterValueText(field.value)}</span>
        </span>
      ))}
    </span>
  )
}

/** 映射列表（OKF 的 verified/sources 这类：一组一组的子字段）。 */
function MapListValue({ items }: { items: readonly (readonly FrontmatterField[])[] }) {
  if (items.length === 0) return <span className="mn-props__empty">空</span>
  return (
    <span className="mn-props__maplist">
      {items.map((fields, index) => (
        // 同组子字段没有稳定 id：序号即身份（组内顺序是解析顺序，不会重排）
        <span key={index} className="mn-props__maplist-item">
          <MapValue fields={fields} />
        </span>
      ))}
    </span>
  )
}

function FieldValue({ field }: { field: FrontmatterField }) {
  const { key, value } = field
  if (isFrontmatterEmpty(value)) return <span className="mn-props__empty">空</span>
  const lower = key.toLowerCase()
  if ((lower === 'tags' || lower === 'tag') && value.kind === 'list') {
    return <TagsValue items={value.value} />
  }
  if (value.kind === 'bool') {
    return <span className="mn-props__bool">{value.value ? '✓' : '—'}</span>
  }
  if (value.kind === 'map') {
    return <MapValue fields={value.value} />
  }
  if (value.kind === 'mapList') {
    return <MapListValue items={value.value} />
  }
  return <span className="mn-props__text">{frontmatterValueText(value)}</span>
}

export interface PropertiesTableProps {
  /** 保序字段（`note_tags` 的 `frontmatter` 原样传入）。 */
  fields: readonly FrontmatterField[]
  /** `panel`（侧栏，紧凑）/`note`（正文顶部，宽松）。 */
  density?: 'panel' | 'note'
}

export function PropertiesTable({ fields, density = 'panel' }: PropertiesTableProps) {
  if (fields.length === 0) return null
  return (
    <dl className={`mn-props mn-props--${density}`}>
      {fields.map((field) => (
        <div
          className="mn-props__row"
          key={`${field.key}-${field.line}`}
          data-prop-key={field.key}
        >
          <dt className="mn-props__key">
            <Icon name={propertyIconFor(field.key, field.value)} size="xs" />
            <span className="mn-props__key-text">{field.key}</span>
          </dt>
          <dd className="mn-props__value">
            <FieldValue field={field} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

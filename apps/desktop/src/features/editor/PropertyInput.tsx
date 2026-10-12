import { useId, useState } from 'react'
import { PropertySelect } from './PropertySelect'
import { type IconName } from '@/components/Icon'
import { Select } from '@/components/Select'
import { loadJson, saveJson } from '@/state/persist'
import { useVaultStore } from '@/state/vault-store'

export const PROPERTY_TYPES = { text: '文本', number: '数字', boolean: '复选框', single: '单选', date: '日期', datetime: '日期时间', tags: '标签', list: '列表', url: '链接', email: '邮箱', object: 'JSON 对象' } as const
type PropertyType = keyof typeof PROPERTY_TYPES
const ICONS: Record<PropertyType, IconName> = { text: 'type', number: 'hash', boolean: 'check', single: 'dot', date: 'calendar', datetime: 'clock', tags: 'tag', list: 'list', url: 'links', email: 'type', object: 'columns' }
function infer(name: string, value: unknown): PropertyType {
  if (/^tags?$/i.test(name)) return 'tags'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'list'
  if (value instanceof Date) return 'datetime'
  if (value !== null && typeof value === 'object') return 'object'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return 'datetime'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date'
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return 'url'
  return 'text'
}
export function PropertyInput({ name, value, change, remove, reorder, rename }: { name: string; value: unknown; change: (value: unknown) => void; remove: () => void; reorder?: (from: string, before: string) => void; rename?: (name: string) => boolean }) {
  const id = useId()
  const root = useVaultStore((state) => state.info?.rootPath ?? '')
  const configKey = `mimenote.property.config.v1:${JSON.stringify([root, name])}`
  const [config, setConfig] = useState(() => loadJson<{ type: PropertyType; options: string[] }>(configKey, { type: infer(name, value), options: value == null || value === '' ? [] : [String(value)] }, (v): v is { type: PropertyType; options: string[] } => {
    if (!v || typeof v !== 'object') return false
    const c = v as { type?: unknown; options?: unknown }
    return typeof c.type === 'string' && Object.hasOwn(PROPERTY_TYPES, c.type) && Array.isArray(c.options) && c.options.every((o) => typeof o === 'string')
  }))
  const type = config.type
  const updateConfig = (next: typeof config) => { setConfig(next); saveJson(configKey, next) }
  const [addition, setAddition] = useState('')
  const [error, setError] = useState('')
  const items = Array.isArray(value) ? value.map(String) : value == null || value === '' ? [] : [String(value)]
  const primitive = value == null ? '' : value instanceof Date ? value.toISOString().replace(/Z$/, '') : String(value)
  const dateValue = primitive.replace(' ', 'T').replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '')
  const displayed = type === 'datetime' ? dateValue : primitive
  return <div className="mn-metadata__row" onDragOver={(e) => {
    if (reorder && Array.from(e.dataTransfer.types).includes('application/x-mimenote-property')) { e.preventDefault(); e.stopPropagation(); e.currentTarget.dataset.drop = 'true' }
  }} onDragLeave={(e) => { delete e.currentTarget.dataset.drop }} onDrop={(e) => {
    const from = e.dataTransfer.getData('application/x-mimenote-property')
    delete e.currentTarget.dataset.drop
    if (from && reorder) { e.preventDefault(); e.stopPropagation(); reorder(from, name) }
  }}>
    <div className="mn-metadata__type" draggable={!!reorder} title="点击修改类型，拖拽调整顺序" onDragStart={(e) => {
      e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-mimenote-property', name)
    }}><Select label={`${name} 的属性类型`} value={type} icon={ICONS[type]}
      options={Object.entries(PROPERTY_TYPES).map(([value, label]) => ({ value, label }))}
      onChange={(next) => {
        updateConfig({ ...config, type: next as PropertyType }); setError('')
      }} /></div>
    <div className="mn-metadata__key"><label hidden htmlFor={id}>{name}</label><input aria-label={`${name} 的属性名`} title={name} defaultValue={name} readOnly={!rename} onBlur={(e) => {
      if (rename && e.target.value !== name) {
        const next = e.target.value.trim()
        if (rename(next)) saveJson(`mimenote.property.config.v1:${JSON.stringify([root, next])}`, config)
        else e.target.value = name
      }
    }} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      if (e.key === 'Escape') { e.currentTarget.value = name; e.currentTarget.blur() }
    }} /></div>
    <div className="mn-metadata__value">
      {type === 'single' ? <PropertySelect name={name} value={primitive} change={change} /> : type === 'boolean' ? <input id={id} type="checkbox" checked={value === true || value === 'true'} onChange={(e) => change(e.target.checked)} /> :
        type === 'tags' || type === 'list' ? <div className="mn-metadata__chips">
          {items.map((item, i) => <span className="mn-metadata__chip" key={`${item}-${i}`}>{type === 'list' && <span className="mn-metadata__index" aria-label={`第 ${i + 1} 项`}>{i + 1}.</span>}{item}<button type="button" aria-label={`移除 ${name} 中的 ${item}`} onClick={() => change(items.filter((_, j) => j !== i))}>×</button></span>)}
          <input id={id} aria-label={`添加 ${name} 条目`} placeholder="输入后回车…" value={addition} onChange={(e) => setAddition(e.target.value)} onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Backspace' && addition === '' && items.length > 0) {
              e.preventDefault(); e.stopPropagation(); change(items.slice(0, -1))
            } else if (e.key === 'Enter') {
              e.preventDefault(); if (addition.trim()) change([...items, addition.trim()]); setAddition('')
            }
          }} />
        </div> : type === 'object' ? <textarea id={id} key={JSON.stringify(value)} defaultValue={JSON.stringify(value, null, 2)} onBlur={(e) => { try { change(JSON.parse(e.target.value)); setError('') } catch { setError('请输入有效 JSON') } }} /> :
          <input id={id} key={`${type}-${primitive}`} type={type === 'datetime' ? 'datetime-local' : type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'url' ? 'url' : type === 'email' ? 'email' : 'text'} step={type === 'number' ? 'any' : type === 'datetime' ? '1' : undefined} defaultValue={displayed} onBlur={(e) => {
            if (!e.currentTarget.checkValidity()) { setError('请检查字段格式'); return }
            // 浏览器会把 :00 秒归一化掉；未修改时保留原始时区与精度。
            if (type === 'datetime' && e.target.value.replace(/:00$/, '') === displayed.replace(/:00$/, '')) return
            const zone = primitive.match(/(?:Z|[+-]\d{2}:?\d{2})$/)?.[0] ?? ''
            const next = type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : type === 'datetime' && e.target.value ? e.target.value + zone : e.target.value
            if (next !== value) change(next)
            setError('')
          }} />}
      {error && <small role="alert">{error}</small>}
    </div>
    <button type="button" aria-label={`移除属性 ${name}`} onClick={remove}>×</button>
  </div>
}

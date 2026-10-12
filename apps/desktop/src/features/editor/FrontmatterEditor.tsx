import { useEffect, useState } from 'react'
import { editMetadataField, metadataBlock, parseMetadata, renameMetadata, reorderMetadata, replaceMetadata, serializeMetadata, tomlHasComment, type MetadataFormat } from '@/domain/frontmatter-edit'
import './frontmatter-editor.css'
import { PropertyInput } from './PropertyInput'
import { Select } from '@/components/Select'

export function FrontmatterEditor({ read, apply, onSourceMode }: { read: () => string; apply: (text: string) => void; onSourceMode: (raw: boolean) => void }) {
  const initial = metadataBlock(read())
  const [open, setOpen] = useState(() => initial !== null)
  const [source, setSource] = useState(() => initial?.source ?? '')
  const [format, setFormat] = useState<MetadataFormat>(() => initial?.format ?? 'yaml')
  const [raw, setRaw] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftValue, setDraftValue] = useState('')
  useEffect(() => { if (!raw) { setSource(initial?.source ?? ''); setFormat(initial?.format ?? 'yaml') } }, [initial?.source, initial?.format, raw])
  let data: Record<string, unknown> = {}
  let parseError = ''
  try { data = parseMetadata(source, format) } catch (cause) { parseError = String(cause) }
  const change = (name: string, value: unknown, remove = false) => {
    try {
      const text = read()
      const block = metadataBlock(text)
      const next = editMetadataField(block?.source ?? '', block?.format ?? format, name, value, remove)
      apply(replaceMetadata(text, next, block?.format ?? format))
      setSource(next); setError(''); return true
    } catch (cause) { setError(String(cause)); return false }
  }
  return <div className="mn-metadata">
    <button type="button" className="mn-metadata__toggle" aria-expanded={open} onClick={() => {
      if (!open) {
        const text = read(); const block = metadataBlock(text)
        setSource(block?.source ?? ''); setFormat(block?.format ?? 'yaml'); setError('')
      }
      setOpen(!open)
    }}>笔记属性 {open ? '⌃' : '⌄'}</button>
    {(open || raw) && <div className="mn-metadata__panel">
      <header><Select label="Frontmatter 格式" value={format} options={[{value:'yaml',label:'YAML'},{value:'toml',label:'TOML'},{value:'json',label:'JSON'}]} onChange={(value) => {
        const next = value as MetadataFormat
        try {
          const text = read(); const block = metadataBlock(text)
          if (block && tomlHasComment(block.source)) throw new Error('格式转换可能丢失注释，请先在源码中处理注释。')
          const converted = serializeMetadata(parseMetadata(block?.source ?? '', block?.format ?? format), next)
          apply(replaceMetadata(text, converted, next)); setSource(converted); setFormat(next); setError('')
        } catch (cause) { setError(String(cause)) }
      }} />
        <button type="button" aria-pressed={raw} onClick={() => {
          if (raw) { const block = metadataBlock(read()); setSource(block?.source ?? ''); setFormat(block?.format ?? 'yaml') }
          setRaw(!raw); onSourceMode(!raw)
        }}>{raw ? '显示属性' : '编辑源码'}</button>
      </header>
      {!raw && !parseError && <div className="mn-metadata__fields">
        {Object.entries(data).map(([name, value]) => <PropertyInput key={name} name={name} value={value} change={(value) => change(name, value)} remove={() => change(name, null, true)} rename={(nextName) => {
          try {
            const text = read(); const block = metadataBlock(text)
            if (!block) return false
            const next = renameMetadata(block.source, block.format, name, nextName)
            apply(replaceMetadata(text, next, block.format)); setSource(next); setError(''); return true
          } catch (cause) { setError(String(cause)); return false }
        }} reorder={(from, before) => {
          try {
            const text = read(); const block = metadataBlock(text)
            if (!block) return
            const next = reorderMetadata(block.source, block.format, from, before)
            apply(replaceMetadata(text, next, block.format)); setSource(next); setError('')
          } catch (cause) { setError(String(cause)) }
        }} />)}
        {adding && <div className="mn-metadata__row mn-metadata__draft">
          <span aria-hidden="true">T</span>
          <input autoFocus aria-label="新属性名称" placeholder="属性名称" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => {
            if (!key.trim()) return
            if (Object.hasOwn(data, key.trim())) { setError('属性名称已存在'); return }
            if (change(key.trim(), draftValue)) { setAdding(false); setKey(''); setDraftValue('') }
          }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur(); if (e.key === 'Escape') setAdding(false) }} />
          <input aria-label="新属性值" placeholder="值" value={draftValue} onChange={(e) => setDraftValue(e.target.value)} />
          <button type="button" aria-label="取消添加属性" onClick={() => setAdding(false)}>×</button>
        </div>}
        <button type="button" aria-label="添加笔记属性" className="mn-metadata__add-trigger" onClick={() => { setAdding(true); setKey(''); setDraftValue('') }}>＋ 添加笔记属性</button>
      </div>}
      {(error || parseError) && <p role="alert">{error || parseError}</p>}
    </div>}
  </div>
}

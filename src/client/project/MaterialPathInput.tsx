/** Workspace file completion using the Host menu primitive. */
import { forwardRef, useEffect, useState, type InputHTMLAttributes } from 'react'
import { Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchInjected } from '../workbench-types.ts'
import type { ProjectResult } from '../../shared/project.ts'
import css from '../styles/Workbench.module.css'
import { FileLookupVersionError } from './file-lookup.ts'

/** @param props - Controlled relative path and workspace-bound file lookup. @returns An input with an @ directory menu. */
export const MaterialPathInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string; onChange: (value: string) => void; listFiles: WorkbenchInjected['listFiles']; extension: RegExp
  emptyLabel: string; failedLabel: string; versionLabel: string; loadingLabel: string
}>(function MaterialPathInput({ value, onChange, listFiles, extension, emptyLabel, failedLabel, versionLabel, loadingLabel, ...input }, ref) {
  const [items, setItems] = useState<NonNullable<ProjectResult['files']>>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'incompatible'>('loading')
  const [dismissed, setDismissed] = useState(false)
  const open = value.startsWith('@') && !dismissed && !input.disabled
  useEffect(() => {
    if (!open) return
    let live = true
    setState('loading'); setItems([])
    if (!listFiles) { setState('error'); return }
    void listFiles(value.slice(1)).then(result => {
      if (live) { setItems(result); setState('ready') }
    }, (error: unknown) => { if (live) setState(error instanceof FileLookupVersionError ? 'incompatible' : 'error') })
    return () => { live = false }
  }, [value, open, listFiles])
  const visible = items.filter(item => item.directory || extension.test(item.path))
  const pick = (path: string) => {
    const item = visible.find(candidate => candidate.path === path)
    if (!item) return
    onChange(item.directory ? `@${item.path}/` : item.path)
  }
  return <Menu open={open} portal minWidthFromAnchor className={css.pathPicker}
    onClose={() => setDismissed(true)} onSelect={pick}
    items={state === 'ready' && visible.length ? visible.map(item => ({ id: item.path, label: `${item.path}${item.directory ? '/' : ''}` }))
      : [{ id: 'status', label: state === 'loading' ? loadingLabel : state === 'incompatible' ? versionLabel : state === 'error' ? failedLabel : emptyLabel, disabled: true }]}
    anchor={<Input {...input} ref={ref} value={value} aria-haspopup="menu" aria-expanded={open}
      onChange={event => { setDismissed(false); onChange(event.target.value) }}
      onKeyDown={event => {
        if (open && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (state === 'ready' && visible[0]) pick(visible[0].path) }
        if (open && event.key === 'Escape') { event.preventDefault(); setDismissed(true) }
      }} />}
  />
})

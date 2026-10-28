/** Material references are validated locally before the Host checks file access and identity. */
import { memo, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectProblem } from '../../shared/project.ts'
import type { View } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'

type Fields = Pick<View, 'original' | 'markdown' | 'version' | 'sameVersion'>
type Field = keyof Fields
type ErrorKey = 'originalRequired' | 'markdownRequired' | 'versionRequired' | 'sameVersionRequired' | 'materialAccess'
const relativePath = (path: string): boolean => !/^(?:[\\/]|[a-z]:)/i.test(path) && !path.split(/[\\/]/).some(p => !p || p === '.' || p === '..')

/** @param props - Existing view fields and commands; validation does not rewrite their values. @returns Accessible initialization form. */
export const MaterialsForm = memo(function MaterialsForm({ t, fields, change, initialize, unavailable, loading, problem }: {
  t: TranslateNS<'sidebarWorkbench'>; fields: Fields; change: (patch: Partial<Fields>) => void
  initialize: () => void; unavailable: boolean; loading: boolean; problem: ProjectProblem | undefined
}) {
  const uid = useId()
  const original = useRef<HTMLInputElement>(null)
  const markdown = useRef<HTMLInputElement>(null)
  const version = useRef<HTMLInputElement>(null)
  const sameVersion = useRef<HTMLInputElement>(null)
  const refs = { original, markdown, version, sameVersion }
  const [errors, setErrors] = useState<Partial<Record<Field, ErrorKey>>>({})
  const submitted = useRef(false)
  const pending = useRef(false)
  useEffect(() => {
    if (!submitted.current) return
    if (loading) { pending.current = true; return }
    if (!pending.current) return
    submitted.current = false; pending.current = false
    if (problem === 'materials' || problem === 'escape') {
      setErrors({ original: 'materialAccess', markdown: 'materialAccess' })
      original.current?.focus()
    }
  }, [loading, problem])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (unavailable || loading) return
    const next: Partial<Record<Field, ErrorKey>> = {}
    if (!relativePath(fields.original) || !/\.(pdf|docx)$/i.test(fields.original)) next.original = 'originalRequired'
    if (!relativePath(fields.markdown) || !/\.md$/i.test(fields.markdown)) next.markdown = 'markdownRequired'
    if (!fields.version.trim()) next.version = 'versionRequired'
    if (!fields.sameVersion) next.sameVersion = 'sameVersionRequired'
    setErrors(next)
    const first = (['original', 'markdown', 'version', 'sameVersion'] as const).find(key => next[key])
    if (first) { refs[first].current?.focus(); return }
    submitted.current = true
    initialize()
  }
  const edit = (field: Field, patch: Partial<Fields>) => {
    setErrors(current => { const next = { ...current }; delete next[field]; return next })
    change(patch)
  }
  const hint = (field: Field) => errors[field] && <span id={`${uid}-${field}-error`} className={css.fieldError}>{t(errors[field])}</span>
  const a11y = (field: Field) => ({ 'aria-invalid': !!errors[field], 'aria-describedby': errors[field] ? `${uid}-${field}-error` : undefined })
  return <form noValidate onSubmit={submit} aria-busy={loading}>
    <label>{t('original')}<Input ref={original} className={css.field} {...a11y('original')} value={fields.original} onChange={e => edit('original', { original: e.target.value })} />{hint('original')}</label>
    <label>{t('markdown')}<Input ref={markdown} className={css.field} {...a11y('markdown')} value={fields.markdown} onChange={e => edit('markdown', { markdown: e.target.value })} />{hint('markdown')}</label>
    <label>{t('version')}<Input ref={version} className={css.field} {...a11y('version')} value={fields.version} onChange={e => edit('version', { version: e.target.value })} />{hint('version')}</label>
    <label className={css.row}><input ref={sameVersion} type="checkbox" {...a11y('sameVersion')} checked={fields.sameVersion} onChange={e => edit('sameVersion', { sameVersion: e.target.checked })} />{t('sameVersion')}{hint('sameVersion')}</label>
    <Button type="submit" className={css.primaryButton} variant="primary" disabled={unavailable || loading}>{t(loading ? 'initializing' : 'initialize')}</Button>
  </form>
})

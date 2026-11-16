import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorGraph, EditorResult } from '../../../shared/model-editor.ts'
import type { ModelingAction, ModelingResult } from '../../../shared/modeling-api.ts'
import type { ModelFileDraft } from '../../state/view-store.ts'
import { ModelFlow } from './ModelFlow.tsx'
import css from './ModelingPanel.module.css'

type Mode = 'dsl' | 'flow'
type Props = {
  t: TranslateNS<'sidebarWorkbench'>
  runId: string
  file: string
  revisionId: string | null
  opened: EditorResult
  draft?: ModelFileDraft
  changeDraft: (draft: ModelFileDraft) => void
  discard: () => void
  mode: Mode
  setMode: (mode: Mode) => void
  element: string
  selectElement: (element: string) => void
  remote: (request: ModelingAction) => Promise<ModelingResult>
  stale: boolean
  saved: (editor: EditorResult) => void
  adopted: (editor: EditorResult) => void
}
const fieldKeys = ['name', 'message', 'condition', 'trigger', 'action', 'source', 'target'] as const
type FieldKey = typeof fieldKeys[number]

function declaration(text: string, name: string) {
  if (!name) return
  const matches = [...text.matchAll(/^\s*(?:Statechart|State|Start|Condition|Call|Transition|DialogMap|Page|Entry|Scenario|Machine|Device|Interaction|widget_id:)\s+["']?([^"';\s{}]+)["']?/gm)]
    .filter(match => match[1] === name)
  if (matches.length !== 1) return
  return { index: matches[0]!.index! + matches[0]![0].search(/\S/), length: matches[0]![0].trimStart().length }
}

export function ModelFileEditor({ t, runId, file, revisionId, opened, draft, changeDraft, discard, mode, setMode, element,
  selectElement, remote, stale, saved, adopted }: Props) {
  const [graph, setGraph] = useState<EditorGraph>()
  const [cellId, setCellId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ModelingResult>()
  const mounted = useRef(false)
  const pending = useRef(false)
  const code = useRef<HTMLTextAreaElement>(null)
  const value: ModelFileDraft = draft ?? {
    draft: { text: opened.text ?? '', changes: [] }, layout: opened.layout ?? {}, hash: opened.hash!, expectedLatest: opened.latest ?? null,
  }
  const loc = declaration(value.draft.text, element)
  const line = loc ? value.draft.text.slice(0, loc.index).split('\n').length : undefined
  const cells = [...graph?.nodes ?? [], ...graph?.edges ?? []]
  const matching = element ? cells.filter(cell => cell.element === element) : []
  const selected = cells.find(cell => cell.id === cellId && cell.element === element) ?? (matching.length === 1 ? matching[0] : undefined)
  const select = (id: string) => {
    setCellId(id)
    selectElement(cells.find(cell => cell.id === id)?.element ?? '')
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (mode !== 'dsl' || !element || !code.current) return
    const location = declaration(code.current.value, element)
    if (!location) return
    code.current.focus({ preventScroll: true })
    code.current.setSelectionRange(location.index, location.index + location.length)
    const row = code.current.value.slice(0, location.index).split('\n').length
    code.current.scrollTop = Math.max(0, row - 3) * 19
  }, [element, mode])
  const execute = async (request: ModelingAction, complete: (editor: EditorResult) => void) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setProblem(undefined)
    try {
      const result = await remote(request)
      if (!mounted.current) return
      if (!result.ok || !result.editor) setProblem(result)
      else complete(result.editor)
    } catch {
      if (mounted.current) setProblem({ ok: false, problem: 'unavailable' })
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const switchTo = (next: Mode) => {
    if (next === 'dsl' && !value.draft.changes.length) {
      setMode(next)
      return
    }
    if (next === 'flow' && graph) {
      setMode(next)
      return
    }
    // Reopen the base graph so a previously rejected field edit stays editable.
    const conversion = next === 'flow' ? { ...value.draft, changes: [] } : value.draft
    void execute({ action: 'editor-convert', runId, file, revisionId, hash: value.hash, draft: conversion }, editor => {
      setGraph(editor.graph)
      if (next === 'dsl' && editor.text !== undefined) changeDraft({ ...value, draft: { text: editor.text, changes: [] } })
      setMode(next)
    })
  }
  const openFlow = useRef(() => { if (mode === 'flow') switchTo('flow') })
  useEffect(() => { openFlow.current() }, [])
  const updateField = (field: string, text: string) => {
    if (!selected || busy || stale) return
    const changes = value.draft.changes.filter(item => item.cell !== selected.id || item.field !== field)
    if (selected.fields.find(item => item.key === field)?.value !== text) changes.push({ cell: selected.id, field, value: text })
    changeDraft({ ...value, draft: { ...value.draft, changes } })
  }
  return (
    <div className={css.editor}>
      <div
        className={css.actions}
        role="group"
        aria-label={t('models')}
      >
        <Button
          className={mode === 'flow' ? css.primary : css.secondary}
          variant={mode === 'flow' ? 'primary' : 'outline'}
          aria-pressed={mode === 'flow'}
          disabled={busy}
          onClick={() => switchTo('flow')}
        >
          {t('modelEditorFlow')}
        </Button>
        <Button
          className={mode === 'dsl' ? css.primary : css.secondary}
          variant={mode === 'dsl' ? 'primary' : 'outline'}
          aria-pressed={mode === 'dsl'}
          disabled={busy}
          onClick={() => switchTo('dsl')}
        >
          {t('modelEditorCode')}
        </Button>
      </div>
      {busy && (
        <p
          className={css.caption}
          role="status"
        >
          {t('modelEditorLoading')}
        </p>
      )}
      {element && (
        <p className={css.location}>
          {element}
          {line ? ` · ${t('modelingLine')} ${line}` : ` · ${t('modelingNoLocation')}`}
        </p>
      )}
      {mode === 'dsl' ? (
        <textarea
          ref={code}
          className={css.dslInput}
          aria-label={t('modelEditorCode')}
          value={value.draft.text}
          spellCheck={false}
          maxLength={1_000_000}
          disabled={busy}
          readOnly={stale}
          onChange={event => {
            setGraph(undefined)
            changeDraft({ ...value, draft: { text: event.target.value, changes: [] } })
          }}
        />
      ) : (
        <>
          {graph && (
            <ModelFlow
              t={t}
              data={graph}
              layout={value.layout}
              selected={selected?.id ?? ''}
              select={select}
              move={(id, position) => {
                if (!busy && !stale) changeDraft({ ...value, layout: { ...value.layout, [id]: position } })
              }}
            />
          )}
          {selected?.fields.map(field => {
            if (!fieldKeys.includes(field.key as FieldKey)) return null
            const text = value.draft.changes.find(item => item.cell === selected.id && item.field === field.key)?.value ?? field.value
            return (
              <label
                className={css.labeledField}
                key={field.key}
              >
                <span>
                  {t(`modelEditorField_${field.key as FieldKey}`)}
                </span>
                {field.options ? (
                  <select
                    value={text}
                    disabled={busy || stale}
                    onChange={event => updateField(field.key, event.target.value)}
                  >
                    {field.options.map(option => (
                      <option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={text}
                    disabled={busy || stale}
                    maxLength={4000}
                    onChange={event => updateField(field.key, event.target.value)}
                  />
                )}
              </label>
            )
          })}
        </>
      )}
      {problem && (
        <div
          className={css.error}
          role="alert"
        >
          <strong>
            {t(`modelingError_${problem.problem ?? 'unavailable'}`)}
          </strong>
          {problem.detail && (
            <span>
              {problem.detail}
            </span>
          )}
        </div>
      )}
     <div className={css.actions}>
        <Button
          className={css.primary}
          variant="primary"
          disabled={busy || !draft || stale}
          onClick={() => void execute({ action: 'editor-save', runId, revisionId, file, ...value }, saved)}
        >
          {t('modelEditorSave')}
        </Button>
        {revisionId && (
          <Button
            className={css.secondary}
            variant="outline"
            disabled={busy || !!draft || stale || revisionId === opened.adopted}
            onClick={() => void execute({ action: 'editor-adopt', runId, revisionId, publication: opened.publication ?? 0 }, adopted)}
          >
            {t('modelEditorAdopt')}
          </Button>
        )}
        {draft && (
          <>
            <Button
              className={css.secondary}
              variant="outline"
              disabled={busy}
              onClick={() => {
                discard()
                setProblem(undefined)
                setGraph(undefined)
                setMode('dsl')
              }}
            >
              {t('modelEditorDiscard')}
            </Button>
            <span className={css.caption}>
              {t('modelEditorDirty')}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

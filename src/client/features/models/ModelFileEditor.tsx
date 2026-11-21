import { useEffect, useId, useRef, useState } from 'react'
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorRender, EditorResult } from '../../../shared/model-editor.ts'
import type { ModelingAction, ModelingResult } from '../../../shared/modeling-api.ts'
import type { ModelFileDraft } from '../../state/view-store.ts'
import { ModelFlow } from './ModelFlow.tsx'
import type { mountDslEditor } from './dsl/editor.ts'
import css from './ModelingPanel.module.css'

type Mode = 'dsl' | 'flow'
type Props = {
  t: TranslateNS<'sidebarWorkbench'>
  runId: string
  file: string
  kind: EditorRender['kind']
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
function declaration(text: string, name: string) {
  if (!name) return
  const matches = [...text.matchAll(/^\s*(?:Statechart|State|Start|Condition|Call|Transition|DialogMap|Page|Entry|Scenario|Machine|Device|Interaction|widget_id:)\s+["']?([^"';\s{}]+)["']?/gm)]
    .filter(match => match[1] === name)
  if (matches.length !== 1) return
  return { index: matches[0]!.index! + matches[0]![0].search(/\S/), length: matches[0]![0].trimStart().length }
}

export function ModelFileEditor({ t, runId, file, kind, revisionId, opened, draft, changeDraft, discard, mode, setMode, element,
  selectElement, remote, stale, saved, adopted }: Props) {
  const [visual, setVisual] = useState<EditorResult>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ModelingResult>()
  const mounted = useRef(false)
  const pending = useRef(false)
  const code = useRef<HTMLTextAreaElement>(null)
  const dslContainer = useRef<HTMLDivElement>(null)
  const dsl = useRef<ReturnType<typeof mountDslEditor>>()
  const shell = useRef<HTMLDivElement>(null)
  const tabs = useId()
  const [full, setFull] = useState(false)
  const [dslReady, setDslReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const value: ModelFileDraft = draft ?? {
    draft: { text: opened.text ?? '', changes: [] }, layout: opened.layout ?? {}, hash: opened.hash!, expectedLatest: opened.latest ?? null,
  }
  const loc = declaration(value.draft.text, element)
  const line = loc ? value.draft.text.slice(0, loc.index).split('\n').length : undefined
  const latest = useRef({ value, changeDraft, busy, stale, t })
  useEffect(() => { latest.current = { value, changeDraft, busy, stale, t } }, [value, changeDraft, busy, stale, t])

  const updateText = (text: string) => {
    const current = latest.current
    setVisual(undefined)
    current.changeDraft({ ...current.value, draft: { text, changes: [] } })
  }

  useEffect(() => {
    if (mode !== 'dsl') return
    let disposed = false
    setDslReady(false)
    setConnected(false)
    void import('./dsl/editor.ts').then(({ mountDslEditor }) => {
      if (disposed || !dslContainer.current) return
      const current = latest.current
      dsl.current = mountDslEditor(dslContainer.current, {
        kind,
        endpoint: stale ? undefined : opened.languageServiceUrl,
        value: current.value.draft.text,
        readOnly: current.busy || current.stale,
        label: current.t('modelEditorCode'),
        connection: ready => { if (!disposed) setConnected(ready) },
        change: updateText,
      })
      setDslReady(true)
    }).catch(() => { if (!disposed) setDslReady(false) })
    return () => {
      disposed = true
      dsl.current?.dispose()
      dsl.current = undefined
    }
  }, [mode, kind, opened.languageServiceUrl, stale])

  useEffect(() => {
    dsl.current?.setValue(value.draft.text)
    dsl.current?.setReadOnly(busy || stale)
  }, [value.draft.text, busy, stale])

  useEffect(() => {
    const onFullscreen = () => setFull(document.fullscreenElement === shell.current)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (mode !== 'dsl' || !element) return
    const location = declaration(latest.current.value.draft.text, element)
    if (!location) return
    if (dsl.current) {
      dsl.current.reveal(location.index, location.length)
      return
    }
    if (!code.current) return
    code.current.focus({ preventScroll: true })
    code.current.setSelectionRange(location.index, location.index + location.length)
    const row = code.current.value.slice(0, location.index).split('\n').length
    code.current.scrollTop = Math.max(0, row - 3) * 19
  }, [element, mode, dslReady])
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
    if (next === 'flow' && visual?.render) {
      setMode(next)
      return
    }
    void execute({ action: 'editor-convert', runId, file, revisionId, hash: value.hash, draft: value.draft }, editor => {
      if (next === 'flow' && !editor.render) {
        setProblem({ ok: false, problem: 'converter-response' })
        return
      }
      setVisual(editor)
      if (next === 'dsl' && editor.text !== undefined) changeDraft({ ...value, draft: { text: editor.text, changes: [] } })
      setMode(next)
    })
  }
  const openFlow = useRef(() => { if (mode === 'flow') switchTo('flow') })
  useEffect(() => { openFlow.current() }, [])
  return (
    <div
      className={css.editor}
      ref={shell}
    >
      <div className={css.editorToolbar}>
        <SegmentedTabs
          items={[
            { value: 'dsl', label: t('modelEditorCode'), id: `${tabs}-dsl`, panelId: `${tabs}-panel-dsl` },
            { value: 'flow', label: t('modelEditorFlow'), id: `${tabs}-flow`, panelId: `${tabs}-panel-flow` },
          ]}
          value={mode}
          label={t('models')}
          size="sm"
          onChange={next => { if (!busy && (next !== mode || next === 'flow' && !visual)) switchTo(next) }}
        />
        <Button
          variant="outline"
          disabled={!document.fullscreenEnabled}
          onClick={() => {
            const action = full ? document.exitFullscreen() : shell.current?.requestFullscreen()
            void action?.catch(() => setProblem({ ok: false, problem: 'unavailable' }))
          }}
        >
          {t(full ? 'modelEditorExitFullscreen' : 'modelEditorFullscreen')}
        </Button>
      </div>
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
                setVisual(undefined)
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
      <div
        className={css.editorBody}
        role="tabpanel"
        id={`${tabs}-panel-${mode}`}
        aria-labelledby={`${tabs}-${mode}`}
      >
        {mode === 'dsl' ? (
          <>
            <div
              ref={dslContainer}
              className={dslReady ? css.monacoEditor : css.monacoPending}
            />
            {!dslReady && (
              <textarea
                ref={code}
                className={css.dslInput}
                aria-label={t('modelEditorCode')}
                value={value.draft.text}
                spellCheck={false}
                maxLength={1_000_000}
                readOnly={busy || stale}
                onChange={event => updateText(event.target.value)}
              />
            )}
            {dslReady && opened.languageServiceUrl && !stale && !connected && (
              <p
                role="status"
                className={css.caption}
              >
                {t('modelEditorLanguageOffline')}
              </p>
            )}
          </>
        ) : visual?.render && (
          <ModelFlow
            t={t}
            file={file}
            data={visual.render}
            legacy={visual.graph}
            layout={value.layout}
            element={element}
            select={selectElement}
            editable={!busy && !stale}
            move={(id, position) => {
              const current = latest.current
              current.changeDraft({ ...current.value, layout: { ...current.value.layout, [id]: position } })
            }}
          />
        )}
      </div>
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
    </div>
  )
}

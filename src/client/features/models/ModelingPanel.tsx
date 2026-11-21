import { useEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { modelKinds, modelRunActive, modelRunDeletable, modelRunUnsettled, modelingStages, type ModelProblem, type ModelingAction, type ModelingResult, type ModelingRunView } from '../../../shared/modeling-api.ts'
import type { View } from '../../state/view-store.ts'
import type { EditorResult } from '../../../shared/model-editor.ts'
import { ModelFileEditor } from './ModelFileEditor.tsx'
import css from './ModelingPanel.module.css'

type Props = {
  t: TranslateNS<'sidebarWorkbench'>
  view: View
  change: (patch: Partial<View>) => void
  remote?: (request: ModelingAction) => Promise<ModelingResult>
  openFile: (path: string) => void
  openSession?: (id: string) => void
}
type Mapped = { requirement_id: string; status: string; artifacts: string[]; assertions: string[]; uncovered_assertions: string[]; reason: string }
type Requirement = { requirement_id: string; source_text: string; source_location: { section: string; start_line: number; end_line: number } }
type StartFailure = { id: string; feature: string; problem: ModelProblem; detail?: string }
const RECENT_RUN_COUNT = 5
const modelLocation: Record<string, string> = {
  Environment: 'Environment.dsl', ExternalScenario: 'ExternalScenarios/', Statechart: 'Statecharts/', DialogMap: 'DialogMaps/',
}

function latest(results: ModelingResult | undefined, feature: string | undefined): ModelingRunView | undefined {
  return results?.runs?.find(run => run.feature.id === feature && !run.stale) ?? results?.runs?.find(run => run.feature.id === feature)
}

export function ModelingPanel({ t, view, change, remote, openFile, openSession }: Props) {
  const [result, setResult] = useState<ModelingResult>()
  const [error, setError] = useState<ModelingResult | undefined>()
  const [startFailures, setStartFailures] = useState<StartFailure[]>([])
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string>()
  const [deleteError, setDeleteError] = useState<ModelingResult>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const requestKeys = useRef(new Map<string, string>())
  const pending = useRef(false)
  const latestRead = useRef(0)
  const scope = useRef(0)
  useEffect(() => {
    if (!remote) return
    const generation = ++scope.current
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const read = ++latestRead.current
      let interval = 2000
      try {
        const response = await remote({ action: 'inspect' })
        interval = response.pollIntervalMs ?? interval
        if (generation !== scope.current || read !== latestRead.current || pending.current) return
        setResult(response)
      } catch {
        if (generation === scope.current && read === latestRead.current && !pending.current) {
          setResult({ ok: false, problem: 'unavailable' })
        }
      } finally {
        if (generation === scope.current) timer = setTimeout(() => void poll(), interval)
      }
    }
    void poll()
    return () => { scope.current++; clearTimeout(timer) }
  }, [remote])

  const mutate = async (operation: (send: NonNullable<Props['remote']>, isCurrent: () => boolean) => Promise<void>) => {
    if (!remote || pending.current) return
    pending.current = true
    latestRead.current++
    const generation = scope.current
    setBusy(true)
    setError(undefined)
    const isCurrent = () => generation === scope.current
    try {
      await operation(remote, isCurrent)
    } catch {
      if (isCurrent()) setError({ ok: false, problem: 'unavailable' })
    } finally {
      pending.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  const call = (action: ModelingAction) => mutate(async (send, isCurrent) => {
    const response = await send(action)
    if (!isCurrent()) return
    if (response.ok) setResult(response)
    else setError(response)
  })
  const deleteRun = (runId: string) => mutate(async (send, isCurrent) => {
    setDeleteError(undefined)
    let response: ModelingResult
    try { response = await send({ action: 'delete-run', runId }) }
    catch (error) {
      const incompatible = error instanceof Error && (error.message === 'gateway/input-invalid' || error.message === 'gateway/method-unavailable')
      response = { ok: false, problem: incompatible ? 'host-upgrade-required' : 'unavailable' }
    }
    if (!isCurrent()) return
    if (!response.ok) {
      setDeleteError(response)
      return
    }
    const confirmed = response.deletedRunId === runId || (response.runs !== undefined && !response.runs.some(run => run.id === runId))
    if (!confirmed) {
      setDeleteError({ ok: false, problem: 'host-upgrade-required' })
      return
    }
    setResult(current => current ? { ...current, runs: current.runs?.filter(run => run.id !== runId) } : current)
    setDeleteTarget(undefined)
    if (view.modelingRun === runId) change({ modelingRun: undefined })
  })
  const baseline = result?.baseline
  const runs = result?.runs?.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? []
  const visibleRuns = view.modelingShowOlderRuns ? runs : runs.slice(0, RECENT_RUN_COUNT)
  const activeCount = runs.filter(run => modelRunActive(run.state)).length
  const blocked = new Map(runs.filter(run => modelRunUnsettled(run.state)).map(run => [run.feature.id, run]))
  const selectedIds = view.modelingSelection?.baselineId === baseline?.id ? view.modelingSelection?.featureIds ?? [] : []
  const selection = new Set(selectedIds)
  const selected = result?.features?.filter(feature => selection.has(feature.id) && !blocked.has(feature.id)) ?? []
  const run = runs.find(run => run.id === view.modelingRun) ?? runs.find(run => modelRunActive(run.state)) ?? runs[0]
  const problem = error ?? (result?.ok === false ? result : undefined)
  const search = view.modelingSearch ?? ''
  const filter = view.modelingFilter ?? 'all'
  const start = () => {
    if (!baseline || !selected.length) return
    void mutate(async (send, isCurrent) => {
      setStartFailures([])
      const submissions = await Promise.all(selected.map(async feature => {
        const signature = `${baseline.id}:${feature.id}`
        const requestKey = requestKeys.current.get(signature) ?? crypto.randomUUID()
        requestKeys.current.set(signature, requestKey)
        const response = await send({ action: 'start', baselineId: baseline.id, featureId: feature.id, requestKey })
          .catch((): ModelingResult => ({ ok: false, problem: 'unavailable' }))
        const runId = response.ok ? response.acceptedRunId : undefined
        if (runId) requestKeys.current.delete(signature)
        return { feature, response, runId }
      }))
      if (!isCurrent()) return
      const failures = submissions.filter(item => !item.runId)
      const accepted = submissions.find(item => item.runId)
      setStartFailures(failures.map(({ feature, response }) => ({
        id: feature.id, feature: feature.name, problem: response.problem ?? 'unavailable', detail: response.detail,
      })))
      if (accepted) {
        const snapshot = await send({ action: 'inspect' }).catch(() => undefined)
        if (!isCurrent()) return
        if (snapshot?.ok) setResult(snapshot)
        change({
          modelingSelection: { baselineId: baseline.id, featureIds: failures.map(({ feature }) => feature.id) },
          modelingRun: accepted.runId,
          page: failures.length ? 'features' : 'modeling-run',
        })
      }
    })
  }
  return (
    <section
      aria-label={t('modelingTitle')}
      className={css.panel}
    >
      <header className={css.header}>
        <h2>
          {view.page === 'features' ? t('modelingFeatures') : view.page === 'models' ? t('models') : t('modelingTitle')}
        </h2>
        {view.page === 'features' && baseline && (
          <p className={css.baseline}>
            <span>
              {t('modelingBaseline')}
            </span>
            <strong className={css.badge}>
              {baseline.label}
            </strong>
          </p>
        )}
        {view.page !== 'features' && (
          <Button
            className={css.secondary}
            variant="outline"
            onClick={() => change({ page: 'features' })}
          >
            {t('modelingFeatures')}
          </Button>
        )}
      </header>
      {(!remote || result?.available === false) && (
        <p
          className={css.notice}
          role="status"
        >
          {t('modelingUnavailable')}
        </p>
      )}
      {!result && remote && (
        <p
          className={css.notice}
          role="status"
        >
          {t('modelingLoading')}
        </p>
      )}
      {problem && (
        <p
          className={css.error}
          role="alert"
        >
          <strong>
            {t(`modelingError_${problem.problem ?? 'invalid'}`)}
          </strong>
          {problem.detail && (
            <span>
              {problem.detail}
            </span>
          )}
        </p>
      )}
      {view.page === 'features' && startFailures.length > 0 && (
        <ul
          className={css.list}
          role="alert"
        >
          {startFailures.map(({ id, feature, problem, detail }) => (
            <li
              key={id}
              className={css.error}
            >
              <strong>
                {feature}
              </strong>
              <span>
                {t(`modelingError_${problem}`)}
              </span>
              {detail && (
                <span>
                  {detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.page === 'features' && (
        <div className={css.card}>
          {!baseline && (
            <p className={css.empty}>
              {t('modelingNoBaseline')}
            </p>
          )}
          {baseline && (
            <>
              <div className={css.filters}>
                <Input
                  className={css.field}
                  aria-label={t('search')}
                  placeholder={t('search')}
                  value={search}
                  onChange={event => change({ modelingSearch: event.target.value })}
                />
                <select
                  aria-label={t('modelingFilter')}
                  value={filter}
                  onChange={event => {
                    const value = event.target.value
                    if (value === 'all' || value === 'current' || value === 'attention') change({ modelingFilter: value })
                  }}
                >
                  <option value="all">
                    {t('modelingAll')}
                  </option>
                  <option value="current">
                    {t('modelingSucceeded')}
                  </option>
                  <option value="attention">
                    {t('modelingAttention')}
                  </option>
                </select>
              </div>
              <ul className={css.list}>
                {result?.features?.filter(feature => {
                  const current = blocked.get(feature.id) ?? latest(result, feature.id)
                  const ready = current?.state === 'succeeded' && !current.stale
                  return `${feature.name} ${feature.requirementId ?? ''} ${feature.section ?? ''}`.toLowerCase().includes(search.toLowerCase())
                    && (filter === 'all' || (filter === 'current' ? ready : !ready))
                }).map(feature => {
                  const current = blocked.get(feature.id) ?? latest(result, feature.id)
                  const isSelected = selection.has(feature.id) && !blocked.has(feature.id)
                  return (
                    <li
                      key={feature.id}
                      className={css.featureRow}
                      data-selected={isSelected}
                    >
                      <Button
                        className={css.featureButton}
                        variant="ghost"
                        aria-pressed={isSelected}
                        disabled={busy || blocked.has(feature.id)}
                        onClick={() => change({
                          modelingSelection: {
                            baselineId: baseline.id,
                            featureIds: isSelected ? selectedIds.filter(id => id !== feature.id) : [...selectedIds, feature.id],
                          },
                        })}
                      >
                        <span
                          className={css.selectionMark}
                          aria-hidden="true"
                        >
                          {isSelected ? '✓' : ''}
                        </span>
                        {feature.name}
                      </Button>
                      <div className={css.featureMeta}>
                        {(feature.requirementId || feature.section) && (
                          <span className={css.caption}>
                            {[feature.requirementId, feature.section].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        <span
                          className={css.badge}
                          data-state={current?.state ?? 'pending'}
                        >
                          {current ? t(`modelingState_${current.state}`) : t('modelingNew')}
                        </span>
                        {current?.stale && (
                          <span
                            className={css.badge}
                            data-state="pending"
                          >
                            {t('modelingStale')}
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          {(baseline || !!result?.runs?.length) && (
            <div className={css.actionArea}>
              {activeCount > 0 && (
                <p className={css.notice}>
                  {t('modelingActiveCount', { count: activeCount })}
                </p>
              )}
              {selected.length > 0 && baseline && (
                <p className={css.caption}>
                  {t('modelingSelected', { count: selected.length, version: baseline.label })}
                </p>
              )}
              <div className={css.actions}>
                {baseline && (
                  <Button
                    className={css.primary}
                    variant="primary"
                    disabled={!selected.length || !result?.available || !result.ok || busy}
                    onClick={start}
                  >
                    {t('modelingTitle')}
                  </Button>
                )}
                {!!result?.runs?.length && (
                  <Button
                    className={css.secondary}
                    variant="outline"
                    onClick={() => change({ page: 'modeling-run', modelingRun: run?.id })}
                  >
                    {t('run')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {view.page !== 'features' && (
        <>
          {result?.ok && !run && (
            <p className={css.empty}>
              {t('modelingEmpty')}
            </p>
          )}
          {run && (
            <>
              <div className={css.runPicker}>
                <span className={css.caption}>
                  {t('run')}
                </span>
                <Menu
                  className={css.runPickerControl}
                  listClassName={css.historyMenu}
                  open={historyOpen}
                  onClose={() => setHistoryOpen(false)}
                  portal
                  autoFocus
                  anchor={
                    <Button
                      className={css.runPickerTrigger}
                      variant="outline"
                      aria-label={t('run')}
                      aria-haspopup="menu"
                      aria-expanded={historyOpen}
                      disabled={busy}
                      onClick={() => setHistoryOpen(open => !open)}
                    >
                      <span className={css.runPickerValue}>
                        <span>
                          {run.feature.name}{' · '}{t(`modelingState_${run.state}`)}
                        </span>
                        <span className={css.caption}>
                          {run.materialLabel}{' · '}{run.updatedAt.slice(0, 19).replace('T', ' ')}
                        </span>
                      </span>
                      <IconChevronDownOutlineRegular aria-hidden="true" />
                    </Button>
                  }
                >
                  <section
                    className={`${css.panel} ${css.historyOptions}`}
                    aria-label={t('run')}
                  >
                    <ul className={css.list}>
                      {visibleRuns.map(item => (
                        <li
                          key={item.id}
                          className={css.historyRow}
                          data-state={item.state}
                          data-selected={run.id === item.id}
                        >
                          <Button
                            className={css.historyButton}
                            variant="ghost"
                            role="menuitem"
                            aria-label={t('modelingSelectRun', { name: item.feature.name, id: item.id })}
                            aria-current={run.id === item.id ? 'true' : undefined}
                            disabled={busy}
                            onClick={() => {
                              change({ modelingRun: item.id })
                              setHistoryOpen(false)
                              setDeleteTarget(undefined)
                              setDeleteError(undefined)
                            }}
                          >
                            <span className={css.historyHeader}>
                              <strong title={item.feature.name}>
                                {item.feature.name}
                              </strong>
                              <span className={css.badge}>
                                {t(`modelingState_${item.state}`)}
                              </span>
                            </span>
                            <span className={css.historyMeta}>
                              <span className={css.caption}>
                                {item.materialLabel}{' · '}
                                <time dateTime={item.updatedAt}>
                                  {item.updatedAt.slice(0, 19).replace('T', ' ')}
                                </time>
                              </span>
                              <RunHistoryStatus
                                t={t}
                                run={item}
                              />
                            </span>
                            {item.stale && (
                              <span className={css.caption}>
                                {t('modelingStale')}
                              </span>
                            )}
                          </Button>
                          {modelRunDeletable(item.state) && (
                            <div className={css.historyActions}>
                              <Button
                                className={css.deleteRecord}
                                variant="outline"
                                disabled={busy || !remote}
                                aria-label={t('modelingDeleteRunLabel', { name: item.feature.name, id: item.id })}
                                aria-expanded={deleteTarget === item.id}
                                onClick={() => {
                                  setDeleteError(undefined)
                                  setDeleteTarget(current => current === item.id ? undefined : item.id)
                                }}
                              >
                                {t('modelingDeleteRun')}
                              </Button>
                            </div>
                          )}
                          {deleteTarget === item.id && modelRunDeletable(item.state) && (
                            <div className={css.deleteConfirmation}>
                              <p>
                                {t('modelingDeleteRunHint')}
                              </p>
                              {deleteError && (
                                <div
                                  className={css.error}
                                  role="alert"
                                >
                                  <strong>
                                    {t(`modelingError_${deleteError.problem ?? 'unavailable'}`)}
                                  </strong>
                                  {deleteError.detail && (
                                    <span>
                                      {deleteError.detail}
                                    </span>
                                  )}
                                </div>
                              )}
                              <div className={css.actions}>
                                <Button
                                  className={css.secondary}
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => {
                                    setDeleteTarget(undefined)
                                    setDeleteError(undefined)
                                  }}
                                >
                                  {t('modelingKeepRun')}
                                </Button>
                                <Button
                                  className={css.deleteRecord}
                                  variant="outline"
                                  disabled={busy || !remote}
                                  onClick={() => void deleteRun(item.id)}
                                >
                                  {t('modelingConfirmDeleteRun')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {runs.length > RECENT_RUN_COUNT && (
                      <Button
                        className={css.secondary}
                        variant="outline"
                        aria-expanded={view.modelingShowOlderRuns ?? false}
                        onClick={() => change({ modelingShowOlderRuns: !view.modelingShowOlderRuns })}
                      >
                        {view.modelingShowOlderRuns
                          ? t('modelingRecentRuns')
                          : t('modelingOlderRuns', { count: runs.length - RECENT_RUN_COUNT })}
                      </Button>
                    )}
                  </section>
                </Menu>
                {activeCount > 0 && (
                  <p className={css.caption}>
                    {t('modelingActiveCount', { count: activeCount })}
                  </p>
                )}
              </div>
              {view.page === 'models' ? (
                <ModelPreview
                  key={run.id}
                  t={t}
                  run={run}
                  baselineId={result?.baseline?.id}
                  view={view}
                  change={change}
                  remote={remote}
                  openFile={openFile}
                />
              ) : (
                <RunDetails
                  t={t}
                  run={run}
                  busy={busy}
                  act={action => void call({ action, runId: run.id })}
                  showModels={() => change({ page: 'models', modelingRun: run.id })}
                  openFile={openFile}
                  openSession={openSession}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

function RunHistoryStatus({ t, run }: { t: Props['t']; run: ModelingRunView }) {
  switch (run.state) {
    case 'queued':
      return (
        <span className={css.caption}>
          {t('modelingRunQueued')}
        </span>
      )
    case 'running':
      return (
        <span className={css.historyProgress}>
          <span>
            {t(`modelingStage_${run.stage}`)}
          </span>
          <progress
            aria-label={t('modelingProgress')}
            max={modelingStages.length - 1}
            value={run.completed.filter(stage => stage !== 'finished').length}
          />
        </span>
      )
    case 'cancelling':
      return (
        <span className={css.historyNotice}>
          {t('modelingRunCancelling')}
        </span>
      )
    case 'succeeded':
      return (
        <span className={css.historyOutcome}>
          {(run.validationIssues ?? 0) > 0
            ? t('modelingValidationIssues', { count: run.validationIssues! })
            : t('modelingIssuesSummary', { gaps: run.gaps ?? 0, relations: run.relationIssues ?? 0 })}
        </span>
      )
    case 'failed':
      return (
        <span
          className={css.historyFailure}
          title={run.detail}
        >
          {t(`modelingStage_${run.stage}`)}{' · '}
          {run.problem ? t(`modelingError_${run.problem}`) : t('modelingState_failed')}
        </span>
      )
    case 'cancelled':
      return (
        <span className={css.caption}>
          {t('modelingRunCancelled', { stage: t(`modelingStage_${run.stage}`) })}
        </span>
      )
    case 'interrupted':
      return (
        <span className={css.historyNotice}>
          {t('modelingReconcile')}
        </span>
      )
  }
}

function RunDetails({ t, run, busy, act, showModels, openFile, openSession }: {
  t: Props['t']; run: ModelingRunView; busy: boolean; act: (action: 'cancel' | 'reconcile') => void
  showModels: () => void; openFile: Props['openFile']; openSession: Props['openSession']
}) {
  const execution = run.executionSessionId
  const artifacts = run.artifacts.filter(item => /\.(?:json|txt|md|dsl)$/i.test(item.path))
  return (
    <>
      <div className={css.card}>
        <RunSummary
          t={t}
          run={run}
        />
        <p className={css.path}>
          {run.id}
        </p>
        {(run.validationIssues ?? 0) > 0 && (
          <p className={css.notice}>
            {t('modelingValidationIssues', { count: run.validationIssues! })}
          </p>
        )}
        {((run.gaps ?? 0) > 0 || (run.relationIssues ?? 0) > 0) && (
          <p className={css.notice}>
            {t('modelingIssuesSummary', { gaps: run.gaps ?? 0, relations: run.relationIssues ?? 0 })}
          </p>
        )}
        {run.problem && (
          <p
            className={css.error}
            role="alert"
          >
            <strong>
              {t(`modelingError_${run.problem}`)}
            </strong>
            {run.detail && (
              <span>
                {run.detail}
              </span>
            )}
          </p>
        )}
        <ol className={css.stageList}>
          {modelingStages.filter(stage => stage !== 'finished').map(stage => {
            const completed = run.completed.includes(stage)
            const skipped = stage === 'DialogMap' && run.dialogApplicable === false
            const current = run.stage === stage
            return (
              <li
                key={stage}
                className={css.stage}
                aria-current={current ? 'step' : undefined}
                data-completed={completed}
              >
                <span className={css.stageName}>
                  {t(`modelingStage_${stage}`)}
                </span>
                <span
                  className={css.badge}
                  data-state={completed ? 'succeeded' : current ? run.state : 'pending'}
                >
                  {completed ? t('modelingSucceeded') : skipped ? t('modelingNoDialog')
                    : current ? t(`modelingState_${run.state}`) : t('modelingPending')}
                </span>
              </li>
            )
          })}
        </ol>
        <div className={css.actions}>
          {modelRunActive(run.state) && (
            <Button
              className={css.secondary}
              variant="outline"
              disabled={busy || run.state === 'cancelling'}
              onClick={() => act('cancel')}
            >
              {t('cancel')}
            </Button>
          )}
          {run.state === 'interrupted' && (
            <Button
              className={css.secondary}
              variant="outline"
              disabled={busy}
              onClick={() => act('reconcile')}
            >
              {t('modelingReconcile')}
            </Button>
          )}
          {execution && openSession && (
            <Button
              className={css.secondary}
              variant="outline"
              onClick={() => openSession(execution)}
            >
              {t('modelingOpenSession')}
            </Button>
          )}
          {run.artifacts.some(artifact => artifact.path.endsWith('.dsl')) && (
            <Button
              className={css.primary}
              variant="primary"
              onClick={showModels}
            >
              {t('models')}
            </Button>
          )}
        </div>
        {execution && !openSession && (
          <p className={css.path}>
            {t('modelingOpenSession')}{' · '}{execution}
          </p>
        )}
      </div>
      {artifacts.length > 0 && (
        <div className={css.card}>
          <h3>
            {t('artifacts')}
          </h3>
          <ul className={css.list}>
            {artifacts.map(artifact => (
              <li key={artifact.path}>
                <Button
                  className={css.fileButton}
                  variant="ghost"
                  onClick={() => openFile(artifact.path)}
                >
                  {artifact.path.split('/').slice(2).join('/')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function RunSummary({ t, run }: Pick<Props, 't'> & { run: ModelingRunView }) {
  return (
    <div className={css.runSummary} role="status">
      <strong className={css.runName}>
        {run.feature.name}
      </strong>
      <div className={css.featureMeta}>
        <span className={css.caption}>
          {run.materialLabel}
        </span>
        <span
          className={css.badge}
          data-state={run.state}
        >
          {t(`modelingState_${run.state}`)}
        </span>
        {run.stale && (
          <span
            className={css.badge}
            data-state="pending"
          >
            {t('modelingStale')}
          </span>
        )}
      </div>
    </div>
  )
}

function ModelPreview({ t, run, baselineId, view, change, remote, openFile }: {
  t: Props['t']; run: ModelingRunView; baselineId?: string; view: View; change: Props['change']; remote: Props['remote']; openFile: Props['openFile']
}) {
  const [traceInput, setTraceInput] = useState<{ requirements: Requirement[]; sourceHash?: string }>({ requirements: [] })
  const [requirementId, setRequirementId] = useState('')
  const [element, setElement] = useState('')
  const [loaded, setLoaded] = useState<{ key: string; result: ModelingResult }>()
  const [traceError, setTraceError] = useState(false)
  const [savedMessage, setSavedMessage] = useState('')
  const directory = `workbench-runs/${run.id}/model/`
  const dsl = run.artifacts.filter(artifact => artifact.path.startsWith(directory) && artifact.path.endsWith('.dsl'))
  const kind = view.model
  const selected = dsl.filter(artifact => artifact.path.slice(directory.length).startsWith(modelLocation[kind] ?? 'Environment.dsl'))
  const selection = view.modelingEditors?.[run.id]
  const file = selected.find(artifact => artifact.path.slice(directory.length) === selection?.file)?.path.slice(directory.length)
    ?? selected[0]?.path.slice(directory.length) ?? ''
  const revisionId = selection ? selection.revisionId : run.currentEditorRevision ?? null
  const mode = selection?.mode ?? 'dsl'
  const key = JSON.stringify([run.id, revisionId, file])
  const editable = run.state === 'succeeded' || run.state === 'failed'
  const result = loaded?.key === key ? loaded.result : undefined
  const opened = result?.editor
  const draft = view.modelingDrafts?.[key]
  const requirementsPath = run.artifacts.find(item => item.path === `${directory}requirements.json`)?.path
  const { requirements } = traceInput
  const source = run.artifacts.find(item => item.sha256 === traceInput.sourceHash && item.path.startsWith(`workbench-runs/${run.id}/input/project/`) && item.path.endsWith('.md'))
  const current = requirements.find(item => item.requirement_id === requirementId)
  let coverage: Mapped[] = []
  if (opened?.map) {
    try {
      const map = JSON.parse(opened.map)
      if (Array.isArray(map.coverage)) coverage = map.coverage
    } catch { /* Show the absence of verified mapping. */ }
  }
  const mapping = coverage.find(item => item.requirement_id === requirementId)
  const related = element ? coverage.filter(item => item.artifacts.includes(`${file}#${element}`)) : []
  const review = opened?.review?.includes(requirementId)
  useEffect(() => {
    if (!remote || !requirementsPath) return
    let cancelled = false
    void remote({ action: 'artifact', runId: run.id, path: requirementsPath }).then(response => {
      if (!response.ok || response.content === undefined) throw new Error('Requirements are unavailable')
      const content = JSON.parse(response.content)
      if (!Array.isArray(content.requirements)) throw new Error('Invalid requirements')
      if (!cancelled) setTraceInput({ requirements: content.requirements, sourceHash: content.source?.sha256 })
    }).catch(() => { if (!cancelled) setTraceError(true) })
    return () => { cancelled = true }
  }, [remote, run.id, requirementsPath])
  useEffect(() => {
    if (!remote || !file || !editable) return
    let cancelled = false
    void remote({ action: 'editor-open', runId: run.id, revisionId, file }).then(response => {
      if (!cancelled) setLoaded({ key, result: response })
    }).catch(() => {
      if (!cancelled) setLoaded({ key, result: { ok: false, problem: 'unavailable' } })
    })
    return () => { cancelled = true }
  }, [remote, run.id, key, file, revisionId, editable])
  const editSelection = (next: { file: string; revisionId: string | null; mode: 'dsl' | 'flow' }) =>
    ({ ...view.modelingEditors, [run.id]: next })
  const show = (model: string, nextFile: string, location = '') => {
    setElement(location)
    setSavedMessage('')
    change({ model, modelingEditors: editSelection({ file: nextFile, revisionId, mode }) })
  }
  const withoutDraft = () => {
    const drafts = { ...view.modelingDrafts }
    delete drafts[key]
    return drafts
  }
  const save = (editor: EditorResult) => {
    const id = editor.revision?.id
    if (!id) return
    setSavedMessage(editor.revision!.path)
    setLoaded({ key: JSON.stringify([run.id, id, file]), result: { ok: true, editor } })
    change({ modelingDrafts: withoutDraft(), modelingEditors: editSelection({ file, revisionId: id, mode }) })
  }
  const diskPath = revisionId ? `workbench-runs/${run.id}/revisions/${revisionId}/model/${file}` : directory + file
  return (
    <>
      <div className={css.card}>
        <RunSummary
          t={t}
          run={run}
        />
        <div
          className={css.modelKinds}
          role="group"
          aria-label={t('models')}
        >
          {modelKinds.map(item => (
            <Button
              key={item}
              variant={kind === item ? 'primary' : 'outline'}
              className={kind === item ? css.primary : css.secondary}
              aria-pressed={kind === item}
              onClick={() => show(item, '')}
            >
              {item}
            </Button>
          ))}
        </div>
        {selected.length > 0 ? (
          <label className={css.labeledField}>
            <span>
              {t('artifacts')}
            </span>
            <select
              aria-label={t('artifacts')}
              value={file}
              onChange={event => show(kind, event.target.value)}
            >
              {selected.map(artifact => (
                <option
                  key={artifact.path}
                  value={artifact.path.slice(directory.length)}
                >
                  {artifact.path.slice(directory.length)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className={css.empty}>
            {kind === 'DialogMap' && run.dialogApplicable === false ? t('modelingNoDialog') : t('modelingNoLocation')}
          </p>
        )}
        {opened && remote && (
          <>
            <label className={css.labeledField}>
              <span>
                {t('modelEditorRevision')}
              </span>
              <select
                aria-label={t('modelEditorRevision')}
                value={revisionId ?? ''}
                onChange={event => {
                  setElement('')
                  setSavedMessage('')
                  change({ modelingEditors: editSelection({ file, revisionId: event.target.value || null, mode }) })
                }}
              >
                <option value="">
                  {t('modelEditorOriginal')}
                </option>
                {opened.revisions?.map(item => (
                  <option
                    key={item.id}
                    value={item.id}
                  >
                    {`${item.createdAt.slice(0, 19)} · ${item.id.slice(0, 8)}${item.id === opened.adopted ? ` · ${t('modelEditorAdopted')}` : ''}`}
                  </option>
                ))}
              </select>
            </label>
            <div className={css.previewHeader}>
              <p className={css.path}>
                {file}
              </p>
              <Button
                className={css.secondary}
                variant="outline"
                onClick={() => openFile(diskPath)}
              >
                {t('modelingOpenFile')}
              </Button>
            </div>
            <ModelFileEditor
              key={key}
              t={t}
              runId={run.id}
              file={file}
              kind={kind === 'ExternalScenario' || kind === 'Statechart' || kind === 'DialogMap' ? kind : 'Environment'}
              revisionId={revisionId}
              opened={opened}
              draft={draft}
              changeDraft={value => change({ modelingDrafts: { ...view.modelingDrafts, [key]: value } })}
              discard={() => change({ modelingDrafts: withoutDraft() })}
              mode={mode}
              setMode={nextMode => change({ modelingEditors: editSelection({ file, revisionId, mode: nextMode }) })}
              element={element}
              selectElement={setElement}
              remote={remote}
              stale={run.baselineId !== baselineId}
              saved={save}
              adopted={editor => setLoaded({ key, result: { ok: true, editor: { ...opened, ...editor } } })}
            />
            {savedMessage && (
              <p
                className={css.notice}
                role="status"
              >
                {t('modelEditorSaved')}{' · '}{savedMessage}
              </p>
            )}
          </>
        )}
        {!result && file && editable && (
          <p
            className={css.caption}
            role="status"
          >
            {t('modelEditorLoading')}
          </p>
        )}
        {result?.ok === false && (
          <div
            className={css.error}
            role="alert"
          >
            <strong>
              {t(`modelingError_${result.problem ?? 'unavailable'}`)}
            </strong>
            {result.detail && (
              <span>
                {result.detail}
              </span>
            )}
          </div>
        )}
      </div>
      {(requirements.length > 0 || opened) && (
        <div className={css.card}>
          {requirements.length > 0 && (
            <label className={css.labeledField}>
              <span>
                {t('modelingRequirement')}
              </span>
              <select
                aria-label={t('modelingRequirement')}
                value={requirementId}
                onChange={event => {
                  const id = event.target.value
                  setRequirementId(id)
                  const reference = coverage.find(item => item.requirement_id === id)?.artifacts[0]
                  if (!reference) return
                  const [path, name] = reference.split('#')
                  const target = modelKinds.find(candidate => path?.startsWith(modelLocation[candidate]!))
                  if (path && target && dsl.some(artifact => artifact.path === directory + path)) show(target, path, name)
                }}
              >
                <option value="">
                  {t('modelingSelect')}
                </option>
                {requirements.map(item => (
                  <option
                    key={item.requirement_id}
                    value={item.requirement_id}
                  >
                    {item.requirement_id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {opened && !opened.map && (
            <p className={css.empty}>
              {t('modelEditorNoMap')}
            </p>
          )}
          {element && opened?.map && (
            <div className={css.trace}>
              <strong>
                {t('modelEditorRelated')}
              </strong>
              {related.length > 0 ? (
                <div className={css.links}>
                  {related.map(item => (
                    <Button
                      key={item.requirement_id}
                      className={css.fileButton}
                      variant="ghost"
                      onClick={() => setRequirementId(item.requirement_id)}
                    >
                      {item.requirement_id}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className={css.caption}>
                  {t('modelingNoLocation')}
                </p>
              )}
            </div>
          )}
          {current && (
            <div className={css.trace}>
              <p className={css.location}>
                {current.source_location.section}{' · '}{current.source_location.start_line}–{current.source_location.end_line}
              </p>
              <blockquote className={css.quote}>
                {current.source_text}
              </blockquote>
              {source && (
                <div className={css.actions}>
                  <Button
                    className={css.secondary}
                    variant="outline"
                    onClick={() => openFile(source.path)}
                  >
                    {t('modelingOpenSource')}
                  </Button>
                </div>
              )}
              <p
                className={css.badge}
                data-state={review ? 'partial' : mapping?.status ?? 'pending'}
              >
                {review ? t('modelEditorReview') : mapping ? t(`modelingCoverage_${mapping.status as 'covered' | 'partial' | 'missing' | 'non_testable' | 'external_dependency' | 'deferred'}`) : t('modelEditorNoMap')}
              </p>
              {mapping?.reason && (
                <p className={css.caption}>
                  {mapping.reason}
                </p>
              )}
              {mapping?.assertions.map(assertion => (
                <p
                  key={assertion}
                  className={css.assertion}
                >
                  <strong>
                    {t('modelingAssertion')}
                  </strong>
                  <span>
                    {assertion}
                  </span>
                </p>
              ))}
              {mapping?.uncovered_assertions.map(assertion => (
                <p
                  key={assertion}
                  className={css.assertion}
                  data-state="partial"
                >
                  <strong>
                    {t('modelingGap')}
                  </strong>
                  <span>
                    {assertion}
                  </span>
                </p>
              ))}
              <div className={css.links}>
                {mapping?.artifacts.map(location => {
                  const [path, name] = location.split('#')
                  const target = modelKinds.find(candidate => path?.startsWith(modelLocation[candidate]!))
                  return target && path && dsl.some(artifact => artifact.path === directory + path) ? (
                    <Button
                      key={location}
                      className={css.fileButton}
                      variant="ghost"
                      onClick={() => show(target, path, name)}
                    >
                      {location}
                    </Button>
                  ) : null
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {traceError && (
        <p
          className={css.error}
          role="alert"
        >
          {t('modelingNoLocation')}
        </p>
      )}
    </>
  )
}

/** Real itemization review. Durable execution remains owned by Host when this view unmounts. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Input, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { z } from 'zod'
import { isTerminalItemizationState, itemizationResultSchema, type ItemizationResult, type ItemizationCommand } from '../../../shared/itemization-api.ts'
import type { WorkbenchInjected } from '../../app/workbench-types.ts'
import type { View } from '../../state/view-store.ts'
import { MaterialPathInput } from './MaterialPathInput.tsx'
import css from '../../styles/Workbench.module.css'
import ui from './ItemizationPanel.module.css'
import { ItemizationReport } from './ItemizationReport.tsx'

const diffSchema = z.object({ added: z.array(z.string()), deleted: z.array(z.string()), renamed: z.array(z.object({ previous: z.string(), candidate: z.string() })),
  changed: z.array(z.object({ previous: z.string(), candidate: z.string() })), affected: z.array(z.string()), relationsChanged: z.boolean(),
  unmatched: z.array(z.object({ previous: z.array(z.string()), candidate: z.array(z.string()) })),
  adoptionReview: z.object({ reviewBlocked: z.boolean(), approvalReason: z.string().optional() }).optional(),
  details: z.object({ previous: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() }).passthrough()),
    candidate: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() }).passthrough()),
    previousRelations: z.string().nullable(), candidateRelations: z.string() }).optional() }).passthrough()
const contentSchema = z.object({ index: z.object({ functions: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() }).passthrough()) }).passthrough(),
  chunks: z.object({ chunks: z.array(z.object({ chunk_id: z.string(), title: z.string(), chunk_type: z.string(), source_relative_path: z.string().optional(), canonical_function_name: z.string().optional(),
    source_sections: z.array(z.object({ section_id: z.string(), title: z.string().optional() }).passthrough()).optional() }).passthrough()),
    project_relation_seed: z.record(z.string(), z.unknown()) }).passthrough(), validation: z.record(z.string(), z.unknown()).optional() })
type Command = Omit<ItemizationCommand, 'sessionId' | 'workspaceId'>
const RECENT_RUN_COUNT = 3

/** @param props - Workspace-scoped commands, persisted form drafts, locale and resource navigation. @returns Real jobs and candidate review. */
export function ItemizationPanel({ t, remote, unavailable, fields, change, feedback, listFiles, openFile }: {
  t: TranslateNS<'sidebarWorkbench'>; remote: WorkbenchInjected['itemization']; unavailable: boolean
  fields: Pick<View, 'original' | 'markdown' | 'version' | 'sameVersion'>; change: (patch: Partial<View>) => void
  feedback: string; listFiles: WorkbenchInjected['listFiles']; openFile: (path: string) => void
}) {
  const [result, setResult] = useState<ItemizationResult>()
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string>()
  const [showOlderRuns, setShowOlderRuns] = useState(false)
  const [newVersion, setNewVersion] = useState(false)
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState<z.infer<typeof contentSchema>>()
  const [comparison, setComparison] = useState<z.infer<typeof diffSchema>>()
  const [proof, setProof] = useState<string>()
  const [proofRevision, setProofRevision] = useState<number>()
  const [matches, setMatches] = useState<Record<string, string>>({})
  const [confirmUnmatched, setConfirmUnmatched] = useState(false)
  const [confirmImpact, setConfirmImpact] = useState(false)
  const [localView, setLocalView] = useState('overview')
  const uid = useId()
  const alive = useRef(true), serial = useRef(0), mutation = useRef(false)
  const requestKey = useRef<string>()
  const send = useCallback(async (command: Command) => {
    if (!remote || unavailable) return
    if (mutation.current) return
    const generation = ++serial.current
    const write = command.action !== 'inspect'
    if (write) { if (mutation.current) return; mutation.current = true; setBusy(true) }
    if (command.action === 'compare') { setProof(undefined); setConfirmImpact(false) }
    try {
      const response = itemizationResultSchema.parse(await remote(command))
      if (!alive.current || generation !== serial.current) return
      if (!response.ok) { setProblem(response.problem ?? 'storage'); if (command.action === 'adopt') { setProof(undefined); setConfirmImpact(false) }; return }
      setProblem(undefined)
      setResult(previous => ({ ...previous, ...response, state: response.state ?? previous?.state, runs: response.runs ?? previous?.runs }))
      if (response.content) setContent(contentSchema.parse(JSON.parse(response.content)))
      if (response.comparison) { setComparison(diffSchema.parse(JSON.parse(response.comparison))); setProof(response.impactFingerprint); setProofRevision(response.state?.revision); setConfirmImpact(false) }
      if (command.action === 'start') requestKey.current = undefined
      if (command.action === 'delete-run') setDeleteTarget(undefined)
      if (command.action === 'adopt') { setProof(undefined); setConfirmImpact(false) }
    } catch (error) { if (alive.current && generation === serial.current) setProblem('transport') }
    finally { if (write) { mutation.current = false; if (alive.current) setBusy(false) } }
  }, [remote, unavailable])
  useEffect(() => {
    alive.current = true
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (!mutation.current) await send({ action: 'inspect' })
      if (active) timer = setTimeout(() => { void refresh() }, result?.pollIntervalMs ?? 2000)
    }
    void refresh()
    return () => { active = false; alive.current = false; serial.current++; if (timer) clearTimeout(timer) }
  }, [send, result?.pollIntervalMs])
  const resetReview = (id: string) => { setSelected(id); setContent(undefined); setComparison(undefined); setProof(undefined); setMatches({}); setConfirmUnmatched(false); setConfirmImpact(false) }
  const state = result?.state, candidates = state?.candidates ?? [], candidate = candidates.find(item => item.id === selected)
  const disabled = unavailable || busy || !remote
  const runs = result?.runs?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
  const visibleRuns = showOlderRuns ? runs : runs.slice(0, RECENT_RUN_COUNT)
  const liveRuns = runs.some(run => !isTerminalItemizationState(run.state))
  const launch = (adjust: boolean) => {
    requestKey.current ??= crypto.randomUUID()
    setProof(undefined)
    void send({ action: 'start', requestKey: requestKey.current,
      feedback, ...(adjust ? { parentCandidateId: selected } : newVersion ? { materials: { ...fields, sameVersion: true } } : {}) })
  }
  const compareFields = () => ({ candidateId: selected, matches: Object.entries(matches).filter(([, value]) => value).map(([previous, next]) => ({ previous, candidate: next })), confirmUnmatched })
  const name = (id: string) => [...comparison?.details?.previous ?? [], ...comparison?.details?.candidate ?? [], ...content?.index.functions ?? []].find(item => item.id === id)?.name ?? id
  const path = (id: string) => [...comparison?.details?.previous ?? [], ...comparison?.details?.candidate ?? []].find(item => item.id === id)?.path
  const errorText = (code: string) => {
    switch (code) {
      case 'run-not-settled': return t('itDeleteRunUnsettled')
      case 'skill-unavailable': return t('itProblem_skill-unavailable')
      case 'source-conflict': case 'output-limit': case 'credentials': case 'executor': case 'model': case 'validation': case 'timeout': case 'conflict': case 'changed': case 'identity': case 'storage': case 'unreviewed': return t(`itProblem_${code}`)
      case 'transport': return t('itTransport')
      default: return t('itProblem')
    }
  }
  const baseline = state?.materials.find(item => item.id === candidates.find(value => value.id === state.baseline)?.materialId)?.label
  const adoptionReview = comparison?.adoptionReview
  const blocked = adoptionReview?.reviewBlocked ?? (content?.validation?.reviewBlocked === true)
  const approvalReason = adoptionReview
    ? adoptionReview.approvalReason
    : typeof content?.validation?.approvalReason === 'string' ? content.validation.approvalReason : undefined
  return (
    <section
      className={`${css.itemization} ${ui.panel}`}
      aria-label={t('itTitle')}
      aria-busy={busy}
    >
      <header className={ui.header}>
        <div>
          <p className={ui.eyebrow}>
            {t('stageOne')}
          </p>
          <h2>
            {t('itTitle')}
          </h2>
          <p className={ui.description}>
            {t('itIntro')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void send({ action: 'inspect' })
          }}
          disabled={disabled}
        >
          {t('refresh')}
        </Button>
      </header>
      <div className={ui.summary}>
        <div className={ui.baseline}>
          <p>
            <span className={ui.caption}>
              {t('formalBaseline')}
              {': '}
            </span>
            <span
              className={ui.badge}
              data-tone={baseline ? 'success' : 'neutral'}
            >
              {baseline ?? t('itNoBaseline')}
            </span>
          </p>
        </div>
        <div>
          <span className={ui.caption}>
            {t('itCandidate')}
          </span>
          <strong>
            {candidates.length}
          </strong>
        </div>
        <div>
          <span className={ui.caption}>
            {t('run')}
          </span>
          <strong>
            {runs.length}
          </strong>
        </div>
      </div>
      {unavailable && (
        <p
          className={ui.notice}
          data-tone="warning"
          role="status"
        >
          {t('itBinding')}
        </p>
      )}
      {result?.available === false && (
        <p
          className={ui.notice}
          data-tone="warning"
          role="status"
        >
          {t('itUnavailable')}
        </p>
      )}
      {problem && (
        <p
          className={ui.notice}
          data-tone="error"
          role="alert"
        >
          {errorText(problem)}
        </p>
      )}
      <section
        className={ui.card}
        aria-labelledby={`${uid}-prepare`}
      >
        <div className={ui.sectionHeading}>
          <span className={ui.step}>
            01
          </span>
          <div>
            <h3 id={`${uid}-prepare`}>
              {t('itPrepare')}
            </h3>
            <p>
              {t('itPrepareHint')}
            </p>
          </div>
        </div>
        <label className={ui.checkRow}>
          <input
            type="checkbox"
            checked={newVersion}
            disabled={disabled}
            onChange={event => {
              setNewVersion(event.target.checked)
              requestKey.current = undefined
            }}
          />
          <span>
            {t('itNewVersion')}
          </span>
        </label>
        {newVersion && (
          <fieldset
            className={ui.materials}
            disabled={disabled}
          >
            <legend>
              {t('itSnapshotVersion')}
            </legend>
            {(['original', 'markdown'] as const).map(field => (
              <label key={field}>
                {t(field)}
                <MaterialPathInput
                  value={fields[field]}
                  onChange={value => {
                    change({ [field]: value })
                    requestKey.current = undefined
                  }}
                  listFiles={listFiles}
                  extension={field === 'original' ? /\.(pdf|docx)$/i : /\.md$/i}
                  emptyLabel={t('fileEmpty')}
                  failedLabel={t('fileLookupFailed')}
                  versionLabel={t('fileLookupVersion')}
                  loadingLabel={t('loading')}
                  previewFailedLabel={t('filePreviewFailed')}
                  openFile={openFile}
                  className={css.field}
                />
              </label>
            ))}
            <label>
              {t('itSnapshotVersion')}
              <Input
                value={fields.version}
                onChange={event => {
                  change({ version: event.target.value })
                  requestKey.current = undefined
                }}
              />
            </label>
            <label className={ui.checkRow}>
              <input
                type="checkbox"
                checked={fields.sameVersion}
                onChange={event => change({ sameVersion: event.target.checked })}
              />
              <span>
                {t('sameVersion')}
              </span>
            </label>
          </fieldset>
        )}
        <label>
          {t('itFeedback')}
          <textarea
            placeholder={t('itFeedbackHint')}
            value={feedback}
            onChange={event => {
              change({ itemizationFeedback: event.target.value })
              requestKey.current = undefined
            }}
          />
        </label>
        <div className={ui.launch}>
          <p>
            {t('itLaunchHint')}
          </p>
          <Button
            variant="primary"
            disabled={
              disabled || liveRuns || result?.available === false ||
              newVersion && (!fields.original || !fields.markdown || !fields.version || !fields.sameVersion)
            }
            onClick={() => launch(false)}
          >
            {t('itStart')}
          </Button>
        </div>
      </section>
      <section
        className={ui.card}
        aria-labelledby={`${uid}-runs`}
      >
        <div className={ui.sectionHeading}>
          <span className={ui.step}>
            02
          </span>
          <div>
            <h3 id={`${uid}-runs`}>
              {t('run')}
            </h3>
            <p>
              {t('itRunHint')}
            </p>
          </div>
          <span className={ui.count}>
            {runs.length}
          </span>
        </div>
        {runs.length === 0 && (
          <p className={ui.empty}>
            {t('noRuns')}
          </p>
        )}
        <div
          className={ui.runList}
          id={`${uid}-run-list`}
        >
          {visibleRuns.map(run => (
            <article
              className={ui.runCard}
              key={run.id}
            >
              <div className={ui.runHeading}>
                <span
                  className={ui.badge}
                  data-tone={
                    run.state === 'succeeded' ? 'success' :
                    run.state === 'failed' ? 'error' :
                    ['interrupted', 'unknown'].includes(run.state) ? 'warning' :
                    ['queued', 'running', 'cancelling'].includes(run.state) ? 'active' : 'neutral'
                  }
                >
                  {t(run.state)}
                </span>
                <span className={ui.stage}>
                  {t(`itStage_${run.stage}`)}
                </span>
              </div>
              <dl className={ui.metadata}>
                <div>
                  <dt>
                    {t('itRunId')}
                  </dt>
                  <dd>
                    {run.id}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t('itCreated')}
                  </dt>
                  <dd>
                    <time dateTime={run.createdAt}>
                      {run.createdAt}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>
                    {t('itUpdated')}
                  </dt>
                  <dd>
                    <time dateTime={run.updatedAt}>
                      {run.updatedAt}
                    </time>
                  </dd>
                </div>
                {run.sessionId && (
                  <div>
                    <dt>
                      {t('itSession')}
                    </dt>
                    <dd>
                      {run.sessionId}
                    </dd>
                  </div>
                )}
              </dl>
              {run.problem && (
                <p
                  className={ui.notice}
                  data-tone="error"
                  role="status"
                >
                  {errorText(run.problem)}
                </p>
              )}
              <div className={css.actions}>
                {['queued', 'running'].includes(run.state) && (
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void send({ action: 'cancel', runId: run.id })
                    }}
                  >
                    {t('cancel')}
                  </Button>
                )}
                {['interrupted', 'unknown'].includes(run.state) && (
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void send({ action: 'reconcile', runId: run.id })
                    }}
                  >
                    {t('itReconcile')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={unavailable}
                  onClick={() => openFile(`workbench-runs/${run.id}/request.json`)}
                >
                  {t('snapshot')}
                </Button>
                {run.artifacts.includes(`workbench-runs/${run.id}/validation.json`) && (
                  <Button
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => openFile(`workbench-runs/${run.id}/validation.json`)}
                  >
                    {t('issues')}
                  </Button>
                )}
                {isTerminalItemizationState(run.state) && (
                  <Button
                    variant="outline"
                    disabled={disabled}
                    aria-expanded={deleteTarget === run.id}
                    onClick={() => setDeleteTarget(current => current === run.id ? undefined : run.id)}
                  >
                    {t('itDeleteRun')}
                  </Button>
                )}
              </div>
              {deleteTarget === run.id && isTerminalItemizationState(run.state) && (
                <div
                  className={`${ui.notice} ${ui.deleteConfirmation}`}
                  data-tone="warning"
                >
                  <p>
                    {t('itDeleteRunHint')}
                  </p>
                  <div className={css.actions}>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDeleteTarget(undefined)}
                    >
                      {t('itKeepRun')}
                    </Button>
                    <Button
                      variant="outline"
                      className={ui.deleteAction}
                      disabled={disabled}
                      onClick={() => {
                        void send({ action: 'delete-run', runId: run.id })
                      }}
                    >
                      {t('itConfirmDeleteRun')}
                    </Button>
                  </div>
                </div>
              )}
              {run.artifacts.length > 0 && (
                <details className={ui.disclosure}>
                  <summary>
                    {t('artifacts')}
                    {' '}
                    <span className={ui.count}>
                      {run.artifacts.length}
                    </span>
                  </summary>
                  <ArtifactList
                    files={run.artifacts}
                    disabled={unavailable}
                    openFile={openFile}
                  />
                </details>
              )}
            </article>
          ))}
        </div>
        {runs.length > RECENT_RUN_COUNT && (
          <Button
            className={ui.runListToggle}
            variant="outline"
            aria-expanded={showOlderRuns}
            aria-controls={`${uid}-run-list`}
            onClick={() => setShowOlderRuns(current => !current)}
          >
            {showOlderRuns ? t('itCollapseOlderRuns') : t('itExpandOlderRuns', { count: runs.length - RECENT_RUN_COUNT })}
          </Button>
        )}
      </section>
      <section
        className={ui.card}
        aria-labelledby={`${uid}-review`}
      >
        <div className={ui.sectionHeading}>
          <span className={ui.step}>
            03
          </span>
          <div>
            <h3 id={`${uid}-review`}>
              {t('itCandidate')}
            </h3>
            <p>
              {t('itReviewHint')}
            </p>
          </div>
          <span className={ui.count}>
            {candidates.length}
          </span>
        </div>
        <label>
          {t('itSelect')}
          <select
            aria-label={t('itSelect')}
            value={selected}
            disabled={disabled}
            onChange={event => resetReview(event.target.value)}
          >
            <option value="">
              {t('itNoCandidate')}
            </option>
            {candidates.map(item => (
              <option
                key={item.id}
                value={item.id}
              >
                {state?.materials.find(material => material.id === item.materialId)?.label}
                {' · '}
                {item.id}
                {state?.baseline === item.id ? ` · ${t('accepted')}` : ''}
              </option>
            ))}
          </select>
        </label>
        {!candidate && (
          <p className={ui.empty}>
            {t('itSelectHint')}
          </p>
        )}
        {candidate && (
          <>
            <div className={css.actions}>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  void send({ action: 'candidate', candidateId: selected })
                }}
              >
                {t('itRead')}
              </Button>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  void send({ action: 'compare', ...compareFields() })
                }}
              >
                {t('itCompare')}
              </Button>
            </div>
            {state?.baseline === selected && (
              <p
                className={ui.notice}
                data-tone="success"
              >
                {t('itAccepted')}
              </p>
            )}
            {blocked && (
              <div
                className={ui.notice}
                data-tone="warning"
                role="alert"
              >
                <h4>
                  {t('itConflictTitle')}
                </h4>
                <p>
                  {t('itProblem_source-conflict')}
                </p>
              </div>
            )}
            <div className={ui.adjust}>
              <p>
                {t('itAdjustHint')}
              </p>
              <Button
                variant="outline"
                disabled={disabled || liveRuns || !feedback.trim()}
                onClick={() => launch(true)}
              >
                {t('itAdjust')}
              </Button>
            </div>
            {content && (
              <div className={ui.content}>
                <div className={ui.contentHeading}>
                  <h4>
                    {t('itRead')}
                  </h4>
                  <span
                    className={ui.badge}
                    data-tone="active"
                  >
                    {t('itFunctionItems')}
                    {' · '}
                    {content.index.functions.length}
                  </span>
                </div>
                <SegmentedTabs
                  className={ui.tabs}
                  size="sm"
                  label={t('itRead')}
                  value={localView}
                  onChange={setLocalView}
                  items={[
                    { value: 'overview', label: t('itOverviewTab'), id: `${uid}-overview`, panelId: `${uid}-content` },
                    ...(['features', 'seed', 'issues'] as const).map(value => ({
                      value,
                      label: t(({ features: 'itFunctionItems', seed: 'itRelationsTab', issues: 'itChecksTab' } as const)[value]),
                      id: `${uid}-${value}`,
                      panelId: `${uid}-content`,
                    })),
                  ]}
                />
                <div
                  className={ui.tabContent}
                  role="tabpanel"
                  id={`${uid}-content`}
                  aria-labelledby={`${uid}-${localView}`}
                >
                  {localView === 'overview' && (
                    <div className={ui.featureList}>
                      {content.chunks.chunks.filter(item => item.chunk_type !== 'functional_requirement').map(item => (
                        <div
                          className={ui.feature}
                          key={item.chunk_id}
                        >
                          <div>
                            <span className={ui.caption}>
                              {item.chunk_id}
                            </span>
                            <h4>
                              {item.title}
                            </h4>
                          </div>
                          {item.source_relative_path && (
                            <Button
                              variant="outline"
                              disabled={unavailable}
                              onClick={() => openFile(`workbench-runs/${candidate.runId}/candidate/${item.source_relative_path}`)}
                            >
                              {t('itSourceOpen')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {localView === 'features' && (
                    <div className={ui.featureList}>
                      {content.index.functions.map(item => (
                        <div
                          className={ui.feature}
                          key={item.id}
                        >
                          <div>
                            <h4>
                              {item.name}
                            </h4>
                            <p className={ui.caption}>
                              {t('itSourceSections')}
                              {': '}
                              {content.chunks.chunks.find(chunk => chunk.canonical_function_name === item.name)?.source_sections?.map(section => section.section_id).join(' / ') || t('itNotProvided')}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            disabled={unavailable}
                            onClick={() => openFile(item.path)}
                          >
                            {t('itSourceOpen')}
                          </Button>
                        </div>
                      ))}
                      {content.index.functions.length === 0 && (
                        <p className={ui.empty}>
                          {t('itNoFeatures')}
                        </p>
                      )}
                    </div>
                  )}
                  {localView === 'seed' && (
                    <ItemizationReport
                      t={t}
                      kind="seed"
                      value={content.chunks.project_relation_seed}
                    />
                  )}
                  {localView === 'issues' && (
                    <ItemizationReport
                      t={t}
                      kind="validation"
                      value={content.validation}
                    />
                  )}
                </div>
              </div>
            )}
            {comparison && (
              <section
                className={ui.comparison}
                aria-label={t('differences')}
              >
                <h4>
                  {t('differences')}
                </h4>
                <div className={ui.diffGrid}>
                  {(['added', 'deleted', 'renamed', 'changed', 'affected'] as const).map(key => (
                    <div
                      className={ui.diffGroup}
                      data-tone={key === 'deleted' ? 'error' : key === 'added' ? 'success' : 'active'}
                      key={key}
                    >
                      <div className={ui.contentHeading}>
                        <h4>
                          {t(({ added: 'itAdded', deleted: 'itDeleted', renamed: 'itRenamed', changed: 'itChanged', affected: 'itAffected' } as const)[key])}
                        </h4>
                        <span
                          className={ui.badge}
                          data-tone={key === 'deleted' ? 'error' : key === 'added' ? 'success' : 'active'}
                        >
                          {comparison[key].length}
                        </span>
                      </div>
                      <ul>
                        {comparison[key].map((item, index) => (
                          <li key={index}>
                            <span>
                              {typeof item === 'string' ? name(item) : `${name(item.previous)} → ${name(item.candidate)}`}
                            </span>
                            <div className={css.actions}>
                              {typeof item === 'string' && path(item) && (
                                <Button
                                  variant="outline"
                                  disabled={unavailable}
                                  onClick={() => openFile(path(item)!)}
                                >
                                  {t('itSourceOpen')}
                                </Button>
                              )}
                              {typeof item !== 'string' && (
                                <>
                                  <Button
                                    variant="outline"
                                    disabled={unavailable || !path(item.previous)}
                                    onClick={() => openFile(path(item.previous)!)}
                                  >
                                    {t('itPrevious')}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={unavailable || !path(item.candidate)}
                                    onClick={() => openFile(path(item.candidate)!)}
                                  >
                                    {t('itCandidate')}
                                  </Button>
                                </>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <p>
                  {t('itRelations')}
                  {': '}
                  {comparison.relationsChanged ? t('stale') : t('current')}
                </p>
                {comparison.details?.previousRelations && (
                  <Button
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => openFile(comparison.details!.previousRelations!)}
                  >
                    {t('itPrevious')}
                  </Button>
                )}
                {comparison.details && (
                  <Button
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => openFile(comparison.details!.candidateRelations)}
                  >
                    {t('seed')}
                  </Button>
                )}
                {comparison.unmatched.map((group, index) => (
                  <fieldset key={index}>
                    <legend>
                      {t('itMatch')}
                    </legend>
                    {group.previous.map(id => (
                      <label key={id}>
                        {name(id)}
                        <select
                          value={matches[id] ?? ''}
                          onChange={event => {
                            setMatches(old => ({ ...old, [id]: event.target.value }))
                            setProof(undefined)
                            setConfirmImpact(false)
                          }}
                        >
                          <option value="">
                            {t('itUnmatched')}
                          </option>
                          {group.candidate.map(next => (
                            <option
                              key={next}
                              value={next}
                            >
                              {name(next)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </section>
            )}
            <div className={ui.adoption}>
              <h4>
                {t('itAdoptionTitle')}
              </h4>
              <p>
                {t('itAdoptionHint')}
              </p>
              {approvalReason && !blocked && (
                <div
                  className={ui.notice}
                  data-tone="warning"
                >
                  <p>
                    {t('itCandidateApprovalTitle')}
                  </p>
                  <p>
                    {approvalReason}
                  </p>
                </div>
              )}
              <label className={ui.checkRow}>
                <input
                  type="checkbox"
                  checked={confirmUnmatched}
                  onChange={event => {
                    setConfirmUnmatched(event.target.checked)
                    setProof(undefined)
                    setConfirmImpact(false)
                  }}
                />
                <span>
                  {t('itConfirmUnmatched')}
                </span>
              </label>
              {proof && (
                <label className={ui.checkRow}>
                  <input
                    type="checkbox"
                    checked={confirmImpact}
                    onChange={event => setConfirmImpact(event.target.checked)}
                  />
                  <span>
                    {t('itConfirmImpact')}
                  </span>
                </label>
              )}
              <Button
                variant="primary"
                disabled={
                  disabled || blocked || !proof || !confirmImpact ||
                  proofRevision !== state?.revision || state?.baseline === selected
                }
                onClick={() => {
                  void send({ action: 'adopt', ...compareFields(), expectedRevision: proofRevision, impactFingerprint: proof })
                }}
              >
                {t('accept')}
              </Button>
            </div>
            <details className={ui.disclosure}>
              <summary>
                {t('artifacts')}
                {' '}
                <span className={ui.count}>
                  {candidate.artifacts.length}
                </span>
              </summary>
              <ArtifactList
                files={candidate.artifacts.map(artifact => artifact.path)}
                disabled={unavailable}
                openFile={openFile}
              />
            </details>
          </>
        )}
      </section>
      <p className={ui.history}>
        {t('itHistory')}
      </p>
    </section>
  )
}

/** @param props - Retained relative paths and the owning resource opener. @returns Full paths that wrap within a narrow pane. */
function ArtifactList({ files, disabled, openFile }: { files: readonly string[]; disabled: boolean; openFile: (path: string) => void }) {
  return (
    <ul className={ui.artifacts}>
      {files.map(file => (
        <li key={file}>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => openFile(file)}
          >
            {file}
          </Button>
        </li>
      ))}
    </ul>
  )
}

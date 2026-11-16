/** Native sidebar presentation; all execution facts arrive from the injected domain object. */
import { useCallback, useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { initialView, type Page, type View } from '../state/view-store.ts'
import type { Operation, Run, Scenario } from '../../shared/workflow.ts'
import type { } from '../i18n/locales.ts'
import css from '../styles/Workbench.module.css'
import { MaterialsForm } from '../features/project/MaterialsForm.tsx'
import { WorkbenchChrome } from '../components/WorkbenchChrome.tsx'
import { latestRun } from '../features/runs/run-selection.ts'
import type { WorkbenchProps } from './workbench-types.ts'
export type { WorkbenchProps, WorkbenchInjected } from './workbench-types.ts'
import { ModelsPanel } from '../features/models/ModelsPanel.tsx'
import { ProjectPanel } from '../features/project/ProjectPanel.tsx'
import { ProjectSummary } from '../features/project/ProjectSummary.tsx'
import { WorkflowOverview } from '../components/WorkflowOverview.tsx'
import { RunHistory, ArtifactList, RemoteConfirmation } from '../features/runs/RunViews.tsx'
import { ItemizationPanel } from '../features/project/ItemizationPanel.tsx'
import { ModelingPanel } from '../features/models/ModelingPanel.tsx'
const EMPTY_RUNS: readonly Run[] = []

/** @param props - Framework-bound hooks, view state and commands. @returns Workspace-following workbench. */
export function Workbench({ t, sessionId, tab, data, useStore, actions, start, act, project, draftChanged, listFiles, itemization, modeling, openModelSession }: WorkbenchProps): ReactNode {
  const bucket = `${sessionId}:${tab.id}:${data.workspace?.workspaceId ?? 'unbound'}`
  const executionRunId = data.phase === 'ready'
    ? data.projectResult?.modelingSessions?.find(session => session.sessionId === sessionId)?.runId
    : undefined
  const fallback = useMemo<View>(() => executionRunId
    ? { ...initialView, page: 'modeling-run', modelingRun: executionRunId }
    : initialView, [executionRunId])
  const view = useStore(s => s.views[bucket]) ?? fallback
  const change = useCallback((patch: Partial<View>) => actions.change(bucket, patch, fallback), [actions, bucket, fallback])
  const hasDraft = view.draft.length > 0 || view.itemizationFeedback.length > 0 || Object.keys(view.modelingDrafts ?? {}).length > 0
  useEffect(() => { draftChanged(bucket, hasDraft, tab.signal) }, [draftChanged, bucket, hasDraft, tab.signal])
  const go = useCallback((page: Page) => change({ page }), [change])
  const selectModel = useCallback((model: string) => change({ model }), [change])
  const toggleDemo = useCallback(() => change({ demo: !view.demo, page: 'flow' }), [change, view.demo])
  const materialFields = useMemo(() => ({ original: view.original, markdown: view.markdown, version: view.version, sameVersion: view.sameVersion }), [view.original, view.markdown, view.version, view.sameVersion])
  const initializing = useRef<string>()
  const initialize = useCallback(() => {
    initializing.current = bucket
    project('initialize', { materials: { ...materialFields, sameVersion: true } })
  }, [project, materialFields, bucket])
  useEffect(() => {
    if (initializing.current !== bucket) { initializing.current = undefined; return }
    if (!data.projectLoading && data.projectResult?.ok && data.projectResult.binding && data.projectResult.project?.materials) {
      initializing.current = undefined
      go('flow')
    }
  }, [bucket, data.projectLoading, data.projectResult, go])
  const openMaterial = useCallback((path: string) => tab.actions.openResource(sessionFileAddress(sessionId, path)), [tab.actions, sessionId])
  const uid = useId()
  const primary = ['models', 'tests', 'graph'].includes(view.page) ? view.page : 'flow'
  const launch = useCallback((operation: Operation) => {
    if (!view.demo) return
    start(operation, view.selected, view.scenario)
    go(operation === 'upload' || operation === 'infer' ? 'confirm' : 'run')
  }, [view.demo, view.selected, view.scenario, start, go])
  const command = (op: Operation) => (
    <Button
      className={css.secondaryButton}
      variant="outline"
      key={op}
      disabled={!view.demo || !view.selected.length}
      onClick={() => launch(op)}
    >
      {t(op)}
    </Button>
  )
  const candidate = useMemo(() => view.page === 'review' ? latestRun(data.runs, r => r.request.operation === 'itemize' || r.request.operation === 'update') : undefined, [view.page, data.runs])
  const activeRuns = view.demo ? data.runs : EMPTY_RUNS
  return (
    <section
      className={css.root}
      aria-label={t('title')}
    >
      {view.draft.length > 0 && (
        <p className={css.draftNotice}>
          {t('unsavedDraft')}
        </p>
      )}
      <WorkbenchChrome
        t={t}
        workspace={data.workspace}
        phase={data.phase}
        baseline={data.baseline}
        demo={view.demo}
        primary={primary}
        uid={uid}
        go={go}
        toggleDemo={toggleDemo}
      />
      <div
        className={css.body}
        role="tabpanel"
        id={`${uid}-body`}
        aria-labelledby={`${uid}-${primary}`}
        data-page={view.page}
      >
        {/* 非主 tab -> 返回流程按钮 */}
        {!['flow', 'models', 'tests', 'graph'].includes(view.page) && (
          <Button
            className={`${css.secondaryButton} ${css.backButton}`}
            variant="outline"
            onClick={() => go('flow')}
          >
            {t('back')}
          </Button>
        )}
        {!view.demo && (
          <ProjectPanel
            t={t}
            phase={data.phase}
            loading={data.projectLoading}
            result={data.projectResult}
            project={project}
            go={go}
          />
        )}
        {!view.demo && ['flow', 'settings', 'artifacts'].includes(view.page) && data.projectResult && (data.projectResult.project || data.projectResult.resources) && (
          <ProjectSummary
            t={t}
            result={data.projectResult}
            openFile={openMaterial}
            unavailable={data.phase !== 'ready' || !data.projectResult.ok}
          />
        )}
        {view.page === 'flow' && (
          <WorkflowOverview
            t={t}
            go={go}
            demo={view.demo}
          />
        )}
        {!view.demo && view.page === 'review' && (
          <h2>
            {t('review')}
          </h2>
        )}
        {!view.demo && view.page === 'run' && (
          <h2>
            {t('run')}
          </h2>
        )}
        {!view.demo && view.page === 'artifacts' && (
          <h2>
            {t('artifacts')}
          </h2>
        )}
        {!view.demo && data.projectResult?.project && ['review', 'run', 'artifacts'].includes(view.page) && (
          <ItemizationPanel
            key={bucket}
            t={t}
            remote={itemization}
            unavailable={data.phase !== 'ready' || !data.projectResult.ok}
            fields={materialFields}
            change={change}
            feedback={view.itemizationFeedback}
            listFiles={listFiles}
            openFile={openMaterial}
          />
        )}
        {view.page === 'settings' && (
          <>
            <h2>
              {t('settings')}
            </h2>
            <p>
              {t('materialHelp')}
            </p>
            {!data.projectResult?.project && (
              <MaterialsForm
                key={bucket}
                t={t}
                listFiles={listFiles}
                openFile={openMaterial}
                fields={materialFields}
                change={change}
                unavailable={view.demo || data.phase !== 'ready'}
                loading={data.projectLoading}
                problem={data.projectResult?.problem}
                initialize={initialize}
              />
            )}
            <label>
              {t('draft')}
              <textarea
                value={view.draft}
                onChange={e => change({ draft: e.target.value })}
              />
            </label>
          </>
        )}
        {view.page === 'review' && view.demo && (
          <>
            <h2>
              {t('review')}
            </h2>
            <div className={css.actions}>
              {command('itemize')}
              {command('update')}
            </div>
            {view.demo && (
              <>
                <h3>
                  {t('overview')}
                </h3>
                <p>
                  {t('sampleOverview')}
                </p>
                <h3>
                  {t('source')}
                </h3>
                <p>
                  {t('sampleSource')}
                </p>
                <h3>
                  {t('seed')}
                </h3>
                <p>
                  {t('sampleRelation')}
                </p>
                <details>
                  <summary>
                    {t('differences')}
                  </summary>
                  <p>
                    {t('differenceDetail')}
                  </p>
                  <p>
                    {t('history')}
                  </p>
                </details>
                <p>
                  {t(data.adopted ? 'accepted' : 'baselinePending')}
                </p>
                <p>
                  {t('reviewPending')}
                </p>
                <Button
                  className={css.primaryButton}
                  variant="primary"
                  disabled={
                    !candidate ||
                    candidate.state !== 'succeeded' ||
                    candidate.validation !== 'passed' ||
                    candidate.review === 'accepted'
                  }
                  onClick={() => candidate && act(candidate.id, 'accept')}
                >
                  {t('accept')}
                </Button>
                <label>
                  {t('draft')}
                  <textarea
                    value={view.draft}
                    onChange={e => change({ draft: e.target.value })}
                  />
                </label>
              </>
            )}
          </>
        )}
        {!view.demo && ['features', 'modeling-run', 'models'].includes(view.page) && (
          <ModelingPanel
            key={bucket}
            t={t}
            view={view}
            change={change}
            remote={modeling}
            openFile={openMaterial}
            openSession={openModelSession}
          />
        )}
        {view.demo && view.page === 'features' && (
          <>
            <h2>
              {t('features')}
            </h2>
            <label>
              {t('search')}
              <Input
                className={css.field}
                value={view.search}
                onChange={e => change({ search: e.target.value })}
              />
            </label>
            {view.demo &&
              ['OnePedal', 'BrakeHold']
                .filter(f => f.toLowerCase().includes(view.search.toLowerCase()))
                .map(f => (
                  <label
                    className={css.row}
                    key={f}
                  >
                    <input
                      type="checkbox"
                      checked={view.selected.includes(f)}
                      onChange={e =>
                        change({
                          selected: e.target.checked
                            ? [...view.selected, f]
                            : view.selected.filter(x => x !== f),
                        })
                      }
                    />
                    {f}
                    <span>
                      {'§3.2.1 · '}
                      {data.baseline}
                    </span>
                  </label>
                ))}
            <p>
              {t('partial')}
            </p>
            <div className={css.actions}>
              {command('model')}
              {command('relations')}
              {command('align')}
              {command('tests')}
            </div>
          </>
        )}
        {view.demo && view.page === 'models' && (
          <>
            <ModelsPanel
              t={t}
              selectedModel={view.model}
              demo={view.demo}
              canRun={view.demo && view.selected.length > 0}
              selectModel={selectModel}
              launch={launch}
            />
            <label>
              {t('draft')}
              <textarea
                value={view.draft}
                onChange={e => change({ draft: e.target.value })}
              />
            </label>
          </>
        )}
        {view.page === 'tests' && (
          <>
            <h2>
              {t('tests')}
            </h2>
            <p>
              {t('coverageUnknown')}
            </p>
            {view.demo && (
              <p>
                {t('coverage')}
              </p>
            )}
            {command('tests')}
            <Button
              className={css.secondaryButton}
              variant="outline"
              onClick={() => go('models')}
            >
              {t('issues')}
            </Button>
          </>
        )}
        {view.page === 'graph' && (
          <>
            <h2>
              {t('graph')}
            </h2>
            <p>
              {t('graphSource')}
            </p>
            <div className={css.actions}>
              {command('ttl')}
              {command('upload')}
              {command('infer')}
              {command('query')}
            </div>
            {view.demo && (
              <>
                <p>
                  {t('sampleRelation')}
                </p>
                <details>
                  <summary>
                    {t('source')}
                  </summary>
                  <p>
                    {t('graphEvidence')}
                  </p>
                  <p>
                    {t('confidence')}
                  </p>
                  <p>
                    {t('graphInferred')}
                  </p>
                </details>
              </>
            )}
          </>
        )}
        {view.page === 'confirm' && (
          <RemoteConfirmation
            runs={activeRuns}
            t={t}
            act={act}
            go={go}
          />
        )}
        {view.page === 'run' && view.demo && (
          <RunHistory
            runs={activeRuns}
            t={t}
            act={act}
            go={go}
          />
        )}
        {view.page === 'artifacts' && view.demo && (
          <ArtifactList
            runs={activeRuns}
            t={t}
          />
        )}
        {view.demo && (
          <label>
            {t('scenario')}
            <select
              value={view.scenario}
              onChange={e =>
                change({ scenario: e.target.value as Scenario })
              }
            >
              {(
                [
                  'success',
                  'alignment',
                  'missing',
                  'unknown',
                  'submitted',
                  'empty',
                  'failure',
                ] as const
              ).map(s => (
                <option
                  key={s}
                  value={s}
                >
                  {t(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!!activeRuns.length && (
        <footer className={css.footer}>
          <Button
            className={css.secondaryButton}
            variant="outline"
            onClick={() => go('run')}
          >
            {t('runSummary', { count: activeRuns.length })}
          </Button>
          <Button
            className={css.secondaryButton}
            variant="outline"
            onClick={() => go('artifacts')}
          >
            {t('artifacts')}
          </Button>
        </footer>
      )}
    </section>
  )
}

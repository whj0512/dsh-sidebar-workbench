/** On-demand history, artifact and authorization views. */
import { memo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Page } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'
import type { Run } from '../../shared/workflow.ts'
import type { WorkbenchInjected } from '../workbench-types.ts'
import { RunCard } from './RunCard.tsx'
import { latestRun } from './run-selection.ts'
type RunViewProps = { runs: readonly Run[]; t: TranslateNS<'sidebarWorkbench'>; act: WorkbenchInjected['act']; go: (page: Page) => void }

/** @param props - Runs in the selected workspace. @returns Run history. */
export const RunHistory = memo(function RunHistory({ runs, t, act, go }: RunViewProps) {
  return (
    <>
      <h2>{t('run')}</h2>
      {runs.length
        ? runs.map(run => (
            <RunCard
              key={run.id}
              run={run}
              t={t}
              act={act}
              go={go}
            />
          ))
        : <p>{t('noRuns')}</p>}
    </>
  )
})

/** @param props - Runs in the selected workspace. @returns Derived artifact list. */
export const ArtifactList = memo(function ArtifactList({ runs, t }: Pick<RunViewProps, 'runs' | 't'>) {
  const artifacts = runs.flatMap(r => r.artifacts.map(a => ({ ...a, runId: r.id })))
  return (
    <>
      <h2>{t('artifacts')}</h2>
      {artifacts.length
        ? artifacts.map(a => (
            <details key={`${a.runId}:${a.name}`}>
              <summary>
                {a.name} · {a.version} · {t(a.freshness)}
              </summary>
              <p>{a.runId} · {t(a.stage)} · {t(a.validation)}</p>
              <p>{t('demoNotice')}</p>
            </details>
          ))
        : <p>{t('noArtifacts')}</p>}
    </>
  )
})

/** @param props - Runs and explicit authorization actions. @returns Latest pending confirmation. */
export const RemoteConfirmation = memo(function RemoteConfirmation({ runs, t, act, go }: RunViewProps) {
  const remoteRun = latestRun(runs, r => r.state === 'waiting-user')
  return (
    <>
      <h2>{t('confirm')}</h2>
      <p>{t('grantHelp')}</p>
      <p>{t('grantBinding')}</p>
      {remoteRun && (
        <>
          <h3>{t(remoteRun.request.operation)}</h3>
          <p>
            {t('target')}: {remoteRun.request.target} / {remoteRun.request.repository}
          </p>
          <p>
            {remoteRun.request.inputs.version} · {remoteRun.request.inputs.fingerprint} ·{' '}
            {remoteRun.request.scope.join(', ')}
          </p>
          <Button
            className={css.primaryButton}
            variant="primary"
            onClick={() => {
              act(remoteRun.id, 'grant')
              go('run')
            }}
          >
            {t('grant')}
          </Button>
          <Button
            className={css.secondaryButton}
            variant="outline"
            onClick={() => {
              act(remoteRun.id, 'cancel')
              go('run')
            }}
          >
            {t('cancel')}
          </Button>
        </>
      )}
    </>
  )
})

/** Current workspace identity and explicit Host project commands. */
import { memo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Page } from '../../state/view-store.ts'
import css from '../../styles/Workbench.module.css'
import type { DataSnapshot } from '../../state/data.ts'
import type { WorkbenchInjected } from '../../app/workbench-types.ts'

function RelinkConfirmation({ t, result, project, loading }: Pick<Parameters<typeof ProjectPanel>[0], 't' | 'result' | 'project' | 'loading'>) {
  const [confirmed, setConfirmed] = useState(false)
  const relink = result?.relink
  if (!relink) return null
  return <section aria-label={t('relink')}>
    <h3>{t('relink')}</h3>
    <p className={css.path}>{t('previousBinding')}: {relink.previousWorkspaceId} · {relink.previousRoot}</p>
    <p className={css.path}>{t('nextBinding')}: {relink.nextWorkspaceId} · {relink.nextRoot}</p>
    <p>{t('bindingRevision')}: {relink.revision} → {relink.revision + 1}</p>
    <p>{t(relink.unsettled ? 'problem_unsettled' : 'noUnsettledRuns')}</p>
    <label className={css.row}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('confirmRelink')}</label>
    <Button disabled={loading || !confirmed || relink.unsettled} onClick={() => project('relink', {
      expectedProjectId: result?.project?.projectId, expectedRevision: relink.revision,
    })}>{t('relink')}</Button>
  </section>
}

/** @param props - Project facts, independent of draft and demo run state. @returns Project status and actions. */
export const ProjectPanel = memo(function ProjectPanel({ t, phase, loading, result, project, go }: { t: TranslateNS<'sidebarWorkbench'>; phase: DataSnapshot['phase']; loading: boolean; result: DataSnapshot['projectResult']; project: WorkbenchInjected['project']; go: (page: Page) => void }) {
  return (
    <div className={css.card} data-page="P00">
      <h2>{t("workspaceHeading")}</h2>
      <p aria-live="polite" aria-atomic="true">
        {t(phase === 'ready' ? loading ? 'loading' : result?.project ? 'not-checked' : 'materialHelp' : phase)}
      </p>
      {result?.problem && (
        <p role="alert">{t(`problem_${result.problem}`)}</p>
      )}
      {result?.project && (
        <p aria-live="polite" aria-atomic="true">
          {result.project.projectId} · {result.project.baseline ?? t('not-checked')}
        </p>
      )}
      {phase === 'ready' && (
        <>
          <div className={css.actions}>
            {result?.ok && result.project?.materials && !result.binding && <Button disabled={loading} onClick={() => project('initialize', { materials: result.project!.materials! })}>{t('recoverBinding')}</Button>}
            {!result?.project && (
              <Button
                className={css.primaryButton}
                variant="primary"
                disabled={loading}
                onClick={() => go('settings')}
              >
                {t('initialize')}
              </Button>
            )}
            <Button
              className={css.secondaryButton}
              variant="outline"
              disabled={loading}
              onClick={() => project('inspect')}
            >
              {t('refresh')}
            </Button>
          </div>
          {result?.problem === 'relink' && <RelinkConfirmation key={`${result.project?.projectId}:${result.relink?.revision}:${result.relink?.nextRoot}`} t={t} result={result} project={project} loading={loading} />}
          <details>
            <summary>{t('relink')}</summary>
            <p>{t('relinkHelp')}</p>
          </details>
        </>
      )}
    </div>
  )
})

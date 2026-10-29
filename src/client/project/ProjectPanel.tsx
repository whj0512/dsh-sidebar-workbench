/** Current workspace identity and explicit Host project commands. */
import { memo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Page } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'
import type { DataSnapshot } from '../state/data.ts'
import type { WorkbenchInjected } from '../workbench-types.ts'

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
              onClick={() => project('discover')}
            >
              {t('identify')}
            </Button>
            <Button
              className={css.secondaryButton}
              variant="outline"
              disabled={loading}
              onClick={() => project('inspect')}
            >
              {t('refresh')}
            </Button>
          </div>
          {result?.discovered?.map(a => (
            <p key={a.path}>
              {a.path} · {t(a.status)} · {t(a.validation)}
            </p>
          ))}
          {result?.discovered?.some(a => a.status === 'recognized') && (
            <Button
              className={css.secondaryButton}
              variant="outline"
              disabled={loading}
              onClick={() => project('adopt')}
            >
              {t('adoptDiscovery')}
            </Button>
          )}
          {result?.problem === 'relink' && (
            <Button
              className={css.secondaryButton}
              variant="outline"
              disabled={loading}
              onClick={() =>
                project('relink', {
                  expectedProjectId: result?.project?.projectId,
                })
              }
            >
              {t('relink')}
            </Button>
          )}
          <details>
            <summary>{t('relink')}</summary>
            <p>{t('relinkHelp')}</p>
          </details>
        </>
      )}
    </div>
  )
})

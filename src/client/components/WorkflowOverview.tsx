/** Navigation through the three existing workflow stages. */
import { memo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Page } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'

/** @param props - Localized copy and navigation. @returns Workflow overview. */
export const WorkflowOverview = memo(function WorkflowOverview({ t, go }: { t: TranslateNS<'sidebarWorkbench'>; go: (page: Page) => void }) {
  return (
    <>
      <p className={css.flowHint}>{t('next')}</p>
      <div className={css.pipeline}>
        <article className={css.pipelineStep}>
          <span className={css.stepNumber} aria-hidden="true">
            01
          </span>
          <div className={css.stepContent}>
            <h2>{t('stageOne')}</h2>
            <p>{t('stageOneHint')}</p>
            <Button
              className={css.secondaryButton}
              variant="outline"
              onClick={() => go('review')}
            >
              {t('review')}
            </Button>
          </div>
        </article>
        <article className={css.pipelineStep}>
          <span className={css.stepNumber} aria-hidden="true">
            02
          </span>
          <div className={css.stepContent}>
            <h2>{t('stageTwo')}</h2>
            <p>{t('stageTwoHint')}</p>
            <Button
              className={css.secondaryButton}
              variant="outline"
              onClick={() => go('features')}
            >
              {t('features')}
            </Button>
          </div>
        </article>
        <article className={css.pipelineStep}>
          <span className={css.stepNumber} aria-hidden="true">
            03
          </span>
          <div className={css.stepContent}>
            <h2>{t('stageThree')}</h2>
            <p>{t('stageThreeHint')}</p>
            <Button
              className={css.secondaryButton}
              variant="outline"
              onClick={() => go('graph')}
            >
              {t('graph')}
            </Button>
          </div>
        </article>
      </div>
    </>
  )
})

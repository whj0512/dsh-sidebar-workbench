/** Model selection and read-only preview, independent of the revision draft. */
import { memo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Operation } from '../../shared/workflow.ts'
import css from '../styles/Workbench.module.css'
const MODEL_KINDS = ['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'] as const

/** @param props - Model display facts and explicit commands. @returns Model controls and evidence. */
export const ModelsPanel = memo(function ModelsPanel({ t, selectedModel, demo, canRun, selectModel, launch }: {
 t: TranslateNS<'sidebarWorkbench'>; selectedModel: string; demo: boolean; canRun: boolean; selectModel: (model: string) => void; launch: (operation: Operation) => void
}) {
  const command = (operation: Operation) => <Button className={css.secondaryButton} variant="outline" disabled={!canRun} onClick={() => launch(operation)}>{t(operation)}</Button>
  return <><h2>{t('models')}</h2><p>{t('modelReadOnly')}</p><div className={css.actions}>{MODEL_KINDS.map(model => <Button className={selectedModel === model ? css.primaryButton : css.secondaryButton} variant={selectedModel === model ? "primary" : "toolbar"} key={model} aria-pressed={selectedModel === model} onClick={() => selectModel(model)}>{model}</Button>)}</div>
        {demo && <><h3>{selectedModel}</h3><pre>{t('modelSample')}</pre><details><summary>{t('source')}</summary><p>{t('sampleSource')}</p></details><p>{t('alignmentHelp')}</p></>}
        <div className={css.actions}>{command('align')}{command('relations')}</div>
      </>
})

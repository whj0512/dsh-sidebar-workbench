/** A run's stages and controls, isolated from navigation and draft edits. */
import { memo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Page } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'
import type { Run } from '../../shared/workflow.ts'
import type { WorkbenchInjected } from '../workbench-types.ts'

/** @param props - One immutable run and its explicit actions. @returns Run details. */
export const RunCard = memo(function RunCard({ run: r, t, act, go }: { run: Run; t: TranslateNS<'sidebarWorkbench'>; act: WorkbenchInjected['act']; go: (page: Page) => void }) {
  return <article className={css.card}>
    <h3>{t(r.request.operation)} · {r.request.scope.join(', ')}</h3>
    <p className={css.muted}>{r.id} · {r.request.inputs.version} · {r.attempt}/{r.sequence}</p>
    <p className={css.runState} aria-label={t('dimensions')} aria-live="polite" aria-atomic="true">{t(r.state)} / {t(r.validation)} / {t(r.review)} / {t(r.freshness)}</p>
    <ol className={css.stages}>{r.stages.map(s => <li key={s.stage}>{t(s.stage)} <span>{t(s.state)}</span></li>)}</ol>
    {r.issues.map(issue => <p role="alert" key={issue}>{t(issue === 'alignment' ? 'alignmentHelp' : issue as 'missing')}</p>)}
    {r.committed && <p>{t('committed')}</p>}
    {r.state === 'unknown' && <p>{t('unknownHelp')}</p>}
    {r.request.scenario === 'empty' && r.state === 'succeeded' && <p>{t('noResults')}</p>}
    <details><summary>{t('snapshot')}</summary><pre>{JSON.stringify({ ...r.request.binding, version: r.request.inputs.version, output: r.output }, null, 2)}</pre></details>
    <div className={css.actions}>
      {['queued', 'running'].includes(r.state) && <Button className={css.secondaryButton} variant="outline" onClick={() => act(r.id, 'advance')}>{t('advance')}</Button>}
      {['queued', 'running', 'blocked', 'waiting-user'].includes(r.state) && <Button className={css.secondaryButton} variant="outline" onClick={() => act(r.id, 'cancel')}>{t('cancel')}</Button>}
      {r.state === 'cancelling' && <Button className={css.secondaryButton} variant="outline" onClick={() => act(r.id, 'confirmCancel')}>{t('confirmCancel')}</Button>}
      {['failed', 'cancelled'].includes(r.state) && <Button className={css.secondaryButton} variant="outline" onClick={() => act(r.id, 'retry')}>{t('retry')}</Button>}
      {['unknown', 'interrupted'].includes(r.state) && <Button className={css.secondaryButton} variant="outline" onClick={() => act(r.id, 'reconcile')}>{t('reconcile')}</Button>}
      {r.review === 'pending' && <Button className={css.secondaryButton} variant="outline" disabled={r.state !== 'succeeded' || r.validation !== 'passed'} onClick={() => { act(r.id, 'accept'); go('review') }}>{t('accept')}</Button>}
      {r.state === 'waiting-user' && <Button className={css.secondaryButton} variant="outline" onClick={() => go('confirm')}>{t('confirm')}</Button>}
    </div>
  </article>
})

/** Native sidebar presentation; all execution facts arrive from the injected domain object. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Input, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchData } from './data.ts'
import { initialView, type Page, type ViewStore } from './view-store.ts'
import type { Operation, Run, Scenario } from '../shared/workflow.ts'
import type { ProjectCommand } from '../shared/project.ts'
import type {} from './locales.ts'
import css from './Workbench.module.css'

/** Bound once per Session by the Slot registration. */
export interface WorkbenchInjected {
  hooks: { workbench: ReturnType<WorkbenchData['source']> }
  start: (operation: Operation, scope: readonly string[], scenario: Scenario) => void
  act: WorkbenchData['act']
  project: (action: ProjectCommand['action'], fields?: Pick<ProjectCommand, 'materials' | 'expectedProjectId'>) => void
}
export type WorkbenchProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsStore<ViewStore>
  & PropsLocale<'sidebarWorkbench'> & InjectFace<WorkbenchInjected>

/** @param props - Framework-bound hooks, view state and commands. @returns Workspace-following workbench. */
export function Workbench({ t, useTabInfo, useWorkbench, useStore, actions, start, act, project }: WorkbenchProps): ReactNode {
  const data = useWorkbench(s => s)
  const { tab } = useTabInfo()
  const bucket = `${tab.id}:${data.workspace?.workspaceId ?? 'unbound'}`
  const view = useStore(s => s.views[bucket] ?? initialView)
  const change = (patch: Partial<typeof view>) => actions.change(bucket, patch)
  const go = (page: Page) => change({ page })
  const [menu, setMenu] = useState(false)
  const uid = useId()
  const primary = ['models', 'tests', 'graph'].includes(view.page) ? view.page : 'flow'
  const launch = (operation: Operation) => {
    if (!view.demo) return
    start(operation, view.selected, view.scenario)
    go(operation === 'upload' || operation === 'infer' ? 'confirm' : 'run')
  }
  const command = (op: Operation) => <Button key={op} variant="outline" disabled={!view.demo || !view.selected.length} onClick={() => launch(op)}>{t(op)}</Button>
  const candidate = [...data.runs].reverse().find(r => ['itemize', 'update'].includes(r.request.operation))
  const activeRuns = view.demo ? data.runs : []
  const remoteRun = [...activeRuns].reverse().find(r => r.state === 'waiting-user')
  const artifacts = activeRuns.flatMap(r => r.artifacts.map(a => ({ ...a, runId: r.id })))
  const renderRun = (r: Run) => <article className={css.card} key={r.id}>
    <h3>{t(r.request.operation)} · {r.request.scope.join(', ')}</h3>
    <p className={css.muted}>{r.id} · {r.request.inputs.version} · {r.attempt}/{r.sequence}</p>
    <p aria-label={t('dimensions')}>{t(r.state)} / {t(r.validation)} / {t(r.review)} / {t(r.freshness)}</p>
    <ol className={css.stages}>{r.stages.map(s => <li key={s.stage}>{t(s.stage)} <span>{t(s.state)}</span></li>)}</ol>
    {r.issues.map(issue => <p role="alert" key={issue}>{t(issue === 'alignment' ? 'alignmentHelp' : issue as 'missing')}</p>)}
    {r.committed && <p>{t('committed')}</p>}
    {r.state === 'unknown' && <p>{t('unknownHelp')}</p>}
    {r.request.scenario === 'empty' && r.state === 'succeeded' && <p>{t('noResults')}</p>}
    <details><summary>{t('snapshot')}</summary><pre>{JSON.stringify({ ...r.request.binding, version: r.request.inputs.version, output: r.output }, null, 2)}</pre></details>
    <div className={css.actions}>
      {['queued', 'running'].includes(r.state) && <Button onClick={() => act(r.id, 'advance')}>{t('advance')}</Button>}
      {['queued', 'running', 'blocked', 'waiting-user'].includes(r.state) && <Button onClick={() => act(r.id, 'cancel')}>{t('cancel')}</Button>}
      {r.state === 'cancelling' && <Button onClick={() => act(r.id, 'confirmCancel')}>{t('confirmCancel')}</Button>}
      {['failed', 'cancelled'].includes(r.state) && <Button onClick={() => act(r.id, 'retry')}>{t('retry')}</Button>}
      {['unknown', 'interrupted'].includes(r.state) && <Button onClick={() => act(r.id, 'reconcile')}>{t('reconcile')}</Button>}
      {r.review === 'pending' && <Button disabled={r.state !== 'succeeded' || r.validation !== 'passed'} onClick={() => { act(r.id, 'accept'); go('review') }}>{t('accept')}</Button>}
      {r.state === 'waiting-user' && <Button onClick={() => go('confirm')}>{t('confirm')}</Button>}
    </div>
  </article>
  return <section className={css.root} aria-label={t('title')}>
    <header className={css.header}>
      <div><h1>{t('title')}</h1><p>{data.workspace?.title ?? t(data.phase === 'ready' ? 'unbound' : data.phase)}</p></div>
      <Menu anchor={<Button onClick={() => setMenu(!menu)} aria-expanded={menu}>{t('more')}</Button>} open={menu} onClose={() => setMenu(false)} portal items={(['settings', 'review', 'run', 'artifacts'] as const).map(id => ({ id, label: t(id) }))}
        onSelect={id => { go(id as Page); setMenu(false) }} />
    </header>
    {data.workspace && <details><summary>{t('root')}</summary><p className={css.path}>{data.workspace.path}</p></details>}
    <div className={css.mode}><Button variant="outline" onClick={() => change({ demo: !view.demo, page: 'flow' })}>{t(view.demo ? 'production' : 'demo')}</Button>
      {view.demo && <span>{t('version')}: {data.baseline}</span>}</div>
    <p className={css.notice} role="status">{t(view.demo ? 'demoNotice' : 'unavailable')}</p>
    <SegmentedTabs label={t('title')} value={primary} onChange={page => go(page as Page)} items={[
      { value: 'flow', label: t('flow'), id: `${uid}-flow`, panelId: `${uid}-body` },
      { value: 'models', label: t('models'), id: `${uid}-models`, panelId: `${uid}-body` },
      { value: 'tests', label: t('tests'), id: `${uid}-tests`, panelId: `${uid}-body` },
      { value: 'graph', label: t('graph'), id: `${uid}-graph`, panelId: `${uid}-body` },
    ]} />
    <div className={css.body} role="tabpanel" id={`${uid}-body`} aria-labelledby={`${uid}-${primary}`} data-page={view.page}>
      {!['flow', 'models', 'tests', 'graph'].includes(view.page) && <Button onClick={() => go('flow')}>{t('back')}</Button>}
      {!view.demo && <div className={css.card} data-page="P00">
        <p>{t(data.phase === 'ready' ? data.projectLoading ? 'loading' : data.projectResult?.project ? 'not-checked' : 'materialHelp' : data.phase)}</p>
        {data.projectResult?.problem && <p role="alert">{t(`problem_${data.projectResult.problem}`)}</p>}
        {data.projectResult?.project && <p>{data.projectResult.project.projectId} · {data.projectResult.project.baseline ?? t('not-checked')}</p>}
        {data.phase === 'ready' && <><div className={css.actions}>
          {!data.projectResult?.project && <Button disabled={data.projectLoading} onClick={() => go('settings')}>{t('initialize')}</Button>}
          <Button disabled={data.projectLoading} onClick={() => project('discover')}>{t('identify')}</Button><Button disabled={data.projectLoading} onClick={() => project('inspect')}>{t('refresh')}</Button></div>
          {data.projectResult?.discovered?.map(a => <p key={a.path}>{a.path} · {t(a.status)} · {t(a.validation)}</p>)}
          {data.projectResult?.discovered?.some(a => a.status === 'recognized') && <Button disabled={data.projectLoading} onClick={() => project('adopt')}>{t('adoptDiscovery')}</Button>}
          {data.projectResult?.problem === 'relink' && <Button disabled={data.projectLoading} onClick={() => project('relink', { expectedProjectId: data.projectResult?.project?.projectId })}>{t('relink')}</Button>}
          <details><summary>{t('relink')}</summary><p>{t('relinkHelp')}</p></details></>}
      </div>}
      {view.page === 'flow' && <>
        <p>{t('next')}</p>
        <div className={css.pipeline}>
          <article className={css.card}><h2>{t('stageOne')}</h2><p>{t('stageOneHint')}</p><Button onClick={() => go('review')}>{t('review')}</Button></article>
          <article className={css.card}><h2>{t('stageTwo')}</h2><p>{t('stageTwoHint')}</p><Button onClick={() => go('features')}>{t('features')}</Button></article>
          <article className={css.card}><h2>{t('stageThree')}</h2><p>{t('stageThreeHint')}</p><Button onClick={() => go('graph')}>{t('graph')}</Button></article>
        </div>
      </>}
      {view.page === 'settings' && <><h2>{t('settings')}</h2><p>{t('materialHelp')}</p>
        <label>{t('original')}<Input value={view.original} onChange={e => change({ original: e.target.value })} /></label>
        <label>{t('markdown')}<Input value={view.markdown} onChange={e => change({ markdown: e.target.value })} /></label>
        <label>{t('version')}<Input value={view.version} onChange={e => change({ version: e.target.value })} /></label>
        <label className={css.row}><input type="checkbox" checked={view.sameVersion} onChange={e => change({ sameVersion: e.target.checked })} />{t('sameVersion')}</label>
        <Button disabled={view.demo || data.phase !== 'ready' || data.projectLoading || !view.original || !view.markdown || !view.version || !view.sameVersion} onClick={() => project('initialize', { materials: { original: view.original, markdown: view.markdown, version: view.version, sameVersion: true } })}>{t('initialize')}</Button>
        <label>{t('draft')}<textarea value={view.draft} onChange={e => change({ draft: e.target.value })} /></label></>}
      {view.page === 'review' && <><h2>{t('review')}</h2><div className={css.actions}>{command('itemize')}{command('update')}</div>
        {view.demo && <><h3>{t('overview')}</h3><p>{t('sampleOverview')}</p><h3>{t('source')}</h3><p>{t('sampleSource')}</p>
          <h3>{t('seed')}</h3><p>{t('sampleRelation')}</p><details><summary>{t('differences')}</summary><p>{t('differenceDetail')}</p><p>{t('history')}</p></details>
          <p>{t(data.adopted ? 'accepted' : 'baselinePending')}</p><p>{t('reviewPending')}</p>
          <Button disabled={!candidate || candidate.state !== 'succeeded' || candidate.validation !== 'passed' || candidate.review === 'accepted'} onClick={() => candidate && act(candidate.id, 'accept')}>{t('accept')}</Button>
          <label>{t('draft')}<textarea value={view.draft} onChange={e => change({ draft: e.target.value })} /></label></>}
      </>}
      {view.page === 'features' && <><h2>{t('features')}</h2><label>{t('search')}<Input value={view.search} onChange={e => change({ search: e.target.value })} /></label>
        {view.demo && ['OnePedal', 'BrakeHold'].filter(f => f.toLowerCase().includes(view.search.toLowerCase())).map(f => <label className={css.row} key={f}>
          <input type="checkbox" checked={view.selected.includes(f)} onChange={e => change({ selected: e.target.checked ? [...view.selected, f] : view.selected.filter(x => x !== f) })} />{f}<span>§3.2.1 · {data.baseline}</span></label>)}
        <p>{t('partial')}</p><div className={css.actions}>{command('model')}{command('relations')}{command('align')}{command('tests')}</div>
      </>}
      {view.page === 'models' && <><h2>{t('models')}</h2><p>{t('modelReadOnly')}</p><div className={css.actions}>{['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'].map(model => <Button key={model} aria-pressed={view.model === model} onClick={() => change({ model })}>{model}</Button>)}</div>
        {view.demo && <><h3>{view.model}</h3><pre>{t('modelSample')}</pre><details><summary>{t('source')}</summary><p>{t('sampleSource')}</p></details><p>{t('alignmentHelp')}</p></>}
        <div className={css.actions}>{command('align')}{command('relations')}</div><label>{t('draft')}<textarea value={view.draft} onChange={e => change({ draft: e.target.value })} /></label>
      </>}
      {view.page === 'tests' && <><h2>{t('tests')}</h2><p>{t('coverageUnknown')}</p>{view.demo && <p>{t('coverage')}</p>}{command('tests')}<Button onClick={() => go('models')}>{t('issues')}</Button></>}
      {view.page === 'graph' && <><h2>{t('graph')}</h2><p>{t('graphSource')}</p><div className={css.actions}>{command('ttl')}{command('upload')}{command('infer')}{command('query')}</div>
        {view.demo && <><p>{t('sampleRelation')}</p><details><summary>{t('source')}</summary><p>{t('graphEvidence')}</p><p>{t('confidence')}</p><p>{t('graphInferred')}</p></details></>}
      </>}
      {view.page === 'confirm' && <><h2>{t('confirm')}</h2><p>{t('grantHelp')}</p><p>{t('grantBinding')}</p>
        {remoteRun && <><h3>{t(remoteRun.request.operation)}</h3><p>{t('target')}: {remoteRun.request.target} / {remoteRun.request.repository}</p>
          <p>{remoteRun.request.inputs.version} · {remoteRun.request.inputs.fingerprint} · {remoteRun.request.scope.join(', ')}</p>
          <Button variant="primary" onClick={() => { act(remoteRun.id, 'grant'); go('run') }}>{t('grant')}</Button><Button onClick={() => { act(remoteRun.id, 'cancel'); go('run') }}>{t('cancel')}</Button></>}
      </>}
      {view.page === 'run' && <><h2>{t('run')}</h2>{activeRuns.length ? activeRuns.map(renderRun) : <p>{t('noRuns')}</p>}</>}
      {view.page === 'artifacts' && <><h2>{t('artifacts')}</h2>{artifacts.length ? artifacts.map(a => <details key={`${a.runId}:${a.name}`}><summary>{a.name} · {a.version} · {t(a.freshness)}</summary><p>{a.runId} · {t(a.stage)} · {t(a.validation)}</p><p>{t('demoNotice')}</p></details>) : <p>{t('noArtifacts')}</p>}</>}
      {view.demo && <label>{t('scenario')}<select value={view.scenario} onChange={e => change({ scenario: e.target.value as Scenario })}>
        {(['success', 'alignment', 'missing', 'unknown', 'submitted', 'empty', 'failure'] as const).map(s => <option key={s} value={s}>{t(s)}</option>)}</select></label>}
    </div>
    {!!activeRuns.length && <footer className={css.footer}><Button onClick={() => go('run')}>{t('runSummary', { count: activeRuns.length })}</Button><Button onClick={() => go('artifacts')}>{t('artifacts')}</Button></footer>}
  </section>
}

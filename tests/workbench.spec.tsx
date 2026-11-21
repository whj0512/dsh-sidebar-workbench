/** Native page behavior with real view store and demo domain; no Host or model is impersonated. */
import { useSyncExternalStore } from 'react'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Workbench as WorkbenchContent, type WorkbenchProps as ContentProps } from '../src/client/app/Workbench.tsx'
import type { WorkbenchSeatRuntime } from '../src/client/app/workbench-types.ts'
import { DraftGuard } from '../src/client/state/draft-guard.ts'
import { WorkbenchData } from '../src/client/state/data.ts'
import { createViewStore } from '../src/client/state/view-store.ts'
import { en, zh } from '../src/client/i18n/locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelingRunView } from '../src/shared/modeling-api.ts'

afterEach(cleanup)
type WorkbenchProps = WorkbenchSeatRuntime & Pick<ContentProps, 'useStore' | 'actions' | 't'>
function Workbench(props: WorkbenchProps) {
  const data = props.useWorkbench(snapshot => snapshot)
  const { tab } = props.useTabInfo()
  return (
    <WorkbenchContent
      {...props}
      data={data}
      tab={tab}
    />
  )
}
function tabInfo(id: string, signal: AbortSignal): ReturnType<WorkbenchProps['useTabInfo']> {
  return { sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane' as ReturnType<WorkbenchProps['useTabInfo']>['panel']['id'] },
    tab: { id: id as ReturnType<WorkbenchProps['useTabInfo']>['tab']['id'], kind: 'sidebar-workbench', contentId: '', title: 'Workbench', visible: true, signal,
      navigation: { address: '', params: undefined, revision: 0 }, actions: { bindCommands: () => () => {}, openResource: () => {}, openTab: () => {}, close: () => {} } } }
}
const translator = (dictionary: typeof zh): TranslateNS<'sidebarWorkbench'> => (key, params) => {
  const template = dictionary[key as keyof typeof dictionary] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}
function fixture(dictionary = en) {
  const workspace = createSnapshotStore<WorkspaceSnapshot>({ items: [], state: 'idle', phase: 'ready', error: null, archivedSessionIds: [], pinnedSessionIds: [] })
  const data = new WorkbenchData({ list: workspace })
  const store = createViewStore().create()
  const source = data.source('s1')
  const tabLifetime = new AbortController()
  const props = {
    sessionId: 's1',
    usePanelInfo: () => { throw new Error('Panel information is not read by the workbench') },
    draftChanged: () => {}, t: translator(dictionary), useTabInfo: () => tabInfo('tab1', tabLifetime.signal),
    useWorkbench: (selector: (s: ReturnType<typeof source.getSnapshot>) => unknown) => selector(useSyncExternalStore(source.subscribe, source.getSnapshot)),
    useStore: (selector: (s: ReturnType<typeof store.getSnapshot>) => unknown) => selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions, start: (op, scope, scenario) => { data.start('s1', op, scope, scenario) },
    act: (id, action) => data.act(id, action), project: () => {},
  } as WorkbenchProps
  return { data, props, workspace, tabLifetime }
}
it('keeps model previews stable while editing drafts and refreshes translated panels without losing view state', () => {
  const f = fixture()
  const t = vi.fn(f.props.t)
  const draftChanged = vi.fn()
  const props = { ...f.props, t, draftChanged }
  const body = render(<Workbench {...props} />)
  try {
    fireEvent.click(screen.getByRole('button', { name: en.demo }))
    fireEvent.click(screen.getByRole('tab', { name: en.models }))
    fireEvent.click(screen.getByRole('button', { name: 'Statechart' }))
    const previewCalls = () => t.mock.calls.filter(([key]) => key === 'modelReadOnly').length
    const before = previewCalls()
    fireEvent.change(screen.getByLabelText(en.draft), { target: { value: 'First' } })
    fireEvent.change(screen.getByLabelText(en.draft), { target: { value: 'Revised' } })
    expect(previewCalls()).toBe(before)
    expect(draftChanged.mock.calls.map(([, dirty]) => dirty)).toEqual([false, true])
    body.rerender(<Workbench {...props} t={translator(zh)} />)
    expect(screen.getByText(zh.modelReadOnly)).toBeTruthy()
    expect(screen.queryByText(en.modelReadOnly)).toBeNull()
    expect(screen.getByRole('button', { name: 'Statechart' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText(zh.draft) as HTMLTextAreaElement).value).toBe('Revised')
    fireEvent.change(screen.getByLabelText(zh.draft), { target: { value: '' } })
    expect(draftChanged.mock.calls.map(([, dirty]) => dirty)).toEqual([false, true, false])
  } finally { f.data.dispose() }
})
it.each([en, zh])('shows production unavailability and all four keyboard-accessible tabs', dictionary => {
  const f = fixture(dictionary); render(<Workbench {...f.props} />)
  expect(screen.getByRole('status').textContent).toBe(dictionary.unavailable)
  expect(screen.getAllByText(dictionary.unbound)).toBeTruthy()
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  fireEvent.keyDown(screen.getByRole('tab', { name: dictionary.flow }), { key: 'ArrowRight' })
  expect(screen.getByRole('tab', { name: dictionary.models }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText(dictionary.modelingUnavailable)).toBeTruthy()
  expect(screen.queryByText(dictionary.modelSample)).toBeNull()
  f.data.dispose()
})
it('demonstrates a run without production writes and retains facts across body remount', () => {
  const f = fixture(); const body = render(<Workbench {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: en.demo }))
  fireEvent.click(screen.getByRole('button', { name: en.features }))
  fireEvent.click(screen.getByRole('button', { name: en.model }))
  expect(screen.getByRole('button', { name: en.advance })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.advance }))
  body.unmount(); render(<Workbench {...f.props} />)
  expect(screen.getByRole('button', { name: en.cancel })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(screen.getByRole('button', { name: en.confirmCancel })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.confirmCancel }))
  expect(f.data.executor.list()[0]?.state).toBe('cancelled'); f.data.dispose()
})
it('distinguishes pending workspace membership from unbound', () => {
  const f = fixture(); render(<Workbench {...f.props} />)
  act(() => f.workspace.set({ ...f.workspace.getSnapshot(), phase: 'pending', state: 'loading' }))
  expect(screen.getAllByText(en.loading).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: en.initialize })).toBeNull(); f.data.dispose()
})

it('opens only the matching modeling run in its execution Session and keeps itemization under its own entry', async () => {
  const { props, data, workspace, tabLifetime } = fixture()
  const feature = { id: randomUUID(), name: 'Drive', requirementId: 'UserReq.001' }
  const secondFeature = { id: randomUUID(), name: 'Brake', requirementId: 'UserReq.002' }
  const features = [feature, secondFeature]
  const baseline = { id: randomUUID(), label: 'V1' }
  const executionSessionId = 'model-execution'
  const run: ModelingRunView = {
    id: randomUUID(), baselineId: baseline.id, materialLabel: baseline.label, feature, executionSessionId,
    state: 'running', stage: 'parse', sequence: 1, updatedAt: '2026-11-14T00:00:00.000Z', completed: ['snapshot'], artifacts: [], stale: false,
  }
  const newerRun = { ...run, id: randomUUID(), feature: secondFeature, executionSessionId: 'other-execution' }
  const ws: WorkspaceView = {
    workspaceId: 'w1' as WorkspaceView['workspaceId'], path: '/project', title: 'Shared project',
    sessionIds: ['s1', executionSessionId].map(id => id as WorkspaceView['sessionIds'][number]), createdAt: '', updatedAt: '',
  }
  workspace.set({ ...workspace.getSnapshot(), items: [ws] })
  const sourceData = {
    ...data.source('s1').getSnapshot(),
    projectResult: {
      ok: true,
      project: { schema: 1, projectId: randomUUID(), baseline: baseline.label, materials: null, artifacts: [], createdAt: '', validation: 'not-checked' },
    },
  } satisfies ContentProps['data']
  const executionData = {
    ...sourceData,
    projectResult: {
      ...sourceData.projectResult,
      modelingSessions: [{ sessionId: executionSessionId, runId: run.id }],
    },
  }
  const itemization = vi.fn(async () => ({ ok: true }))
  const started: ModelingRunView[] = []
  const modeling: NonNullable<ContentProps['modeling']> = vi.fn(async request => {
    if (request.action === 'start') {
      const accepted = request.featureId === feature.id ? run : newerRun
      started.unshift(accepted)
      return { ok: true, baseline, features, runs: [...started], acceptedRunId: accepted.id }
    }
    return { ok: true, available: true, baseline, features, runs: [...started] }
  })
  const content = {
    ...props, data: sourceData, tab: tabInfo('tab1', tabLifetime.signal).tab, modeling, itemization,
  } as ContentProps
  const body = render(
    <WorkbenchContent {...content} />,
  )
  try {
    expect(screen.getAllByRole('heading', { name: en.stageOne })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: en.itTitle })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.modelingFeatures }))
    fireEvent.click(await screen.findByRole('button', { name: /Drive/ }))
    fireEvent.click(screen.getByRole('button', { name: /Brake/ }))
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: en.modelingTitle }))
    await screen.findByText(run.id)
    expect(started.map(item => item.feature.id)).toEqual([secondFeature.id, feature.id])
    expect(screen.getByText('Modeling runs in progress: 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.run }))
    fireEvent.click(screen.getByRole('menuitem', {
      name: translator(en)('modelingSelectRun', { name: newerRun.feature.name, id: newerRun.id }),
    }))
    expect(screen.getByText(newerRun.id)).toBeTruthy()
    expect(screen.queryByRole('region', { name: en.itTitle })).toBeNull()
    expect(itemization).not.toHaveBeenCalled()

    body.rerender(
      <WorkbenchContent
        {...content}
        sessionId={executionSessionId}
        data={executionData}
      />,
    )
    await screen.findByText(run.id)
    expect(screen.queryByText(newerRun.id)).toBeNull()
    expect(screen.queryByRole('region', { name: en.itTitle })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    fireEvent.click(screen.getByRole('button', { name: en.review }))
    expect(screen.getAllByRole('region', { name: en.itTitle })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: en.modelingTitle })).toBeNull()
    await waitFor(() => expect(itemization).toHaveBeenCalled())
  } finally { data.dispose() }
})

it('shares workspace demo facts while same-workspace Sessions retain independent tab drafts through remount', () => {
  const workspace: WorkspaceView = { workspaceId: 'workspace-a' as WorkspaceView['workspaceId'], title: 'Shared project', path: '/fixture',
    sessionIds: ['s1' as WorkspaceView['sessionIds'][number], 's2' as WorkspaceView['sessionIds'][number]], createdAt: '', updatedAt: '' }
  const list = createSnapshotStore<WorkspaceSnapshot>({ items: [workspace], state: 'idle', phase: 'ready', error: null, archivedSessionIds: [], pinnedSessionIds: [] })
  const data = new WorkbenchData({ list })
  const store = createViewStore().create()
  const bind = (sessionId: string) => {
    const source = data.source(sessionId)
    const info = tabInfo('same-tab-id', new AbortController().signal)
    return {
      sessionId,
      usePanelInfo: () => { throw new Error('Panel information is not read by the workbench') },
      t: translator(en), useTabInfo: () => info, draftChanged: () => {},
      useWorkbench: selector => selector(useSyncExternalStore(source.subscribe, source.getSnapshot)),
      useStore: selector => selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
      actions: store.actions, start: (op, scope, scenario) => { data.start(sessionId, op, scope, scenario) },
      act: (id, action) => data.act(id, action), project: () => {},
    } as WorkbenchProps
  }
  const first = bind('s1')
  const second = bind('s2')
  const left = render(<Workbench {...first} />)
  const right = render(<Workbench {...second} />)
  try {
    const a = within(left.container)
    const b = within(right.container)
    fireEvent.click(a.getByRole('button', { name: en.demo }))
    fireEvent.click(b.getByRole('button', { name: en.demo }))
    fireEvent.click(a.getByRole('tab', { name: en.models }))
    fireEvent.click(b.getByRole('tab', { name: en.models }))
    fireEvent.click(a.getByRole('button', { name: 'Statechart' }))
    fireEvent.change(a.getByRole('textbox'), { target: { value: 'Session one only' } })
    expect((b.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(b.getByRole('button', { name: 'Environment' }).getAttribute('aria-pressed')).toBe('true')
    left.unmount()
    const restored = render(<Workbench {...first} />)
    expect((within(restored.container).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Session one only')
    act(() => { data.start('s1', 'model', ['OnePedal'], 'success') })
    expect(data.source('s2').getSnapshot().runs[0]?.request.binding.workspaceId).toBe(workspace.workspaceId)
  } finally { data.dispose() }
})

it('announces run changes and keeps unload protection after the sidebar closes without changing draft data', () => {
  const f = fixture()
  const guard = new DraftGuard(window)
  const props = { ...f.props, draftChanged: (key: string, dirty: boolean, signal: AbortSignal) => guard.update(key, dirty, signal) }
  const body = render(<Workbench {...props} />)
  try {
    fireEvent.click(screen.getByRole('button', { name: en.demo }))
    fireEvent.click(screen.getByRole('button', { name: en.features }))
    fireEvent.click(screen.getByRole('button', { name: en.model }))
    const status = screen.getByLabelText(en.dimensions)
    expect(status.getAttribute('aria-live')).toBe('polite')
    const before = status.textContent
    fireEvent.click(screen.getByRole('button', { name: en.advance }))
    expect(status.textContent).not.toBe(before)
    fireEvent.click(screen.getByRole('tab', { name: en.models }))
    fireEvent.change(screen.getByLabelText(en.draft), { target: { value: 'Keep this draft' } })
    body.unmount()
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
    render(<Workbench {...props} />)
    expect((screen.getByLabelText(en.draft) as HTMLTextAreaElement).value).toBe('Keep this draft')
    fireEvent.change(screen.getByLabelText(en.draft), { target: { value: '' } })
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    fireEvent.change(screen.getByLabelText(en.draft), { target: { value: 'Close this tab' } })
    cleanup()
    f.tabLifetime.abort()
    const closed = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(closed)
    expect(closed.defaultPrevented).toBe(false)
  } finally { guard.dispose(); f.data.dispose() }
})

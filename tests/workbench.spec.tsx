/** Native page behavior with real view store and demo domain; no Host or model is impersonated. */
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot, IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Workbench, type WorkbenchProps } from '../src/client/Workbench.tsx'
import { WorkbenchData } from '../src/client/data.ts'
import { createViewStore } from '../src/client/view-store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(cleanup)
const translator = (dictionary: typeof zh): TranslateNS<'sidebarWorkbench'> => (key, params) => {
  const template = dictionary[key as keyof typeof dictionary] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}
function fixture(dictionary = en) {
  const workspace = createSnapshotStore<WorkspaceSnapshot>({ items: [], state: 'idle', phase: 'ready', error: null, archivedSessionIds: [], pinnedSessionIds: [] })
  const data = new WorkbenchData({ list: workspace })
  const store = createViewStore().create()
  const source = data.source('s1')
  const props = {
    t: translator(dictionary), useTabInfo: () => ({ tab: { id: 'tab1' } }),
    useWorkbench: (selector: (s: ReturnType<typeof source.getSnapshot>) => unknown) => selector(useSyncExternalStore(source.subscribe, source.getSnapshot)),
    useStore: (selector: (s: ReturnType<typeof store.getSnapshot>) => unknown) => selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions, start: (op, scope, scenario) => { data.start('s1', op, scope, scenario) },
    act: (id, action) => data.act(id, action), project: () => {},
  } as WorkbenchProps
  return { data, props, workspace }
}
it.each([en, zh])('shows production unavailability and all four keyboard-accessible tabs', dictionary => {
  const f = fixture(dictionary); render(<Workbench {...f.props} />)
  expect(screen.getByRole('status').textContent).toBe(dictionary.unavailable)
  expect(screen.getAllByText(dictionary.unbound)).toBeTruthy()
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  fireEvent.keyDown(screen.getByRole('tab', { name: dictionary.flow }), { key: 'ArrowRight' })
  expect(screen.getByRole('tab', { name: dictionary.models }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('button', { name: dictionary.align }).hasAttribute('disabled')).toBe(true)
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

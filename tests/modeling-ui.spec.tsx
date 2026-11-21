import { randomUUID } from 'node:crypto'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelingPanel } from '../src/client/features/models/ModelingPanel.tsx'
import { en, zh } from '../src/client/i18n/locales.ts'
import { initialView, type View } from '../src/client/state/view-store.ts'
import type { ModelingAction, ModelingResult, ModelingRunView } from '../src/shared/modeling-api.ts'

afterEach(cleanup)

function fixture(dictionary = en, validationIssues?: number) {
  const t: TranslateNS<'sidebarWorkbench'> = (key, params) => {
    const template = dictionary[key as keyof typeof dictionary] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
  const baseline = { id: randomUUID(), label: 'V1' }
  const states = ['running', 'queued', 'cancelling', 'succeeded', 'failed', 'interrupted', 'cancelled'] as const
  const runs: ModelingRunView[] = states.map((state, index) => ({
    id: randomUUID(), baselineId: baseline.id, materialLabel: baseline.label,
    feature: { id: randomUUID(), name: `Feature ${state}`, requirementId: null },
    state, stage: state === 'succeeded' ? 'finished' : 'parse', sequence: 1,
    updatedAt: `2026-11-21T10:00:0${6 - index}.000Z`, artifacts: [], completed: ['snapshot'],
    stale: false, ...(state === 'failed' ? { problem: 'timeout', detail: 'Parse exceeded its time limit' } : {}),
    ...(state === 'succeeded' && validationIssues !== undefined ? { validationIssues } : {}),
  }))
  let visible = [...runs].reverse()
  const remote = vi.fn(async (request: ModelingAction): Promise<ModelingResult> => {
    if (request.action === 'delete-run') {
      visible = visible.filter(run => run.id !== request.runId)
      return { ok: true, deletedRunId: request.runId }
    }
    return { ok: true, available: true, runs: visible, baseline, features: [], pollIntervalMs: 60_000 }
  })
  function Panel() {
    const [view, setView] = useState<View>({ ...initialView, page: 'modeling-run' })
    return (
      <ModelingPanel
        t={t}
        view={view}
        change={patch => setView(current => ({ ...current, ...patch }))}
        remote={remote}
        openFile={() => {}}
      />
    )
  }
  render(
    <Panel />
  )
  return { t, runs, remote }
}

it.each([en, zh])('renders the latest five runs with status-specific content and expands older history', async dictionary => {
  const { t, runs } = fixture(dictionary)
  const trigger = await screen.findByRole('button', { name: dictionary.run })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('region', { name: dictionary.run })).toBeNull()
  fireEvent.click(trigger)
  const history = within(await screen.findByRole('region', { name: dictionary.run }))
  const items = history.getAllByRole('listitem')
  expect(items).toHaveLength(5)
  expect(items.map(item => item.getAttribute('data-state'))).toEqual(['running', 'queued', 'cancelling', 'succeeded', 'failed'])
  expect(history.getByRole('progressbar', { name: dictionary.modelingProgress }).getAttribute('value')).toBe('1')
  expect(history.getByText(dictionary.modelingRunQueued)).toBeTruthy()
  expect(history.getByText(dictionary.modelingRunCancelling)).toBeTruthy()
  expect(history.getByText(t('modelingIssuesSummary', { gaps: 0, relations: 0 }))).toBeTruthy()
  expect(history.getByText(`${dictionary.modelingStage_parse} · ${dictionary.modelingError_timeout}`).getAttribute('title'))
    .toBe('Parse exceeded its time limit')
  expect(history.getAllByRole('button', { name: /^(Delete run|删除)/ })).toHaveLength(2)

  fireEvent.click(history.getByRole('button', { name: t('modelingOlderRuns', { count: 2 }) }))
  expect(history.getAllByRole('listitem')).toHaveLength(7)
  expect(history.getByText(dictionary.modelingReconcile)).toBeTruthy()
  expect(history.getByText(t('modelingRunCancelled', { stage: dictionary.modelingStage_parse }))).toBeTruthy()
  fireEvent.click(history.getByRole('menuitem', { name: t('modelingSelectRun', { name: runs[6]!.feature.name, id: runs[6]!.id }) }))
  expect(screen.getByText(runs[6]!.id)).toBeTruthy()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  const reopened = within(await screen.findByRole('region', { name: dictionary.run }))
  fireEvent.click(reopened.getByRole('button', { name: dictionary.modelingRecentRuns }))
  expect(reopened.getAllByRole('listitem')).toHaveLength(5)
})

it('closes the run selector with Escape or an outside click and returns keyboard focus', async () => {
  fixture()
  const trigger = await screen.findByRole('button', { name: en.run })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('menu')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  await screen.findByRole('menu')
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it.each([en, zh])('shows advisory validation issues in both completed history and run details', async dictionary => {
  const { t, runs } = fixture(dictionary, 3)
  fireEvent.click(await screen.findByRole('button', { name: dictionary.run }))
  const history = within(await screen.findByRole('region', { name: dictionary.run }))
  const notice = t('modelingValidationIssues', { count: 3 })
  expect(history.getByText(notice)).toBeTruthy()
  const run = runs[3]!
  fireEvent.click(history.getByRole('menuitem', { name: t('modelingSelectRun', { name: run.feature.name, id: run.id }) }))
  expect(screen.getByText(notice)).toBeTruthy()
})

it('confirms history deletion, removes the selected record and keeps remaining records selectable', async () => {
  const { t, runs, remote } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: en.run }))
  let history = within(await screen.findByRole('region', { name: en.run }))
  const run = runs[4]!
  fireEvent.click(history.getByRole('menuitem', { name: t('modelingSelectRun', { name: run.feature.name, id: run.id }) }))
  expect(screen.getByText(run.id)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.run }))
  history = within(await screen.findByRole('region', { name: en.run }))
  const label = t('modelingDeleteRunLabel', { name: run.feature.name, id: run.id })
  fireEvent.click(history.getByRole('button', { name: label }))
  expect(history.getByText(en.modelingDeleteRunHint)).toBeTruthy()
  fireEvent.click(history.getByRole('button', { name: en.modelingKeepRun }))
  expect(remote.mock.calls.some(([request]) => request.action === 'delete-run')).toBe(false)
  fireEvent.click(history.getByRole('button', { name: label }))
  remote.mockResolvedValueOnce({ ok: false, problem: 'storage' })
  fireEvent.click(history.getByRole('button', { name: en.modelingConfirmDeleteRun }))
  await screen.findByText(en.modelingError_storage)
  expect(history.getByRole('alert').textContent).toContain(en.modelingError_storage)
  expect(history.getByRole('button', { name: label })).toBeTruthy()
  expect(history.getAllByRole('listitem')).toHaveLength(5)
  fireEvent.click(history.getByRole('button', { name: en.modelingConfirmDeleteRun }))
  await waitFor(() => expect(history.queryByRole('button', { name: label })).toBeNull())
  expect(remote).toHaveBeenCalledWith({ action: 'delete-run', runId: run.id })
  expect(history.getAllByRole('listitem')).toHaveLength(5)
  expect(screen.queryByText(run.id)).toBeNull()
  expect(screen.getByText(runs[0]!.id)).toBeTruthy()
})

it.each(['rejected', 'ignored'])('reports an older Host directly beside the deletion controls when the action is %s', async mode => {
  const { t, runs, remote } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: en.run }))
  const history = within(await screen.findByRole('region', { name: en.run }))
  const run = runs[4]!
  const label = t('modelingDeleteRunLabel', { name: run.feature.name, id: run.id })
  fireEvent.click(history.getByRole('button', { name: label }))
  if (mode === 'rejected') remote.mockRejectedValueOnce(new Error('gateway/input-invalid'))
  else remote.mockResolvedValueOnce({ ok: true, runs })
  fireEvent.click(history.getByRole('button', { name: en.modelingConfirmDeleteRun }))
  await waitFor(() => expect(history.getByRole('alert').textContent).toContain(en['modelingError_host-upgrade-required']))
  expect(history.getByRole('button', { name: label })).toBeTruthy()
  expect(history.getAllByRole('listitem')).toHaveLength(5)
  fireEvent.click(history.getByRole('button', { name: en.modelingConfirmDeleteRun }))
  await waitFor(() => expect(history.queryByRole('button', { name: label })).toBeNull())
  expect(history.getByRole('menuitem', { name: t('modelingSelectRun', { name: runs[0]!.feature.name, id: runs[0]!.id }) })).toBeTruthy()
})

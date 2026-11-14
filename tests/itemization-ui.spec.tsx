/** Candidate selection and impact acknowledgement remain bound to one Host revision. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ItemizationPanel } from '../src/client/features/project/ItemizationPanel.tsx'
import { ItemizationReport } from '../src/client/features/project/ItemizationReport.tsx'
import { en } from '../src/client/i18n/locales.ts'
import { itemizationResultSchema, type ItemizationCommand } from '../src/shared/itemization-api.ts'
import type { WorkbenchInjected } from '../src/client/app/workbench-types.ts'

afterEach(cleanup)
const t: TranslateNS<'sidebarWorkbench'> = key => en[key as keyof typeof en]
const candidate = '11111111-1111-4111-8111-111111111111', material = '22222222-2222-4222-8222-222222222222', runId = '33333333-3333-4333-8333-333333333333'
const result = itemizationResultSchema.parse({ ok: true, available: true, pollIntervalMs: 60000, runs: [], state: {
  schema: 1, projectId: '44444444-4444-4444-8444-444444444444', revision: 2, baseline: null,
  materials: [{ id: material, label: 'V1', original: 'source.pdf', markdown: 'source.md', originalSha256: 'a'.repeat(64), markdownSha256: 'b'.repeat(64) }],
  candidates: [{ id: candidate, materialId: material, runId, artifacts: [{ path: `workbench-runs/${runId}/candidate/chunks.json`, sha256: 'c'.repeat(64) }] }],
} })
const comparison = JSON.stringify({ added: ['feature'], deleted: [], renamed: [], changed: [], affected: ['feature'], relationsChanged: false, unmatched: [] })
function panel(remote?: WorkbenchInjected['itemization']) {
  return render(
    <ItemizationPanel
      t={t}
      remote={remote}
      unavailable={false}
      fields={{ original: '', markdown: '', version: '', sameVersion: false }}
      change={vi.fn()}
      feedback=""
      listFiles={undefined}
      openFile={vi.fn()}
    />
  )
}

it('keeps execution disabled without a Remote command', () => {
  panel()
  expect(screen.getByRole('button', { name: en.itStart }).hasAttribute('disabled')).toBe(true)
})

it('removes a run card after confirmation and keeps its candidate selectable', async () => {
  const initial = itemizationResultSchema.parse({ ...result, runs: [{
    schema: 1, id: runId, projectId: result.state!.projectId, workspaceId: 'workspace', bindingRevision: 1,
    root: 'project', requestKey: runId, fingerprint: 'input', candidateId: candidate, materialId: material,
    feedback: '', state: 'succeeded', stage: 'finished', sequence: 1,
    createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', artifacts: [],
  }] })
  const remote = vi.fn<NonNullable<WorkbenchInjected['itemization']>>(async request =>
    request.action === 'delete-run' ? { ok: true, runs: [] } : initial)
  panel(remote)

  fireEvent.click(await screen.findByRole('button', { name: en.itDeleteRun }))
  fireEvent.click(screen.getByRole('button', { name: en.itKeepRun }))
  expect(remote.mock.calls.some(([request]) => request.action === 'delete-run')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: en.itDeleteRun }))
  fireEvent.click(screen.getByRole('button', { name: en.itConfirmDeleteRun }))
  await waitFor(() => expect(screen.queryByRole('button', { name: en.itDeleteRun })).toBeNull())
  expect(remote).toHaveBeenCalledWith({ action: 'delete-run', runId })
  expect(screen.getByRole('option', { name: new RegExp(candidate) })).toBeTruthy()
})

it('requires current comparison and impact acknowledgement, then discards rejected adoption proof', async () => {
  const calls: Omit<ItemizationCommand, 'sessionId' | 'workspaceId'>[] = []
  panel(async request => {
    calls.push(request)
    if (request.action === 'compare') return { ...result, comparison, impactFingerprint: 'proof-2' }
    if (request.action === 'adopt') return { ok: false, problem: 'conflict' }
    return result
  })
  await screen.findByRole('option', { name: new RegExp(candidate) })
  fireEvent.change(screen.getByRole('combobox', { name: en.itSelect }), { target: { value: candidate } })
  expect(screen.getByRole('button', { name: en.accept }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.itCompare }))
  await screen.findByRole('checkbox', { name: en.itConfirmImpact })
  expect(screen.getByRole('button', { name: en.accept }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: en.itConfirmImpact }))
  fireEvent.click(screen.getByRole('button', { name: en.accept }))
  await screen.findByText(en.itProblem_conflict)
  expect(calls.find(request => request.action === 'adopt')).toMatchObject({ candidateId: candidate, expectedRevision: 2, impactFingerprint: 'proof-2' })
  expect(screen.getByRole('button', { name: en.accept }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: en.itSelect })).toBeTruthy()
})

it('does not send cancellation when the view closes while Host work is active', async () => {
  const remote = vi.fn<NonNullable<WorkbenchInjected['itemization']>>().mockResolvedValue(result)
  const view = panel(remote)
  await waitFor(() => expect(remote).toHaveBeenCalled())
  view.unmount()
  expect(remote.mock.calls.some(([request]) => request.action === 'cancel')).toBe(false)
})

it('shows retained source conflicts and keeps adoption disabled after comparison', async () => {
  panel(async request => {
    if (request.action === 'candidate') return { ...result, content: JSON.stringify({ index: { functions: [] }, chunks: { chunks: [], project_relation_seed: {} }, validation: { passed: true, reviewBlocked: true, sourceConflicts: [{ description: 'Conflicting hierarchy' }] } }) }
    if (request.action === 'compare') return { ...result, comparison, impactFingerprint: 'proof-2' }
    return result
  })
  await screen.findByRole('option', { name: new RegExp(candidate) })
  fireEvent.change(screen.getByRole('combobox', { name: en.itSelect }), { target: { value: candidate } })
  fireEvent.click(screen.getByRole('button', { name: en.itRead }))
  await screen.findByText(en['itProblem_source-conflict'])
  fireEvent.click(screen.getByRole('button', { name: en.itCompare }))
  fireEvent.click(await screen.findByRole('checkbox', { name: en.itConfirmImpact }))
  expect(screen.getByRole('button', { name: en.accept }).hasAttribute('disabled')).toBe(true)
})

it('keeps business conflict evidence visible when the final structural report passes', () => {
  render(
    <ItemizationReport
      t={t}
      kind="validation"
      value={{
        passed: true,
        issues: [],
        reviewBlocked: true,
        sourceConflicts: [{
          report: 'candidate/validation-1.json',
          issues: [{
            id: 'CI-001',
            description: 'The change log and body disagree',
            evidence: [{ section_id: '2', title: 'Overview', position: 4071, text: 'System includes Drive' }],
          }],
        }],
        extra: { retained: 'complete-original-data' },
      }}
    />
  )
  expect(screen.getByRole('heading', { name: en.itConflictTitle })).toBeTruthy()
  expect(screen.getByText('The change log and body disagree')).toBeTruthy()
  expect(screen.getByText('System includes Drive')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: en.itStructurePassed })).toBeNull()
  const report = screen.getByText(en.itRawReport).closest('details')!
  expect(report.open).toBe(false)
  fireEvent.click(screen.getByText(en.itRawReport))
  expect(report.querySelector('pre')?.textContent).toContain('complete-original-data')
})

it('shows source quotations for known relations and opens the complete report for unknown formats', () => {
  const view = render(
    <ItemizationReport
      t={t}
      kind="seed"
      value={{
        relation_delta: [{
          from: 'System',
          to: 'Drive',
          rel_type: 'includes',
          evidence: [{ section_id: '1', text: 'System includes Drive' }],
        }],
      }}
    />
  )
  expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Drive' })).toBeTruthy()
  expect(screen.getByText('System includes Drive')).toBeTruthy()
  view.rerender(
    <ItemizationReport
      t={t}
      kind="validation"
      value={{ futureFormat: 'retain-this-diagnostic' }}
    />
  )
  expect(screen.getByText(en.itRawReport).closest('details')?.open).toBe(true)
  expect(screen.getByText(/retain-this-diagnostic/)).toBeTruthy()
})

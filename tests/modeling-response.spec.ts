import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { modelingResponse } from '../src/client/features/models/modeling-response.ts'

it('identifies an older Host rejecting deletion through the strict Remote codec', () => {
  const action = { action: 'delete-run', runId: randomUUID() } as const
  const error = new RemoteError('gateway/input-invalid', 'Invalid request', { endpoint: 'workbench/modeling', field: 'request' })
  expect(modelingResponse(action, { ok: false, error }))
    .toMatchObject({ ok: false, problem: 'host-upgrade-required', detail: 'gateway/input-invalid' })
  expect(() => modelingResponse({ action: 'inspect' }, { ok: false, error })).toThrow('gateway/input-invalid')
})

it('accepts a matching deletion receipt and preserves Host business failures', () => {
  const action = { action: 'delete-run', runId: randomUUID() } as const
  const confirmed = { ok: true, deletedRunId: action.runId }
  expect(modelingResponse(action, { ok: true, value: confirmed })).toBe(confirmed)
  expect(modelingResponse(action, { ok: true, value: { ok: true, runs: [] } })).toMatchObject({ ok: true })
  expect(modelingResponse(action, { ok: true, value: { ok: true } })).toMatchObject({ ok: false, problem: 'host-upgrade-required' })
  expect(modelingResponse(action, { ok: true, value: { ok: true, deletedRunId: randomUUID() } }))
    .toMatchObject({ ok: false, problem: 'host-upgrade-required' })
  expect(modelingResponse(action, { ok: true, value: { ok: false, problem: 'run-not-deletable' } }))
    .toMatchObject({ ok: false, problem: 'run-not-deletable' })
})

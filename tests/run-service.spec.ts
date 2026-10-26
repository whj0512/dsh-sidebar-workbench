// @vitest-environment node
/** Durable ownership without a business executor. Test repositories are independent per case. */
import { expect, it } from 'vitest'
import { RunService, type DurableRun, type RunAdmission } from '../src/host/run-service.ts'
const admission: RunAdmission = { requestKey: 'request-1', binding: { workspaceId: 'w1', projectId: '7bd8a781-cd0a-4f89-8c66-063887d5fe00', revision: 1, root: '/fixed/workspace', status: 'active', unsettledRuns: [] }, inputVersion: 'V1', fingerprint: 'sha256:input', operation: 'model', scope: ['feature-1'] }
it('A13/A16/A18 persists idempotent ownership, refuses missing executors, and reconciles restart without dispatch', async () => {
  const records = new Map<string, DurableRun>()
  const repository = { list: () => [...records.values()], put: async (r: DurableRun) => { records.set(r.id, structuredClone(r)) } }
  let capable = false
  const first = new RunService(repository, async () => {}, () => capable)
  await expect(first.start(admission)).rejects.toThrow('unavailable'); expect(records.size).toBe(0)
  capable = true
  const [a, b] = await Promise.all([first.start(admission), first.start(admission)])
  expect(a.id).toBe(b.id)
  await first.update(a.id, a.sequence, { state: 'running', validation: 'not-checked', committed: false, artifacts: [] })
  const restart = new RunService(repository, async () => {}, () => false)
  await restart.recover()
  expect(records.get(a.id)?.state).toBe('interrupted')
  expect(records.get(a.id)?.root).toBe('/fixed/workspace')
  expect(restart.unsettled(a.projectId)).toHaveLength(1)
  await expect(restart.update(a.id, records.get(a.id)!.sequence, { state: 'running', validation: 'not-checked', committed: false, artifacts: [] })).rejects.toThrow('Reconcile')
  await restart.close(); await first.close()
})
it('A14/A20/A24 refuses invalid success and changed bindings, preserves submission and ignores late sequence updates', async () => {
  const records = new Map<string, DurableRun>(); let valid = true
  const service = new RunService({ list: () => [...records.values()], put: async r => { records.set(r.id, r) } }, async () => { if (!valid) throw new Error('binding removed') }, () => true)
  const r = await service.start({ ...admission, operation: 'upload' })
  await expect(service.update(r.id, 1, { state: 'succeeded', validation: 'not-checked', committed: true, artifacts: [] })).rejects.toThrow('Unverified')
  valid = false
  await expect(service.update(r.id, 1, { state: 'running', validation: 'not-checked', committed: false, artifacts: [] })).rejects.toThrow('binding')
  const committed = await service.update(r.id, 1, { state: 'unknown', validation: 'failed', committed: true, artifacts: [] })
  expect((await service.update(r.id, 1, { state: 'succeeded', validation: 'passed', committed: false, artifacts: [] })).state).toBe('unknown')
  const failed = await service.update(r.id, committed.sequence, { state: 'failed', validation: 'failed', committed: false, artifacts: [] })
  expect(failed.committed).toBe(true); expect(failed.root).toBe(r.root); await service.close()
})

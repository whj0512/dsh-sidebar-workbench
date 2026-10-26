// @vitest-environment node
/** Controlled adapter outcomes; no timers, model, files or remote service. */
import { describe, expect, it } from 'vitest'
import { DemoExecutor, authorized, blockers, operations, type StartRequest, type ProjectId, type Run } from '../src/shared/workflow.ts'
import { demoInputs } from '../src/client/data.ts'
const request = (patch: Partial<StartRequest> = {}): StartRequest => ({ key: 'one',
  binding: { workspaceId: 'w1', projectId: 'demo:p1' as ProjectId, revision: 1, root: 'demo:/one', valid: true },
  operation: 'model', inputs: demoInputs, scope: ['OnePedal'], target: 'demo:graph', repository: 'requirement', scenario: 'success', ...patch })
function finish(e: DemoExecutor, r: Run): Run { for (let n = 0; n < 20; n++) r = e.advance(r.id, r.request.binding); return r }
describe('A02–A14, A18, A20 demo orchestration', () => {
  it.each(operations)('finishes only the selected %s operation', operation => {
    const e = new DemoExecutor(2)
    const input = request({ operation })
    let r = e.start(input)
    if (operation === 'upload' || operation === 'infer') {
      expect(r.state).toBe('waiting-user')
      r = e.grant(r.id, { operation, target: input.target, repository: input.repository, scope: input.scope, version: input.inputs.version, fingerprint: input.inputs.fingerprint })
    }
    r = finish(e, r)
    expect(r.state).toBe('succeeded')
    if (operation === 'itemize' || operation === 'update') { expect(r.review).toBe('pending'); expect(e.accept(r.id).review).toBe('accepted') }
    if (operation === 'ttl' || operation === 'query') expect(r.committed).toBe(false)
  })
  it('blocks partial, missing, outdated and uncovered tests without starting', () => {
    for (const inputs of [{ ...demoInputs, alignment: 'partial' as const }, { ...demoInputs, alignment: 'missing' as const },
      { ...demoInputs, validationVersion: 'V0' }, { ...demoInputs, uncovered: 1 }, { ...demoInputs, syntax: false }, { ...demoInputs, accepted: false }]) {
      const e = new DemoExecutor(1); const r = e.start(request({ operation: 'tests', inputs }))
      expect(r.state).toBe('blocked'); expect(finish(e, r).artifacts).toEqual([])
    }
  })
  it('isolates failed features and serializes project relation commits', () => {
    const e = new DemoExecutor(1)
    const first = e.start(request({ scenario: 'alignment' })); const second = e.start(request({ key: 'two', scope: ['BrakeHold'] }))
    e.advance(first.id, first.request.binding)
    expect(e.advance(second.id, second.request.binding).state).toBe('queued')
    const failed = finish(e, first)
    expect(failed.state).toBe('blocked'); expect(failed.stages.find(s => s.stage === 'tests')?.state).toBe('queued')
    expect(finish(e, second).state).toBe('succeeded')
    expect(e.commitRelations(0)).toBe(1); expect(() => e.commitRelations(0)).toThrow('conflict')
  })
  it('deduplicates clicks and rejects scope or target changes to approval', () => {
    const e = new DemoExecutor(1); const r = e.start(request())
    expect(e.start(request()).id).toBe(r.id)
    const upload = request({ operation: 'upload', authorization: { operation: 'upload', target: 'demo:graph', repository: 'requirement', version: 'V1', fingerprint: 'demo:V1', scope: ['OnePedal'] } })
    expect(authorized(upload)).toBe(true)
    for (const change of [{ target: 'demo:other' }, { repository: 'other' }, { scope: ['BrakeHold'] }, { operation: 'infer' as const }, { inputs: { ...demoInputs, fingerprint: 'new' } }]) expect(authorized({ ...upload, ...change })).toBe(false)
  })
  it('awaits cancellation confirmation, ignores late results and preserves committed uploads', () => {
    const e = new DemoExecutor(1); let r = e.start(request()); r = e.advance(r.id, r.request.binding)
    expect(e.cancel(r.id).state).toBe('cancelling'); expect(e.confirmCancel(r.id).state).toBe('cancelled')
    expect(e.receive({ ...r, sequence: 100, state: 'succeeded' })).toBe(false)
    let u = e.start(request({ key: 'upload', operation: 'upload', scenario: 'submitted' }))
    u = e.grant(u.id, { operation: 'upload', target: 'demo:graph', repository: 'requirement', version: 'V1', fingerprint: 'demo:V1', scope: ['OnePedal'] })
    u = finish(e, u); expect(u.committed).toBe(true); expect(u.validation).toBe('failed'); expect(u.state).toBe('blocked')
  })
  it('freezes unknown writes, marks stale artifacts, and rejects changed directory snapshots', () => {
    const e = new DemoExecutor(2); const r = e.start(request())
    expect(e.advance(r.id, { ...r.request.binding, root: 'demo:/other' }).state).toBe('blocked')
    let u = e.start(request({ key: 'u', operation: 'upload', scenario: 'unknown' }))
    u = e.grant(u.id, { operation: 'upload', target: 'demo:graph', repository: 'requirement', version: 'V1', fingerprint: 'demo:V1', scope: ['OnePedal'] })
    u = finish(e, u); expect(u.state).toBe('unknown'); expect(finish(e, u)).toBe(u)
    expect(e.reconcile(u.id, false).state).toBe('failed')
    const done = finish(e, e.start(request({ key: 'new' })))
    e.invalidate(done.request.binding.projectId, 'V2'); expect(e.get(done.id).artifacts.every(a => a.freshness === 'stale')).toBe(true)
    expect(blockers(request({ operation: 'infer', inputs: { ...demoInputs, shacl: false } }))).toContain('readiness')
  })
  it('refuses Host directories and interrupts unfinished work on unload', () => {
    const e = new DemoExecutor(1)
    expect(() => e.start(request({ binding: { ...request().binding, root: '/real' } }))).toThrow()
    const r = e.start(request()); e.dispose(); expect(e.get(r.id).state).toBe('interrupted')
    expect(() => e.start(request())).toThrow()
  })
})

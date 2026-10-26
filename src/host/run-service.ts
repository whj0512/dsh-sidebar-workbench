/** Durable execution facts for future adapters; this service never invokes a model or business algorithm. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ProjectBinding } from '../shared/project.ts'

export const durableRunSchema = z.object({
  schema: z.literal(1), id: z.string().uuid(), requestKey: z.string(), workspaceId: z.string(), projectId: z.string().uuid(),
  bindingRevision: z.number().int().positive(), root: z.string(), output: z.string(), inputVersion: z.string(), fingerprint: z.string(),
  operation: z.enum(['itemize', 'update', 'model', 'relations', 'align', 'tests', 'ttl', 'upload', 'infer', 'query']),
  scope: z.array(z.string()), attempt: z.number().int().positive(), sequence: z.number().int().positive(),
  state: z.enum(['queued', 'running', 'waiting-user', 'blocked', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']),
  validation: z.enum(['not-checked', 'passed', 'failed', 'not-applicable']),
  review: z.enum(['not-required', 'pending', 'accepted', 'rejected']), freshness: z.enum(['current', 'stale', 'unknown']),
  committed: z.boolean(), artifacts: z.array(z.string()),
}).strict()
export type DurableRun = z.infer<typeof durableRunSchema>
export interface RunRepository {
  list(): readonly DurableRun[]
  put(run: DurableRun): Promise<void>
}
export interface RunAdmission {
  readonly requestKey: string
  readonly binding: ProjectBinding
  readonly inputVersion: string
  readonly fingerprint: string
  readonly operation: DurableRun['operation']
  readonly scope: readonly string[]
}

/** Serial persistence owner. Adapters must recheck the binding before every stage and pass verified outputs on settlement. */
export class RunService {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  /** @param records - Host domain. @param check - Authoritative binding and filesystem validation. @param supports - Actual executor capability, false until installed. */
  constructor(private readonly records: RunRepository, private readonly check: (binding: ProjectBinding) => Promise<void>,
    private readonly supports: (operation: DurableRun['operation']) => boolean) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.tail.then(operation)
    this.tail = job.then(() => {}, () => {})
    return job
  }
  /** @param request - Operation snapshot. @returns Existing idempotent run or durable queued record; no executor means no record. */
  start(request: RunAdmission): Promise<DurableRun> {
    if (this.stopped) return Promise.reject(new Error('Run service closed'))
    return this.serial(async () => {
      const old = this.records.list().find(r => r.projectId === request.binding.projectId && r.requestKey === request.requestKey)
      if (old) return old
      if (!this.supports(request.operation)) throw new Error('Executor unavailable')
      await this.check(request.binding)
      const id = randomUUID()
      const run: DurableRun = { schema: 1, id, requestKey: request.requestKey, workspaceId: request.binding.workspaceId,
        projectId: request.binding.projectId, bindingRevision: request.binding.revision, root: request.binding.root,
        output: `workbench-runs/${id}`, inputVersion: request.inputVersion, fingerprint: request.fingerprint,
        operation: request.operation, scope: [...request.scope], attempt: 1, sequence: 1, state: 'queued', validation: 'not-checked',
        review: request.operation === 'itemize' || request.operation === 'update' ? 'pending' : 'not-required', freshness: 'current', committed: false, artifacts: [] }
      await this.records.put(run); return run
    })
  }
  /** @param id - Run identity. @param sequence - Observed sequence. @param next - Adapter-confirmed state. @returns Committed update, or unchanged record for a late update. */
  update(id: string, sequence: number, next: Pick<DurableRun, 'state' | 'validation' | 'committed' | 'artifacts'>): Promise<DurableRun> {
    if (this.stopped) return Promise.reject(new Error('Run service closed'))
    return this.serial(async () => {
      const run = this.records.list().find(r => r.id === id)
      if (!run) throw new Error('Unknown run')
      if (sequence !== run.sequence || ['succeeded', 'failed', 'cancelled'].includes(run.state)) return run
      if (next.state === 'queued' || next.state === 'running') {
        if (['unknown', 'interrupted'].includes(run.state)) throw new Error('Reconcile before resubmission')
        await this.check({ workspaceId: run.workspaceId, projectId: run.projectId, revision: run.bindingRevision, root: run.root, status: 'active', unsettledRuns: [] })
      }
      if (next.state === 'succeeded' && next.validation !== 'passed' && next.validation !== 'not-applicable') throw new Error('Unverified success')
      const result = { ...run, ...next, committed: run.committed || next.committed, sequence: run.sequence + 1 }
      await this.records.put(result); return result
    })
  }
  /** @param projectId - Project identity. @returns Unsettled records that prohibit reassociation. */
  unsettled(projectId: string): readonly DurableRun[] {
    return this.records.list().filter(r => r.projectId === projectId && !['succeeded', 'failed', 'cancelled'].includes(r.state))
  }
  /** @returns Recovery settlement; never restarts or resubmits a previously accepted operation. */
  recover(): Promise<void> {
    return this.serial(async () => {
      for (const run of this.records.list()) if (['running', 'queued', 'cancelling'].includes(run.state)) {
        await this.records.put({ ...run, sequence: run.sequence + 1, state: run.committed || run.operation === 'upload' ? 'unknown' : 'interrupted' })
      }
    })
  }
  /** @returns Quiescence after accepted writes drain and unfinished work is marked for reconciliation. */
  async close(): Promise<void> { this.stopped = true; await this.tail; await this.recover() }
}

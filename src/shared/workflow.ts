/** Business-independent execution protocol. Demo results never name Host files or receipts. */
import type { Branded } from '@deepseek-ai/dsh-brand'

export type ProjectId = Branded<'WorkbenchProjectId'>
export type RunId = Branded<'WorkbenchRunId'>
export type Operation = 'itemize' | 'update' | 'model' | 'relations' | 'align' | 'tests' | 'ttl' | 'upload' | 'infer' | 'query'
export type Execution = 'queued' | 'running' | 'waiting-user' | 'blocked' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
export type Validation = 'not-checked' | 'passed' | 'failed' | 'not-applicable'
export type Review = 'not-required' | 'pending' | 'accepted' | 'rejected'
export type Freshness = 'current' | 'stale' | 'unknown'
export type Stage = 'materials' | 'itemize' | 'review' | 'parse' | 'dsl' | 'align' | 'tests' | 'artifacts' | 'ttl' | 'upload' | 'shacl' | 'infer' | 'query'
export type Scenario = 'success' | 'alignment' | 'missing' | 'unknown' | 'submitted' | 'empty' | 'failure'

/** Captured by the execution owner, never reconstructed from the currently visible Session. */
export interface Binding {
  readonly workspaceId: string
  readonly projectId: ProjectId
  readonly revision: number
  readonly root: string
  readonly valid: boolean
}
export interface Inputs {
  readonly version: string
  readonly fingerprint: string
  readonly validationVersion: string
  readonly syntax: boolean
  readonly unified: boolean
  readonly alignment: 'complete' | 'partial' | 'missing'
  readonly uncovered: number
  readonly accepted: boolean
  readonly ttl: boolean
  readonly abox: boolean
  readonly tbox: boolean
  readonly shacl: boolean
}
export interface Authorization {
  readonly operation: 'upload' | 'infer'
  readonly target: string
  readonly repository: string
  readonly version: string
  readonly fingerprint: string
  readonly scope: readonly string[]
}
export interface StartRequest {
  readonly key: string
  readonly binding: Binding
  readonly operation: Operation
  readonly inputs: Inputs
  readonly scope: readonly string[]
  readonly target: string
  readonly repository: string
  readonly authorization?: Authorization
  readonly scenario: Scenario
}
export interface Artifact {
  readonly name: string
  readonly stage: Stage
  readonly version: string
  readonly fingerprint: string
  readonly validation: Validation
  readonly freshness: Freshness
  readonly demo: true
}
export interface Run {
  readonly id: RunId
  readonly request: StartRequest
  readonly output: string
  readonly attempt: number
  readonly sequence: number
  readonly state: Execution
  readonly validation: Validation
  readonly review: Review
  readonly freshness: Freshness
  readonly stages: readonly { readonly stage: Stage; readonly state: Execution }[]
  readonly artifacts: readonly Artifact[]
  readonly issues: readonly string[]
  readonly committed: boolean
}

export const operations: readonly Operation[] = ['itemize', 'update', 'model', 'relations', 'align', 'tests', 'ttl', 'upload', 'infer', 'query']
export const plans: Record<Operation, readonly Stage[]> = {
  itemize: ['materials', 'itemize', 'review'], update: ['materials', 'itemize', 'review'],
  model: ['parse', 'dsl', 'align', 'tests', 'artifacts'], relations: ['parse', 'artifacts'],
  align: ['align', 'artifacts'], tests: ['tests', 'artifacts'], ttl: ['ttl', 'artifacts'],
  upload: ['upload', 'shacl'], infer: ['infer', 'artifacts'], query: ['query'],
}
const outputs: Partial<Record<Stage, readonly string[]>> = {
  itemize: ['chunks.json', 'project_relation_seed'], parse: ['requirements.json', 'relation_delta.json'],
  dsl: ['Environment', 'ExternalScenario', 'Statechart', 'DialogMap', 'requirement_dsl_map.json'],
  align: ['alignment_result.json', 'completion_plan.md'], tests: ['测试用例.xlsx', 'requirement_testcase_map.json'],
  ttl: ['ABox TTL', 'local-validation'], shacl: ['SHACL report'], infer: ['inference report'], query: ['relations export'],
}

/** @param request - Frozen run scope. @returns Whether a grant covers precisely this operation. */
export function authorized(request: StartRequest): boolean {
  const a = request.authorization
  return !!a && a.operation === request.operation && a.target === request.target && a.repository === request.repository
    && a.version === request.inputs.version && a.fingerprint === request.inputs.fingerprint
    && JSON.stringify([...a.scope].sort()) === JSON.stringify([...request.scope].sort())
}

/** @param request - Proposed operation. @returns Stable blocking codes; no machine check is replaced by review. */
export function blockers(request: StartRequest): string[] {
  const { operation: op, inputs: i } = request
  const reasons: string[] = []
  if (!request.binding.valid) reasons.push('binding')
  if (!request.scope.length) reasons.push('scope')
  if (['model', 'relations', 'align', 'tests', 'ttl'].includes(op) && !i.accepted) reasons.push('review')
  if (['tests', 'ttl', 'upload', 'infer'].includes(op)) {
    if (!i.syntax || !i.unified) reasons.push('validation')
    if (i.alignment !== 'complete' || i.uncovered > 0) reasons.push('alignment')
    if (i.version !== i.validationVersion) reasons.push('stale')
  }
  if (op === 'upload' && !i.ttl) reasons.push('ttl')
  if (op === 'infer' && (!i.abox || !i.tbox || !i.shacl)) reasons.push('readiness')
  return reasons
}

/** A controlled, network-free adapter. Advancing is an explicit test/demo gesture, never a browser timer. */
export class DemoExecutor {
  private records = new Map<RunId, Run>()
  private keys = new Map<string, RunId>()
  private counter = 0
  private relationRevision = 0
  private stopped = false
  /** @param concurrency - Maximum active independent runs. */
  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency')
  }
  /** @returns Immutable records in creation order. */
  list(): readonly Run[] { return [...this.records.values()] }
  /** @param id - Known run identity. @returns Current authoritative demo record. */
  get(id: RunId): Run { const r = this.records.get(id); if (!r) throw new Error('Unknown run'); return r }
  private save(run: Run): Run { this.records.set(run.id, Object.freeze(run)); return run }
  /** @param request - Isolated demo input. @returns Existing run on duplicate key, otherwise one queued or blocked record. */
  start(request: StartRequest): Run {
    if (this.stopped) throw new Error('Executor disposed')
    if (!request.binding.root.startsWith('demo:')) throw new Error('Demo cannot use a Host directory')
    const key = JSON.stringify([request.binding.projectId, request.key])
    const existing = this.keys.get(key)
    if (existing) return this.get(existing)
    const copy: StartRequest = structuredClone(request)
    const issues = blockers(copy)
    const needsGrant = ['upload', 'infer'].includes(copy.operation) && !authorized(copy)
    const id = `demo-run-${++this.counter}` as RunId
    this.keys.set(key, id)
    return this.save({ id, request: copy, output: `demo:/${id}`, attempt: 1, sequence: 1,
      state: issues.length ? 'blocked' : needsGrant ? 'waiting-user' : 'queued', validation: 'not-checked',
      review: ['itemize', 'update'].includes(copy.operation) ? 'pending' : 'not-required', freshness: 'current',
      stages: plans[copy.operation].map(stage => ({ stage, state: 'queued' })), artifacts: [], issues, committed: false })
  }
  /** @param id - Run to authorize. @param grant - Exact approval. @returns Updated waiting or queued record. */
  grant(id: RunId, grant: Authorization): Run {
    const r = this.get(id)
    if (r.state !== 'waiting-user') return r
    const request = { ...r.request, authorization: structuredClone(grant) }
    return this.save({ ...r, request, sequence: r.sequence + 1, state: authorized(request) ? 'queued' : 'waiting-user' })
  }
  /** @param id - Run to advance. @param binding - Current binding check. @returns One stage transition. */
  advance(id: RunId, binding: Binding): Run {
    const r = this.get(id)
    if (this.stopped || !['queued', 'running'].includes(r.state)) return r
    if (!binding.valid || binding.workspaceId !== r.request.binding.workspaceId || binding.projectId !== r.request.binding.projectId
      || binding.revision !== r.request.binding.revision || binding.root !== r.request.binding.root)
      return this.save({ ...r, state: 'blocked', issues: ['binding'], sequence: r.sequence + 1 })
    if (r.state === 'queued' && this.list().filter(x => x.state === 'running').length >= this.concurrency) return r
    const index = r.stages.findIndex(s => s.state !== 'succeeded')
    const current = r.stages[index]
    if (!current) return r
    if (current.state === 'queued') return this.save({ ...r, state: 'running', sequence: r.sequence + 1,
      stages: r.stages.map((s, n) => n === index ? { ...s, state: 'running' } : s) })
    const scenario = r.request.scenario
    if (current.stage === 'upload' && scenario === 'unknown') return this.save({ ...r, state: 'unknown', issues: ['unknown'], sequence: r.sequence + 1 })
    const failed = (current.stage === 'align' && scenario === 'alignment') || (current.stage === 'shacl' && scenario === 'submitted')
    const missing = current.stage === 'artifacts' && scenario === 'missing'
    const fault = scenario === 'failure'
    const artifacts = [...r.artifacts, ...(outputs[current.stage] ?? []).map(name => ({ name, stage: current.stage,
      version: r.request.inputs.version, fingerprint: `demo:${name}:${r.attempt}`, validation: failed ? 'failed' as const : 'passed' as const,
      freshness: 'current' as const, demo: true as const }))]
    const done = index === r.stages.length - 1
    return this.save({ ...r, sequence: r.sequence + 1, artifacts: scenario === 'empty' ? [] : artifacts,
      state: failed || missing ? 'blocked' : fault ? 'failed' : done ? 'succeeded' : 'running',
      validation: failed || missing ? 'failed' : done ? 'passed' : r.validation,
      committed: r.committed || current.stage === 'upload', issues: failed ? [current.stage === 'align' ? 'alignment' : 'shacl'] : missing ? ['missing'] : fault ? ['failure'] : [],
      stages: r.stages.map((s, n) => n === index ? { ...s, state: failed || missing || fault ? 'failed' : 'succeeded' } : s) })
  }
  /** @param id - Current run. @returns Cancelling until the adapter confirms active work stopped. */
  cancel(id: RunId): Run {
    const r = this.get(id)
    if (!['queued', 'running', 'waiting-user', 'blocked'].includes(r.state)) return r
    return this.save({ ...r, sequence: r.sequence + 1, state: r.state === 'running' ? 'cancelling' : 'cancelled' })
  }
  /** @param id - Settled prior attempt. @param key - New explicit retry request. @returns New run preserving the old attempt; unknown outcomes cannot retry. */
  retry(id: RunId, key: string): Run {
    const prior = this.get(id)
    if (!['failed', 'cancelled'].includes(prior.state)) throw new Error('Reconcile before retry')
    const next = this.start({ ...prior.request, key, authorization: undefined })
    if (next.attempt > 1) return next
    return this.save({ ...next, attempt: prior.attempt + 1 })
  }
  /** @param id - Cancelling run. @param committed - Actual completed submission. @returns Settled cancellation or committed success. */
  confirmCancel(id: RunId, committed = false): Run {
    const r = this.get(id)
    if (r.state !== 'cancelling') return r
    return this.save({ ...r, sequence: r.sequence + 1, state: committed ? 'unknown' : 'cancelled', committed: r.committed || committed,
      stages: r.stages.map(stage => stage.state === 'running' || stage.state === 'queued' ? { ...stage, state: committed ? 'unknown' : 'cancelled' } : stage) })
  }
  /** @param id - Unknown/interrupted run. @param completed - Verified final outcome. @returns Reconciled record without resubmission. */
  reconcile(id: RunId, completed: boolean): Run {
    const r = this.get(id)
    if (!['unknown', 'interrupted'].includes(r.state)) return r
    return this.save({ ...r, sequence: r.sequence + 1, state: completed ? 'succeeded' : 'failed', issues: [], committed: r.committed || completed })
  }
  /** @param id - Completed candidate. @returns Reviewed record; failed validation cannot be overridden. */
  accept(id: RunId): Run {
    const r = this.get(id)
    if (r.state !== 'succeeded' || r.validation !== 'passed' || r.review !== 'pending') return r
    return this.save({ ...r, sequence: r.sequence + 1, review: 'accepted' })
  }
  /** @param project - Changed project. @param version - Adopted baseline. */
  invalidate(project: ProjectId, version: string): void {
    for (const r of this.list()) if (r.request.binding.projectId === project && r.request.inputs.version !== version)
      this.save({ ...r, sequence: r.sequence + 1, freshness: 'stale', artifacts: r.artifacts.map(a => ({ ...a, freshness: 'stale' })) })
  }
  /** @param expected - Read revision. @returns Next revision; serial compare-and-swap rejects a competing update. */
  commitRelations(expected: number): number {
    if (expected !== this.relationRevision) throw new Error('Relation revision conflict')
    return ++this.relationRevision
  }
  /** @param update - Adapter update. @returns False for stale attempts/sequences or terminal records. */
  receive(update: Run): boolean {
    const r = this.get(update.id)
    if (update.attempt !== r.attempt || update.sequence <= r.sequence || !['running', 'cancelling'].includes(r.state)) return false
    if (JSON.stringify(update.request) !== JSON.stringify(r.request)) return false
    this.save(structuredClone(update)); return true
  }
  /** Mark active work interrupted; unloading never fabricates success or resubmits external writes. */
  dispose(): void {
    this.stopped = true
    for (const r of this.list()) if (['running', 'cancelling', 'queued'].includes(r.state))
      this.save({ ...r, sequence: r.sequence + 1, state: r.committed || r.request.operation === 'upload' ? 'unknown' : 'interrupted' })
  }
}

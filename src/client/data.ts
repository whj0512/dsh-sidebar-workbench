/** React-free projection. Async results remain keyed to their initiating Session and workspace. */
import type { IWorkspaces, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { DemoExecutor, type Run, type Operation, type Scenario, type Inputs, type ProjectId, type RunId } from '../shared/workflow.ts'
import { resultSchema, type ProjectCommand, type ProjectResult } from '../shared/project.ts'

export interface DataSnapshot {
  readonly workspace?: WorkspaceView
  readonly phase: 'loading' | 'unbound' | 'ready' | 'error' | 'removed'
  readonly runs: readonly Run[]
  readonly baseline: string
  readonly adopted: boolean
  readonly projectResult?: ProjectResult
  readonly projectLoading: boolean
}
export const demoInputs: Inputs = { version: 'V1', fingerprint: 'demo:V1', validationVersion: 'V1', syntax: true, unified: true,
  alignment: 'complete', uncovered: 0, accepted: true, ttl: true, abox: true, tbox: true, shacl: true }

/** @param source - Host snapshot. @param sessionId - Slot Session identity. @returns Exact member match, never a cwd guess. */
export function workspaceFor(source: WorkspaceSnapshot, sessionId: string): WorkspaceView | undefined {
  return source.items.find(workspace => workspace.sessionIds.some(id => id === sessionId))
}

/** Plugin-owned demo facts, retained across view remounts but never persisted into a real project. */
export class WorkbenchData {
  readonly executor = new DemoExecutor(2)
  private listeners = new Set<() => void>()
  private baselines = new Map<string, string>()
  private cache = new Map<string, DataSnapshot>()
  private request = 0
  private memberships = new Map<string, WorkspaceView>()
  private results = new Map<string, ProjectResult>()
  private loading = new Set<string>()
  private generations = new Map<string, number>()
  private unsubscribe: () => void
  /** @param workspaces - Authoritative host-owned membership projection. */
  constructor(private readonly workspaces: Pick<IWorkspaces, 'list'>, private readonly remote?: (request: ProjectCommand) => Promise<ProjectResult>) {
    this.unsubscribe = workspaces.list.subscribe(() => this.changed())
  }
  private changed(): void { this.cache.clear(); for (const fn of this.listeners) fn() }
  /** @param sessionId - Slot scope. @returns Stable observable understood by Slot injection. */
  source(sessionId: string) {
    return { subscribe: (fn: () => void) => { this.listeners.add(fn); void this.project(sessionId, 'inspect'); return () => { this.listeners.delete(fn) } },
      getSnapshot: (): DataSnapshot => {
        const cached = this.cache.get(sessionId)
        if (cached) return cached
        const source = this.workspaces.list.getSnapshot()
        const member = workspaceFor(source, sessionId)
        if (member) this.memberships.set(sessionId, member)
        const workspace = member ?? this.memberships.get(sessionId)
        const key = workspace?.workspaceId ?? `unbound:${sessionId}`
        const snapshot: DataSnapshot = { workspace,
          phase: source.state === 'error' ? 'error' : source.phase === 'pending' ? 'loading' : member ? 'ready' : workspace ? 'removed' : 'unbound',
          runs: this.executor.list().filter(r => r.request.binding.workspaceId === key),
          baseline: this.baselines.get(key) ?? 'V1', adopted: this.baselines.has(key),
          projectResult: this.results.get(key), projectLoading: this.loading.has(key) }
        this.cache.set(sessionId, snapshot); return snapshot
      } }
  }
  /** @param sessionId - Initiating Session. @param action - Explicit project command. @param fields - Materials or reassociation identity. */
  async project(sessionId: string, action: ProjectCommand['action'], fields: Pick<ProjectCommand, 'materials' | 'expectedProjectId'> = {}): Promise<void> {
    const source = this.workspaces.list.getSnapshot()
    const ws = workspaceFor(source, sessionId)
    if (source.phase !== 'ready' || source.state === 'error' || !ws || !this.remote || this.loading.has(ws.workspaceId)) return
    const key = ws.workspaceId
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation); this.loading.add(key); this.changed()
    try {
      const result = resultSchema.parse(await this.remote({ action, sessionId, workspaceId: key, ...fields }))
      if (this.generations.get(key) === generation) this.results.set(key, result)
    } catch (error) {
      // Transport and validation failures leave existing project facts visible; no mutation is retried.
      console.warn('Workbench project request failed', error instanceof Error ? error.message : 'Invalid response')
      if (this.generations.get(key) === generation) this.results.set(key, { ...this.results.get(key), ok: false, problem: 'unavailable' })
    } finally { this.loading.delete(key); this.changed() }
  }
  /** @param sessionId - Owning Session. @param operation - Explicit demo action. @param scope - Selected features. @param scenario - Controlled adapter outcome. @returns Created demo runs. */
  start(sessionId: string, operation: Operation, scope: readonly string[], scenario: Scenario): readonly Run[] {
    const s = this.source(sessionId).getSnapshot()
    const key = s.workspace?.workspaceId ?? `unbound:${sessionId}`
    const binding = { workspaceId: key, projectId: `demo:${key}` as ProjectId, revision: 1, root: `demo:/${key}`, valid: s.phase !== 'removed' && s.phase !== 'error' }
    const version = operation === 'update' ? 'V2' : s.baseline
    const items = operation === 'model' ? scope.map(item => [item]) : [scope]
    const result = items.map(selected => this.executor.start({ key: `${++this.request}`, binding, operation,
      inputs: { ...demoInputs, version, validationVersion: version, fingerprint: `demo:${version}` },
      scope: selected, target: 'demo:graph', repository: 'requirement', scenario }))
    this.changed(); return result
  }
  /** @param id - Demo record. @param action - Explicit simulation control. */
  act(id: RunId, action: 'advance' | 'cancel' | 'confirmCancel' | 'reconcile' | 'accept' | 'grant' | 'retry'): void {
    const run = this.executor.get(id)
    switch (action) {
      case 'retry': this.executor.retry(id, `retry:${++this.request}`); break
      case 'advance': this.executor.advance(id, { ...run.request.binding,
        valid: run.request.binding.workspaceId.startsWith('unbound:') || this.workspaces.list.getSnapshot().items.some(w => w.workspaceId === run.request.binding.workspaceId) }); break
      case 'cancel': this.executor.cancel(id); break
      case 'confirmCancel': this.executor.confirmCancel(id); break
      case 'reconcile': this.executor.reconcile(id, false); break
      case 'grant': {
        const r = run.request
        if (r.operation === 'upload' || r.operation === 'infer') this.executor.grant(id, {
          operation: r.operation, target: r.target, repository: r.repository, version: r.inputs.version,
          fingerprint: r.inputs.fingerprint, scope: r.scope,
        }); break
      }
      case 'accept': {
        const accepted = this.executor.accept(id)
        if (accepted.review === 'accepted') {
          this.baselines.set(run.request.binding.workspaceId, run.request.inputs.version)
          this.executor.invalidate(run.request.binding.projectId, run.request.inputs.version)
        }
        break
      }
    }
    this.changed()
  }
  /** Release workspace and view subscriptions; demo work becomes interrupted. */
  dispose(): void { this.unsubscribe(); this.executor.dispose(); this.listeners.clear(); this.cache.clear() }
}

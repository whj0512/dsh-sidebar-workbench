/** Itemization admission, durable stage transitions, recovery and whole-candidate review. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ProjectService } from './project-service.ts'
import { confined } from './project-service.ts'
import { ItemizationStore, ItemizationError } from './itemization-store.ts'
import { candidateReferenceSchema, type MaterialVersion, type CandidateReference } from '../shared/itemization.ts'
import { compareItemizations, type FeatureId, type ItemizationDiff } from '../shared/itemization-diff.ts'
import { inspectMaterial, type ProjectConfig } from './material-inspection.ts'
import { isTerminalItemizationState, itemizationCommandSchema, type ItemizationCommand, type ItemizationConfig, type ItemizationResult, type ItemizationRun } from '../shared/itemization-api.ts'
import { boundedFile, candidateIndexSchema, chunksSchema, collectRunArtifacts, sha256, snapshotMaterials, writeOwned, type CandidateIndex } from './itemization-files.ts'
import { ItemizerExecutionError, type ItemizerRuntime } from './itemizer-runtime.ts'
import { importOriginalItemization } from './original-itemization-output.ts'

export interface ItemizationRepository { list(): readonly ItemizationRun[]; put(run: ItemizationRun): Promise<void> }

/** The Host owns jobs independently of the life of a browser view. */
export class ItemizationService {
  private runtime?: ItemizerRuntime
  private stopped = false
  private admission: Promise<void> = Promise.resolve()
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private writes = new Map<string, Promise<void>>()
  /** @param projects - Project identity and membership owner. @param records - Host storage. @param config - Execution budgets. @param limits - Resource limits. @param report - Independent error reporting when persistence fails. */
  constructor(private readonly projects: ProjectService, private readonly records: ItemizationRepository,
    private readonly config: ItemizationConfig, private readonly limits: ProjectConfig, private readonly report: (error: unknown) => void) {}
  /** @param runtime - Currently mounted public-service adapter. Omission disables admission. */
  setRuntime(runtime?: ItemizerRuntime): void { this.runtime = runtime }
  /** @param runtime - Adapter whose provider fiber is unloading. @returns All its consumers stopped before provider release. */
  async detachRuntime(runtime: ItemizerRuntime): Promise<void> {
    if (this.runtime !== runtime) return
    this.runtime = undefined
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map(job => job.done))
  }
  /** @param projectId - Project identity. @returns Whether any durable job still requires reconciliation. */
  unsettled(projectId: string): boolean { return this.records.list().some(run => run.projectId === projectId && !isTerminalItemizationState(run.state)) }
  private visibleRuns(projectId: string): ItemizationRun[] {
    return this.records.list().filter(run => run.projectId === projectId && run.deletedAt === undefined)
  }
  private get(id: string): ItemizationRun {
    const run = this.records.list().find(item => item.id === id)
    if (!run) throw new ItemizationError('invalid')
    return run
  }
  private async change(id: string, update: (run: ItemizationRun) => ItemizationRun): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const run = this.get(id)
      const updated = update(run)
      if (updated === run) return
      await this.records.put({ ...updated, sequence: run.sequence + 1, updatedAt: new Date().toISOString() })
    })
    const settled = next.then(() => {}, () => {})
    this.writes.set(id, settled)
    try {
      await next
    } finally {
      if (this.writes.get(id) === settled) this.writes.delete(id)
    }
  }
  private async scope(request: ItemizationCommand) {
    const result = await this.projects.execute({ action: 'inspect', sessionId: request.sessionId, workspaceId: request.workspaceId })
    if (!result.ok || !result.project || !result.binding || result.binding.status !== 'active') throw new ItemizationError('identity')
    return { project: result.project, binding: result.binding, resources: result.resources,
      store: new ItemizationStore(result.binding.root, result.project.projectId) }
  }
  private async check(run: ItemizationRun): Promise<void> {
    const project = await readFile(await confined(run.root, '.workbench/project.json'), 'utf8')
    const identity: unknown = JSON.parse(project)
    if (!identity || typeof identity !== 'object' || !('projectId' in identity) || identity.projectId !== run.projectId) throw new ItemizationError('identity')
    // The initiating Session remains the permission anchor, not the execution
    // Session that may have changed its current working directory.
    const request = itemizationCommandSchema.parse(JSON.parse((await boundedFile(run.root, `workbench-runs/${run.id}/request.json`, this.limits.maxMaterialBytes)).toString('utf8')))
    const current = await this.scope(request)
    if (current.binding.revision !== run.bindingRevision || current.binding.root !== run.root || current.binding.projectId !== run.projectId) throw new ItemizationError('identity')
  }
  /** @param request - Owner-authorized wire command. @returns Structured state; failed queries retain their failure identity. */
  async execute(request: ItemizationCommand): Promise<ItemizationResult> {
    if (this.stopped) return { ok: false, problem: 'unavailable' }
    try {
      if (request.action === 'start') {
        let response: ItemizationResult = { ok: false, problem: 'unavailable' }
        const job = this.admission.then(async () => { response = await this.start(request) })
        this.admission = job.then(() => {}, () => {})
        await job; return response
      }
      const { project, binding, store } = await this.scope(request)
      if (request.action === 'delete-run') {
        if (this.stopped) return { ok: false, problem: 'unavailable' }
        await this.change(request.runId ?? '', run => {
          if (run.projectId !== project.projectId) throw new ItemizationError('identity')
          if (run.deletedAt !== undefined) return run
          if (this.jobs.has(run.id) || !isTerminalItemizationState(run.state)) throw new ItemizationError('run-not-settled')
          return { ...run, deletedAt: new Date().toISOString() }
        })
        return { ok: true, runs: this.visibleRuns(project.projectId) }
      }
      const state = await store.read()
      const runs = this.visibleRuns(project.projectId)
      if (request.action === 'inspect') return { ok: true, available: !!this.runtime, state, runs, pollIntervalMs: this.config.pollIntervalMs }
      if (request.action === 'cancel' || request.action === 'reconcile') {
        const run = this.get(request.runId ?? '')
        if (run.projectId !== project.projectId) throw new ItemizationError('identity')
        const active = this.jobs.get(run.id)
        if (request.action === 'cancel' && active && !isTerminalItemizationState(run.state)) {
          await this.change(run.id, old => isTerminalItemizationState(old.state) ? old : { ...old, state: 'cancelling' })
          active.controller.abort()
        } else if (request.action === 'reconcile' && !active && !isTerminalItemizationState(run.state)) {
          const candidate = state?.candidates.find(item => item.id === run.candidateId)
          if (candidate) {
            for (const artifact of candidate.artifacts) if (sha256(await boundedFile(run.root, artifact.path, this.limits.maxMaterialBytes)) !== artifact.sha256) throw new ItemizationError('changed')
            await this.change(run.id, old => isTerminalItemizationState(old.state) ? old : { ...old, state: 'succeeded', stage: 'finished', artifacts: candidate.artifacts.map(item => item.path), problem: undefined })
          } else if (run.state === 'unknown') throw new ItemizerExecutionError('unknown', 'Execution range requires external reconciliation')
          else await this.change(run.id, old => isTerminalItemizationState(old.state) ? old : { ...old, state: 'cancelled', problem: 'interrupted' })
        }
        return { ok: true, state: await store.read(), runs: this.visibleRuns(project.projectId) }
      }
      const candidate = state?.candidates.find(item => item.id === request.candidateId)
      if (!state || !candidate) throw new ItemizationError('unreviewed')
      const material = state.materials.find(item => item.id === candidate.materialId)
      if (request.action === 'candidate') {
        const index = await this.readIndex(binding.root, candidate.runId)
        const chunks = JSON.parse((await boundedFile(binding.root, index.contentPath ?? `workbench-runs/${candidate.runId}/candidate/chunks.json`, this.limits.maxMaterialBytes)).toString('utf8'))
        const validation = await this.reviewValidation(binding.root, candidate, project.projectId, material)
        return { ok: true, state, content: JSON.stringify({ index, chunks, validation }), runs }
      }
      const next = await this.readIndex(binding.root, candidate.runId)
      const baseline = state.candidates.find(item => item.id === state.baseline)
      const previous = baseline ? await this.readIndex(binding.root, baseline.runId) : undefined
      const comparison = compareItemizations(previous?.functions ?? [], next.functions, (request.matches ?? []).map(match => ({ previous: match.previous as FeatureId, candidate: match.candidate as FeatureId })), previous?.relations, next.relations)
      const fullDiff: ItemizationDiff = previous && previous.relationFingerprint !== next.relationFingerprint
        ? { ...comparison, relationsChanged: true, affected: [...new Set([...comparison.affected, ...next.functions.map(item => item.id)])] } : comparison
      const { reviewBlocked, approvalReason } = await this.reviewValidation(binding.root, candidate, project.projectId, material)
      const adoptionReview = { reviewBlocked, approvalReason }
      const fingerprint = sha256(JSON.stringify({ revision: state.revision, candidate: candidate.id, fullDiff, adoptionReview, confirmUnmatched: request.confirmUnmatched === true }))
      if (request.action === 'compare') return { ok: true, state, comparison: JSON.stringify({ ...fullDiff, adoptionReview,
        details: { previous: previous?.functions ?? [], candidate: next.functions,
          previousRelations: baseline ? previous?.relationPath ?? `workbench-runs/${baseline.runId}/candidate/requirement_relations.json` : null,
          candidateRelations: next.relationPath ?? `workbench-runs/${candidate.runId}/candidate/requirement_relations.json` } }), impactFingerprint: fingerprint }
      if (request.expectedRevision !== state.revision || request.impactFingerprint !== fingerprint || fullDiff.unmatched.length && !request.confirmUnmatched) throw new ItemizationError('conflict')
      if (reviewBlocked) throw new ItemizationError('source-conflict')
      await this.check(this.get(candidate.runId))
      const adopted = await store.adopt(candidate.id, state.revision, fullDiff.affected, {
        matches: [...fullDiff.matches], confirmedUnmatched: request.confirmUnmatched === true, approvalReason,
      })
      return { ok: true, state: adopted, runs }
    } catch (error) {
      this.report(error)
      const problem = error instanceof ItemizationError ? error.code : error instanceof ItemizerExecutionError ? error.code : 'storage'
      return { ok: false, problem: problem === 'unknown' ? 'storage' : problem === 'identity' ? 'identity' : problem === 'invalid' ? 'invalid' : problem }
    }
  }

  private async readIndex(root: string, runId: string): Promise<CandidateIndex> {
    return candidateIndexSchema.parse(JSON.parse((await boundedFile(root, `workbench-runs/${runId}/candidate/index.json`, this.limits.maxMaterialBytes)).toString('utf8')))
  }
  private async reviewValidation(root: string, candidate: CandidateReference, projectId: string, material?: MaterialVersion) {
    const reportSchema = z.object({ passed: z.boolean(), issues: z.array(z.object({ code: z.string() }).passthrough()) }).passthrough()
    const readReport = async (path: string) => reportSchema.parse(JSON.parse((await boundedFile(root, path, this.limits.maxMaterialBytes)).toString('utf8')))
    const latest = await readReport(`workbench-runs/${candidate.runId}/validation.json`)
    const retained = z.object({ sourceConflicts: z.array(z.object({ report: z.string(), issues: z.unknown() })).optional(), reviewBlocked: z.boolean().optional() }).passthrough().parse(latest)
    const sourceConflicts: { report: string; issues: unknown }[] = [...retained.sourceConflicts ?? []]
    for (const hold of this.config.reviewHolds) {
      if (hold.markdownSha256 === material?.markdownSha256) sourceConflicts.push({ report: 'Human review decision', issues: [{ description: hold.reason }] })
    }
    for (const artifact of candidate.artifacts) {
      if (!/\/candidate\/validation-\d+\.json$/.test(artifact.path)) continue
      if (!(await readReport(artifact.path)).issues.some(issue => issue.code === 'unresolved')) continue
      const draft = chunksSchema.parse(JSON.parse((await boundedFile(root, artifact.path.replace(/validation-(\d+)\.json$/, 'submission-$1.json'), this.limits.maxMaterialBytes)).toString('utf8')))
      sourceConflicts.push({ report: artifact.path, issues: draft.project_relation_seed.consistency_issues })
    }
    const reviewBlocked = retained.reviewBlocked === true || !latest.passed || sourceConflicts.length > 0
    const approval = latest.passed && latest.issues.length === 0 && sourceConflicts.length > 0
      ? this.config.candidateApprovals.find(item => item.projectId === projectId && item.candidateId === candidate.id)
      : undefined
    return { ...latest, reviewBlocked: reviewBlocked && !approval, sourceConflicts, approvalReason: approval?.reason }
  }
  private async start(request: ItemizationCommand): Promise<ItemizationResult> {
    if (!request.requestKey) throw new ItemizationError('invalid')
    const { project, binding, resources, store } = await this.scope(request)
    let state = await store.read()
    const parent = state?.candidates.find(item => item.id === request.parentCandidateId)
    if (request.parentCandidateId && !parent) throw new ItemizationError('invalid')
    const selection = request.materials ?? project.materials
    const baseline = state?.candidates.find(item => item.id === state?.baseline)
    const defaultMaterial = !request.materials ? state?.materials.find(item => item.id === baseline?.materialId) ?? state?.materials.at(-1) : undefined
    const material = parent ? state?.materials.find(item => item.id === parent.materialId) : defaultMaterial
    if (!material && !selection) throw new ItemizationError('invalid')
    if (!material && !request.materials && resources?.some(item => item.kind !== 'artifact' && item.status !== 'valid')) throw new ItemizationError('changed')
    const inputDigests = material ? [material.originalSha256, material.markdownSha256] : await Promise.all([
      inspectMaterial(await confined(binding.root, selection!.original), selection!.original, 'original', this.limits),
      inspectMaterial(await confined(binding.root, selection!.markdown), selection!.markdown, 'markdown', this.limits),
    ]).then(items => { if (items.some(item => item.status !== 'valid')) throw new ItemizerExecutionError('validation'); return items.map(item => item.sha256) })
    const fingerprint = sha256(JSON.stringify({ version: material?.label ?? selection?.version, inputDigests, feedback: request.feedback ?? '', parent: request.parentCandidateId ?? null, binding: binding.revision }))
    const old = this.records.list().find(item => item.projectId === project.projectId && item.requestKey === request.requestKey)
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ItemizationError('conflict')
      return { ok: true, state, runs: this.visibleRuns(project.projectId) }
    }
    const runtime = this.runtime
    if (!runtime) throw new ItemizerExecutionError('executor')
    if (this.jobs.size >= this.config.maxConcurrentItemizations || this.unsettled(project.projectId)) throw new ItemizationError('conflict')
    await runtime.probe(AbortSignal.timeout(this.config.terminationGraceMs * 4))
    if (this.stopped || this.runtime !== runtime) throw new ItemizerExecutionError('executor')
    let input = material
    if (!input) {
      input = await snapshotMaterials(binding.root, selection!, this.limits)
      const existing = state?.materials.find(item => item.label === input!.label)
      if (existing) {
        if (existing.originalSha256 !== input.originalSha256 || existing.markdownSha256 !== input.markdownSha256) throw new ItemizationError('conflict')
        input = existing
      } else state = await store.registerMaterial(input, state?.revision ?? 0)
    }
    const id = randomUUID(), now = new Date().toISOString()
    const run: ItemizationRun = { schema: 1, id, workspaceId: binding.workspaceId, projectId: project.projectId, root: binding.root,
      bindingRevision: binding.revision, requestKey: request.requestKey, fingerprint, materialId: input.id, candidateId: randomUUID(),
      parentCandidateId: parent?.id, feedback: request.feedback ?? '', state: 'queued', stage: 'snapshot', sequence: 1,
      comparisonBaseCandidateId: parent?.id ?? baseline?.id,
      operation: parent ? 'adjustment' : request.materials ? 'new-version' : 'initial',
      createdAt: now, updatedAt: now, artifacts: [] }
    await writeOwned(binding.root, `workbench-runs/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`)
    await this.records.put(run)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new ItemizerExecutionError('timeout')), this.config.operationTimeoutMs)
    const done = this.run(run, input, runtime, controller.signal).catch(this.report).finally(() => { clearTimeout(timer); this.jobs.delete(id) })
    this.jobs.set(id, { controller, done })
    return { ok: true, state, runs: this.visibleRuns(project.projectId) }
  }
  private async run(run: ItemizationRun, material: MaterialVersion, runtime: ItemizerRuntime, signal: AbortSignal): Promise<void> {
    const directory = `workbench-runs/${run.id}`, candidate = `${directory}/candidate`
    const advance = async (stage: ItemizationRun['stage']) => { signal.throwIfAborted(); await this.check(run); await this.change(run.id, old => ({ ...old, stage })) }
    try {
      signal.throwIfAborted()
      await this.change(run.id, old => ({ ...old, state: 'running' }))
      await writeOwned(run.root, `${candidate}/.staging`, 'Candidate under validation\n')
      await advance('original')
      await advance('segment')
      const previous = (await new ItemizationStore(run.root, run.projectId).read())?.candidates.find(item => item.id === run.comparisonBaseCandidateId)
      await runtime.segment({ runId: run.id, workspaceId: run.workspaceId, root: run.root,
        materialLabel: material.label,
        originalDocument: await confined(run.root, material.original), markdown: await confined(run.root, material.markdown),
        assets: await Promise.all((material.assets ?? []).map(async asset => ({ reference: asset.reference, path: await confined(run.root, asset.path) }))),
        operation: run.operation ?? 'initial', previousDirectory: previous ? await confined(run.root, `workbench-runs/${previous.runId}/candidate`) : undefined,
        output: await confined(run.root, `${candidate}/chunks.json`, true), feedback: run.feedback, signal,
        onSession: sessionId => this.change(run.id, old => ({ ...old, sessionId })) })
      await advance('validate')
      await advance('relations')
      const baselineState = await new ItemizationStore(run.root, run.projectId).read()
      const comparisonBase = baselineState?.candidates.find(item => item.id === run.comparisonBaseCandidateId)
      const indexed = await importOriginalItemization(run.root, run.id, material, this.limits, comparisonBase ? await this.readIndex(run.root, comparisonBase.runId) : undefined)
      await advance('publish')
      const store = new ItemizationStore(run.root, run.projectId), state = await store.read()
      await store.publishCandidate(candidateReferenceSchema.parse({ id: run.candidateId, materialId: material.id, runId: run.id,
        parentCandidateId: run.parentCandidateId, artifacts: indexed.artifacts }), state?.revision ?? 0)
      await this.change(run.id, old => ({ ...old, state: 'succeeded', stage: 'finished', artifacts: indexed.artifacts.map(item => item.path) }))
    } catch (error) {
      this.report(error)
      let published = false, stateUnreadable = false
      try { published = !!(await new ItemizationStore(run.root, run.projectId).read())?.candidates.some(item => item.id === run.candidateId) }
      catch (stateError) { stateUnreadable = true; this.report(stateError) }
      const uncertain = stateUnreadable || published || error instanceof ItemizerExecutionError && error.code === 'unknown'
      const timeout = signal.aborted && signal.reason instanceof ItemizerExecutionError && signal.reason.code === 'timeout'
      let reports: string[] = []
      try { reports = (await collectRunArtifacts(run.root, run.id, this.limits)).map(item => item.path) }
      catch (reportError) { this.report(reportError) }
      await this.change(run.id, old => ({ ...old, state: uncertain ? 'unknown' : signal.aborted && !timeout ? 'cancelled' : 'failed', artifacts: [...new Set([...old.artifacts, ...reports])],
        problem: signal.aborted && !timeout && !uncertain ? undefined : timeout ? 'timeout' : error instanceof ItemizerExecutionError ? error.code : error instanceof ItemizationError ? error.code : 'storage' }))
    }
  }
  /** @returns Recovery marks orphaned active records without starting model work. */
  async recover(): Promise<void> {
    for (const run of this.records.list()) if (['queued', 'running', 'cancelling'].includes(run.state)) await this.change(run.id, old => ({ ...old, state: 'interrupted' }))
  }
  /** @returns Quiescence of all owned operations before storage and project services are released. */
  async close(): Promise<void> {
    this.stopped = true; this.runtime = undefined
    await this.admission
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map(job => job.done))
    await Promise.all(this.writes.values())
  }
}

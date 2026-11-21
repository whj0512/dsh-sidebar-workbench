import type { LanguageServiceUrls } from '../shared/model-editor.ts'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import type { ItemizationConfig } from '../shared/itemization-api.ts'
import { modelKinds, modelRunActive, modelRunDeletable, modelRunUnsettled, type ModelKind, type ModelProblem, type ModelingCommand, type ModelingResult, type ModelingRun } from '../shared/modeling-api.ts'
import type { ProjectBinding } from '../shared/project.ts'
import { boundedFile, candidateIndexSchema, collectRunArtifacts, imageReferences, sha256, writeOwned } from './itemization-files.ts'
import { ItemizationStore } from './itemization-store.ts'
import type { ProjectConfig } from './material-inspection.ts'
import { checkedDelta, featureRelationsHash, mergeModelRelations, relationDeltaSchema, relationSeedSchema, type RelationSeed } from './modeling-relations.ts'
import { ModelExecutionError, parseOutputs, reportName, type ModelingAgent, type ModelingRuntime } from './modeling-runtime.ts'
import { ModelArtifactChanged, ModelingStore, type ModelPublication } from './modeling-store.ts'
import { makeMapping, modelReceipts, modelingDirectories, registrySchema, requirementsSchema, unchangedModelReceipt, unifiedChecks, validateIfThen, type ModelSource } from './modeling-validation.ts'
import { confined, ProjectError, type ProjectService } from './project-service.ts'
import { defaultConverterUrl, ModelEditorConverter, ModelEditorError } from './model-editor-converter.ts'
import { editorBase, editorJson, editorRevisionPath, editorSummary, ModelEditorStore, type EditorRevision } from './model-editor-store.ts'

export interface ModelingRepository { list(): readonly ModelingRun[]; put(run: ModelingRun): Promise<void> }
class ModelProblemError extends Error {
  constructor(readonly code: ModelProblem, detail?: string) { super(detail ?? code) }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 3500)
const problemOf = (error: unknown, fallback: ModelProblem): ModelProblem => {
  if (error instanceof ModelProblemError || error instanceof ModelExecutionError || error instanceof ProjectError || error instanceof ModelEditorError) return error.code
  return error instanceof ModelArtifactChanged ? 'changed' : fallback
}
const parse = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
type Scope = Awaited<ReturnType<ModelingService['scope']>>
type Start = Extract<ModelingCommand, { action: 'start' }>
type EditorRequest = Extract<ModelingCommand, { action: `editor-${string}` }>
type ModelJob = {
  run: ModelingRun
  abort: AbortController
  done: Promise<void>
  expectedPublication?: ModelPublication
}

function samePublication(a: ModelPublication | undefined, b: ModelPublication | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Project coordination shared only by operations that publish an adopted baseline or model. */
export class ModelCommitQueue {
  private tails = new Map<string, Promise<void>>()

  async run<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const task = (this.tails.get(projectId) ?? Promise.resolve()).then(action)
    const settled = task.then(() => {}, () => {})
    this.tails.set(projectId, settled)
    try { return await task }
    finally {
      if (this.tails.get(projectId) === settled) this.tails.delete(projectId)
    }
  }
}

export class ModelingService {
  private runtime?: ModelingRuntime
  private stopped = false
  private admission: Promise<void> = Promise.resolve()
  private updates = new ModelCommitQueue()
  private jobs = new Map<string, ModelJob>()
  private readonly converter: ModelEditorConverter

  constructor(private readonly projects: ProjectService, private readonly records: ModelingRepository,
    private readonly config: ItemizationConfig, private readonly limits: ProjectConfig, private readonly commits: ModelCommitQueue,
    private readonly report: (error: unknown) => void, converterBaseUrl = defaultConverterUrl,
    private readonly languageServiceUrls: LanguageServiceUrls = {}) {
    this.converter = new ModelEditorConverter(converterBaseUrl, config.pythonExecutable)
  }

  setRuntime(runtime: ModelingRuntime): void { if (!this.stopped) this.runtime = runtime }

  async detachRuntime(runtime: ModelingRuntime): Promise<void> {
    if (this.runtime !== runtime) return
    this.runtime = undefined
    await this.stopJobs()
  }

  unsettled(projectId: string): boolean {
    return this.records.list().some(run => run.projectId === projectId && (this.jobs.has(run.id) || modelRunUnsettled(run.state)))
  }

  executionSessions(binding: Pick<ProjectBinding, 'projectId' | 'root'>) {
    return this.records.list().flatMap(run =>
      run.projectId === binding.projectId && run.root === binding.root && run.executionSessionId
        ? [{ sessionId: run.executionSessionId, runId: run.id }]
        : [],
    )
  }

  private get(id: string): ModelingRun {
    const run = this.records.list().find(run => run.id === id)
    if (!run) throw new ModelProblemError('invalid')
    return run
  }

  private change(id: string, update: Partial<ModelingRun> | ((run: ModelingRun) => Partial<ModelingRun> | undefined)): Promise<void> {
    return this.updates.run(id, async () => {
      const run = this.get(id)
      const patch = typeof update === 'function' ? update(run) : update
      if (patch) await this.records.put({ ...run, ...patch, sequence: run.sequence + 1, updatedAt: new Date().toISOString() })
    })
  }

  private store(binding: Pick<ProjectBinding, 'root' | 'projectId'>) { return new ModelingStore(binding.root, binding.projectId, this.limits.maxMaterialBytes) }

  private async scope(request: Pick<ModelingCommand, 'sessionId' | 'workspaceId'>) {
    const result = await this.projects.execute({ action: 'inspect', sessionId: request.sessionId, workspaceId: request.workspaceId })
    if (!result.ok || !result.binding || result.binding.status !== 'active') throw new ModelProblemError(result.problem ?? 'unbound')
    const binding = result.binding
    const state = await new ItemizationStore(binding.root, binding.projectId).read()
    const candidate = state?.candidates.find(item => item.id === state.baseline)
    const material = state?.materials.find(item => item.id === candidate?.materialId)
    return { binding, candidate, material }
  }

  private async check(run: ModelingRun): Promise<Scope> {
    const scope = await this.scope(run.request)
    if (scope.binding.root !== run.root || scope.binding.revision !== run.bindingRevision || scope.binding.projectId !== run.projectId) {
      throw new ModelProblemError('identity')
    }
    if (scope.candidate?.id !== run.baselineId) throw new ModelProblemError('conflict', 'Adopted baseline changed')
    return scope
  }

  private registered(scope: Scope, path: string) {
    const ref = scope.candidate?.artifacts.find(item => item.path === path)
    if (!ref || !path.startsWith(`workbench-runs/${scope.candidate?.runId}/`)) throw new ModelProblemError('validation', `Unregistered baseline file: ${path}`)
    return ref
  }

  private async readIndex(scope: Scope) {
    const folder = `workbench-runs/${scope.candidate?.runId}/candidate`
    const value = await this.store(scope.binding).verified(this.registered(scope, `${folder}/index.json`))
    const index = candidateIndexSchema.parse(parse(value))
    return { index, folder, seed: index.relationPath ?? `${folder}/requirement_relations.json`, chunks: index.sourceChunks ?? `${folder}/chunks.json` }
  }

  async execute(request: ModelingCommand): Promise<ModelingResult> {
    if (this.stopped) return { ok: false, problem: 'unavailable' }
    try {
      if (request.action === 'start') {
        const task = this.admission.then(() => this.start(request))
        this.admission = task.then(() => {}, () => {})
        return await task
      }
      const scope = await this.scope(request)
      if (request.action === 'inspect') return await this.inspect(scope)
      const run = this.get(request.runId)
      if (run.projectId !== scope.binding.projectId || run.root !== scope.binding.root) throw new ModelProblemError('identity')
      if (request.action === 'delete-run') {
        await this.change(run.id, current => {
          if (current.deletedAt !== undefined) return
          if (this.jobs.has(current.id) || !modelRunDeletable(current.state)) throw new ModelProblemError('run-not-deletable')
          return { deletedAt: new Date().toISOString() }
        })
        const snapshot = await this.inspect(scope).catch(error => {
          this.report(error)
          return { ok: true }
        })
        return { ...snapshot, deletedRunId: run.id }
      }
      if (request.action === 'editor-open' || request.action === 'editor-convert' || request.action === 'editor-save' || request.action === 'editor-adopt') {
        return await this.edit(request, run, scope)
      }
      if (request.action === 'artifact') {
        const artifact = run.artifacts.find(item => item.path === request.path)
        if (!artifact || !artifact.path.startsWith(`workbench-runs/${run.id}/`) || !/\.(?:md|json|dsl|txt)$/i.test(artifact.path)) {
          throw new ModelProblemError('invalid')
        }
        const content = (await this.store(scope.binding).verified(artifact)).toString('utf8')
        if (content.length > 2_000_000) return { ok: false, problem: 'validation', detail: 'Preview limit exceeded; open the registered source file.' }
        return { ok: true, content }
      }
      const active = this.jobs.get(run.id)
      if (request.action === 'cancel' && active) {
        await this.change(run.id, current => modelRunActive(current.state) ? { state: 'cancelling' } : undefined)
        active.abort.abort(new ModelProblemError('invalid', 'cancelled'))
      }
      if (request.action === 'reconcile' && !active && run.state === 'interrupted') await this.reconcile(run, true)
      return await this.inspect(scope)
    } catch (error) {
      const problem = problemOf(error, 'storage')
      if (problem === 'storage') this.report(error)
      return { ok: false, problem, detail: message(error) }
    }
  }

  private async inspect(scope: Scope): Promise<ModelingResult> {
    const { binding, candidate, material } = scope
    const store = this.store(binding)
    const publication = await store.read()
    const latest = publication && publication.baselineId === candidate?.id ? publication : undefined
    const latestRelations = latest ? relationSeedSchema.parse(parse(await store.verified(latest.relations))) : undefined
    const records = this.records.list().filter(run => run.projectId === binding.projectId && run.root === binding.root && run.deletedAt === undefined)
    const versions = new Map(latest?.models.map(model => [model.featureId, model]))
    const runs = records.map(({ schema: _schema, projectId: _project, bindingRevision: _binding, root: _root, request: _request,
      expectedRelationRevision: _revision, sourceSha256: _source, seedSha256: _seed, deletedAt: _deleted, ...run }) => {
      const model = versions.get(run.feature.id)
      const stale = run.baselineId !== candidate?.id || (!!latestRelations &&
        (model?.runId === run.id
          ? model.relationSha256 !== featureRelationsHash(latestRelations, run.feature.name)
          : run.state === 'succeeded'))
      return { ...run, stale, ...(model?.runId === run.id && !stale ? { currentEditorRevision: model.editorRevisionId } : {}) }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const common = { ok: true, available: !!this.runtime, runs, pollIntervalMs: this.config.pollIntervalMs }
    if (!candidate || !material) return { ...common, baseline: null, features: [] }
    const { index } = await this.readIndex(scope)
    return { ...common, baseline: { id: candidate.id, label: material.label },
      features: index.functions.map(({ id, name, requirementId, path }) => ({ id, name, requirementId, section: posix.basename(path).match(/^\d+(?:\.\d+)*/)?.[0] })) }
  }

  private async edit(request: EditorRequest, run: ModelingRun, scope: Scope): Promise<ModelingResult> {
    if (run.state !== 'succeeded' && run.state !== 'failed') throw new ModelProblemError('unsettled')
    const store = this.store(scope.binding)
    const files = new ModelEditorStore(run, store, this.limits.maxMaterialBytes)
    const catalog = await files.catalog()
    const latest = catalog.at(-1)
    const parent = catalog.find(item => item.id === request.revisionId)
    if (request.revisionId && !parent) throw new ModelProblemError('invalid', 'Unknown editor revision')
    const checkBaseline = async () => {
      const current = await this.scope(request)
      if (current.binding.projectId !== run.projectId || current.binding.root !== run.root ||
        current.binding.revision !== run.bindingRevision) throw new ModelProblemError('identity')
      if (current.candidate?.id !== run.baselineId) throw new ModelProblemError('conflict', 'Adopted baseline changed')
      return current
    }
    const publication = await store.read()
    const adopted = publication?.baselineId === run.baselineId
      ? publication.models.find(item => item.runId === run.id)?.editorRevisionId ?? null : null
    const revisionInfo = { revisions: catalog.map(item => editorSummary(run, item)), latest: latest?.id ?? null,
      adopted, publication: publication?.revision ?? 0 }
    if (request.action === 'editor-adopt') {
      await this.adoptEditor(request, run, files, parent!, checkBaseline)
      return { ok: true, editor: { ...revisionInfo, adopted: parent!.id, publication: request.publication + 1 } }
    }
    const target = files.files(parent).find(item => item.file === request.file)
    if (!target) throw new ModelProblemError('invalid', 'DSL file is not registered for this revision')
    const { file, artifact, kind } = target
    const text = await files.text(artifact)
    const ports = { Environment: 3001, ExternalScenario: 3002, Statechart: 3000, DialogMap: 3004 }
    const languageServiceUrl = this.languageServiceUrls[kind] ?? `ws://127.0.0.1:${ports[kind]}`
    if (request.action === 'editor-open') {
      return { ok: true, editor: { ...revisionInfo, file, text, languageServiceUrl, hash: artifact.sha256,
        layout: parent?.layout[file], map: await files.map(parent), review: parent?.review } }
    }
    if (request.hash !== artifact.sha256) throw new ModelProblemError('changed', 'The draft was opened from different DSL bytes')
    if (request.action === 'editor-save') {
      await checkBaseline()
      if (request.expectedLatest !== revisionInfo.latest) throw new ModelProblemError('conflict', 'Another editor saved a revision')
    }
    const env = kind === 'ExternalScenario' ? files.files(parent).find(item => item.kind === 'Environment') : undefined
    const { wire, ...synced } = await this.converter.sync(kind, await files.grammar(kind), request.draft, env ? await files.text(env.artifact) : undefined)
    if (request.action === 'editor-convert') {
      return { ok: true, editor: { ...synced, render: { kind, data: JSON.stringify(wire) }, file, hash: artifact.sha256 } }
    }
    const models = (await files.models(parent)).map(model => model.path === file ? { ...model, text: synced.text } : model)
    const { map, review } = await this.traceRevision(run, files, models)
    return this.commits.run(run.projectId, async () => {
      const verify = async () => {
        const active = await checkBaseline()
        const { index } = await this.readIndex(active)
        const source = index.functions.find(item => item.id === run.feature.id)
        if (!source || source.contentSha256 !== run.sourceSha256) throw new ModelProblemError('changed', 'Function source changed')
        await store.verified(this.registered(active, source.path))
        await Promise.all([...files.files(), ...files.files(parent)].map(item => store.verified(item.artifact)))
        await files.grammar(kind)
      }
      const revision = await files.save(latest, parent, models, { ...parent?.layout, [file]: request.layout }, map, review, verify)
      const descriptor = editorSummary(run, revision)
      return { ok: true, editor: { ...revisionInfo, ...synced, file, languageServiceUrl, hash: sha256(synced.text), layout: request.layout, map, review,
        latest: revision.id, revisions: [...revisionInfo.revisions, descriptor], revision: descriptor } }
    })
  }

  private async traceRevision(run: ModelingRun, files: ModelEditorStore, models: ModelSource[], savedMap?: string) {
    const original = await files.models()
    const originalMap = await files.map()
    if (!files.registered('model/requirements.json')) return { review: [] }
    const parsedRequirements = requirementsSchema.safeParse(editorJson(await files.original('model/requirements.json')))
    if (!parsedRequirements.success) return { review: [] }
    const requirements = parsedRequirements.data
    if (requirements.run_id !== run.id || requirements.feature_id !== run.feature.id || requirements.source.sha256 !== run.sourceSha256) {
      throw new ModelProblemError('identity', 'Requirements do not belong to the source run')
    }
    const reports: Parameters<typeof makeMapping>[2] = {}
    const review = new Set<string>()
    const published = originalMap ? JSON.parse(originalMap) as ReturnType<typeof makeMapping> : undefined
    for (const kind of modelKinds) {
      const path = `model/${reportName(kind)}`
      if (!files.registered(path)) continue
      const check = `checks/${kind}-artifacts-1.json`
      if (files.registered(check)) {
        const { issues } = JSON.parse((await files.original(check)).toString('utf8')) as { issues: { path: string }[] }
        if (issues.some(issue => issue.path === modelingDirectories[kind])) continue
      }
      const rows = editorJson(await files.original(path))
      if (!Array.isArray(rows)) continue
      reports[kind] = rows.flatMap(value => {
        const parsed = modelReceipts.element.safeParse(value)
        if (!parsed.success) return []
        const receipt = parsed.data
        const before = original.find(model => model.kind === kind && model.path === receipt.file)
        const after = models.find(model => model.kind === kind && model.path === receipt.file)
        if (before && after && unchangedModelReceipt(before, after, receipt)) return [receipt]
        review.add(receipt.requirement_id)
        return []
      })
    }
    const flagEvidence = (_kind: ModelKind, _error: unknown, id?: string) => { if (id) review.add(id) }
    const map = makeMapping(requirements, models, reports, flagEvidence)
    if (!published && !map.coverage.some(entry => entry.artifacts.length)) return { review: [...review] }
    const current = new Map(map.coverage.map(entry => [entry.requirement_id, entry]))
    for (const entry of published?.coverage ?? []) {
      const updated = current.get(entry.requirement_id)
      if (entry.artifacts.some(ref => !updated?.artifacts.includes(ref)) || entry.assertions.some(result => !updated?.assertions.includes(result))) {
        review.add(entry.requirement_id)
      }
    }
    const text = JSON.stringify(map, null, 2) + '\n'
    // Older saved revisions contain only assertion locations. Verify that exact
    // representation as well when adopting one of those immutable revisions.
    if (savedMap && savedMap !== text) {
      const legacy = makeMapping(requirements, models, reports, flagEvidence, false)
      if (JSON.stringify(legacy, null, 2) + '\n' === savedMap) return { map: savedMap, review: [...review] }
    }
    return { map: text, review: [...review] }
  }

  private async adoptEditor(request: Extract<EditorRequest, { action: 'editor-adopt' }>, run: ModelingRun, files: ModelEditorStore,
    revision: EditorRevision, checkBaseline: () => Promise<Scope>) {
    const scope = await checkBaseline()
    const store = this.store(scope.binding)
    const { index, seed: seedPath } = await this.readIndex(scope)
    const feature = index.functions.find(item => item.id === run.feature.id)
    if (!feature || feature.contentSha256 !== run.sourceSha256 || run.dialogApplicable === undefined || !run.completed.includes('parse')) {
      throw new ModelProblemError('validation', 'The source run has no validated function context')
    }
    const sourceRef = this.registered(scope, feature.path)
    const seedRef = this.registered(scope, seedPath)
    if (seedRef.sha256 !== run.seedSha256) throw new ModelProblemError('changed', 'The adopted relation seed changed')
    const [source, seedBytes, models, mapped] = await Promise.all([
      store.verified(sourceRef), store.verified(seedRef), files.models(revision), files.map(revision),
    ])
    const needed = modelKinds.filter(kind => kind !== 'DialogMap' || run.dialogApplicable)
    const absent = needed.filter(kind => !models.some(model => model.kind === kind))
    if (absent.length) throw new ModelProblemError('validation', `Required DSL missing: ${absent.join(', ')}`)
    const trace = await this.traceRevision(run, files, models, mapped)
    if (!mapped || mapped !== trace.map) throw new ModelProblemError('validation', 'Requirement mapping has no verified source evidence')
    for (const model of models) await this.converter.validate(model.kind, await files.grammar(model.kind), model.text)
    try { unifiedChecks(models) }
    catch (error) { throw new ModelProblemError('validation', message(error)) }
    const seed = relationSeedSchema.parse(parse(seedBytes))
    const delta = checkedDelta(editorJson(await files.original('model/relation_delta.json')), seed, run.feature.name, source.toString('utf8'), feature.path)
    await this.commits.run(run.projectId, async () => {
      await checkBaseline()
      const current = await store.read()
      if ((current?.revision ?? 0) !== request.publication) throw new ModelProblemError('conflict', 'Project publication changed before adoption')
      if (current) await store.verified(current.relations)
      const prior = current?.baselineId === run.baselineId ? current.models.filter(item => item.featureId !== run.feature.id) : []
      const contributions = await Promise.all(prior.map(async model => ({
        ...model, delta: relationDeltaSchema.parse(parse(await store.verified(model.delta))),
      })))
      const combined = mergeModelRelations(seed, [...contributions, { runId: run.id, featureId: run.feature.id, sourceSha256: run.sourceSha256, delta }])
      // Use a unique attempt directory so a publication conflict can be retried.
      const dir = `${editorRevisionPath(run, revision.id)}/adoptions/${randomUUID()}`
      const write = async (name: string, value: unknown) => {
        const path = `${dir}/${name}`
        const text = JSON.stringify(value, null, 2) + '\n'
        await writeOwned(run.root, path, text)
        return { path, sha256: sha256(text) }
      }
      const relationRef = await write('requirement_relations.json', combined)
      const deltaRef = await write('relation_delta.checked.json', delta)
      const validation = await write('validation.json', { passed: true, scope: 'editor-adoption', revisionId: revision.id,
        sourceRunId: run.id, dialogApplicable: run.dialogApplicable, files: revision.artifacts, review: trace.review })
      const published: ModelPublication = {
        schema: 1, runId: revision.id, projectId: run.projectId, baselineId: run.baselineId, revision: request.publication + 1,
        relations: relationRef, models: [...prior, { runId: run.id, featureId: run.feature.id, sourceSha256: run.sourceSha256,
          relationSha256: featureRelationsHash(combined, run.feature.name), editorRevisionId: revision.id, delta: deltaRef,
          artifacts: [...run.artifacts.filter(item => !item.path.startsWith(`${editorBase(run)}/model/`) ||
            (!item.path.endsWith('.dsl') && !item.path.endsWith('/requirement_dsl_map.json'))),
          ...revision.artifacts, revision.map!, validation] }],
      }
      const committed = await store.publish(request.publication, published, async () => {
        await checkBaseline()
        const sourceArtifacts = run.artifacts.filter(item => item.path.startsWith(`${editorBase(run)}/model/`))
        await Promise.all([sourceRef, seedRef, ...sourceArtifacts, ...revision.artifacts, revision.map!].map(item => store.verified(item)))
        for (const kind of needed) await files.grammar(kind)
      })
      if (!committed) throw new ModelProblemError('conflict', 'Project publication changed before adoption')
    })
  }

  private async start(request: Start): Promise<ModelingResult> {
    const scope = await this.scope(request)
    const { binding, candidate, material } = scope
    const existing = this.records.list().find(run => run.projectId === binding.projectId && run.request.requestKey === request.requestKey)
    if (existing) {
      if (existing.baselineId !== request.baselineId || existing.feature.id !== request.featureId || existing.root !== binding.root
        || existing.bindingRevision !== binding.revision) throw new ModelProblemError('conflict')
      return { ...await this.inspect(scope), acceptedRunId: existing.id }
    }
    if (!candidate || !material) throw new ModelProblemError('unreviewed')
    if (candidate.id !== request.baselineId) throw new ModelProblemError('conflict', 'Adopted baseline changed')
    const runtime = this.runtime
    if (!runtime || this.stopped) throw new ModelProblemError('executor')
    if (this.records.list().some(run => run.projectId === binding.projectId && run.feature.id === request.featureId
      && (this.jobs.has(run.id) || modelRunUnsettled(run.state)))) throw new ModelProblemError('unsettled')
    const { index, folder, seed: seedPath, chunks } = await this.readIndex(scope)
    const feature = index.functions.find(item => item.id === request.featureId)
    if (!feature) throw new ModelProblemError('invalid')
    const store = this.store(binding)
    await Promise.all([
      store.verified({ path: material.original, sha256: material.originalSha256 }),
      store.verified({ path: material.markdown, sha256: material.markdownSha256 }),
    ])
    const sourceBytes = await store.verified(this.registered(scope, feature.path))
    if (sha256(sourceBytes) !== feature.contentSha256) throw new ModelProblemError('changed', 'Feature snapshot hash mismatch')
    const seedRef = this.registered(scope, seedPath)
    const seed = relationSeedSchema.parse(parse(await store.verified(seedRef)))
    const path = posix.relative(posix.dirname(seedPath), feature.path)
    if (!feature.path.startsWith(`${folder}/`) || path.startsWith('../') ||
      seed.requirements.filter(item => item.name === feature.name && item.source_relative_path?.replaceAll('\\', '/') === path).length !== 1) {
      throw new ModelProblemError('validation', 'Function does not resolve uniquely in the adopted relationship seed')
    }
    const id = await this.commits.run(binding.projectId, async () => {
      const previous = await store.read()
      const id = randomUUID()
      const run: ModelingRun = {
        schema: 1, id, projectId: binding.projectId, baselineId: candidate.id, materialLabel: material.label,
        bindingRevision: binding.revision, root: binding.root, expectedRelationRevision: previous?.revision ?? 0,
        seedSha256: seedRef.sha256, sourceSha256: feature.contentSha256, request: { workspaceId: request.workspaceId, sessionId: request.sessionId, requestKey: request.requestKey },
        feature: { id: feature.id, name: feature.name, requirementId: feature.requirementId, section: posix.basename(feature.path).match(/^\d+(?:\.\d+)*/)?.[0] },
        state: 'queued', stage: 'snapshot', sequence: 1, updatedAt: new Date().toISOString(), artifacts: [], completed: [],
      }
      await this.check(run)
      if (this.stopped || this.runtime !== runtime) throw new ModelProblemError('executor')
      await this.records.put(run)
      const abort = new AbortController()
      const done = this.run(run, runtime, scope, seed, path, feature.path, sourceBytes, chunks, seedPath, previous, abort)
        .catch(this.report).finally(() => { this.jobs.delete(id) })
      this.jobs.set(id, { run, abort, done, expectedPublication: previous })
      return id
    })
    // Admission stays successful if another unrelated inspection fails after the run is recorded.
    const snapshot = await this.inspect(scope).catch(error => {
      this.report(error)
      return { ok: true }
    })
    return { ...snapshot, acceptedRunId: id }
  }

  private async run(run: ModelingRun, runtime: ModelingRuntime, scope: Scope, seed: RelationSeed, sourceRelative: string,
    original: string, sourceBytes: Buffer, chunks: string, seedPath: string, previous: ModelPublication | undefined, abort: AbortController): Promise<void> {
    const { signal } = abort
    const base = `workbench-runs/${run.id}`
    const directory = `${base}/model`
    const source = `${base}/input/project/${sourceRelative}`
    const sourceText = sourceBytes.toString('utf8')
    const active = previous?.baselineId === run.baselineId ? previous : undefined
    const store = this.store(scope.binding)
    const write = (path: string, value: unknown) => writeOwned(run.root, `${base}/${path}`, JSON.stringify(value, null, 2) + '\n')
    const read = (file: string) => boundedFile(run.root, `${directory}/${file}`, this.limits.maxMaterialBytes)
    let timer: ReturnType<typeof setTimeout> | undefined
    const startStageTimer = (stage: ModelingRun['stage']) => {
      clearTimeout(timer)
      const limit = this.config.modelingStageTimeoutMs
      timer = setTimeout(() => abort.abort(new ModelProblemError('timeout', `Modeling stage ${stage} exceeded ${limit / 1000} seconds`)), limit)
    }
    const advance = async (stage: ModelingRun['stage'], completed?: ModelingRun['stage']) => {
      signal.throwIfAborted()
      await this.check(run)
      await this.change(run.id, current => {
        signal.throwIfAborted()
        startStageTimer(stage)
        return { state: 'running', stage, completed: completed ? [...current.completed, completed] : current.completed }
      })
      signal.throwIfAborted()
    }
    let agent: ModelingAgent | undefined
    let published = false
    try {
      startStageTimer('snapshot')
      const chunksCopy = `${base}/input/project/chunks.json`
      const relations = `${base}/input/project/requirement_relations.json`
      await write('request.json', run)
      await writeOwned(run.root, source, sourceBytes)
      await writeOwned(run.root, chunksCopy, await store.verified(this.registered(scope, chunks)))
      const relationsBytes = await store.verified(active?.relations ?? this.registered(scope, seedPath))
      await writeOwned(run.root, relations, relationsBytes)
      const assets: Record<string, string> = {}
      for (const ref of imageReferences(sourceText)) {
        const reference = decodeURIComponent(ref.split('#')[0]!).replaceAll('\\', '/')
        if (/^\/|:/.test(reference)) throw new ModelProblemError('escape')
        const absolute = posix.normalize(posix.join(posix.dirname(original), reference))
        const relative = posix.normalize(posix.join(posix.dirname(source), reference))
        if (!relative.startsWith(`${base}/input/project/`)) throw new ModelProblemError('escape')
        if (Object.values(assets).includes(relative)) { assets[ref] = relative; continue }
        await writeOwned(run.root, relative, await store.verified(this.registered(scope, absolute)))
        assets[ref] = relative
      }
      await writeOwned(run.root, `${directory}/.staging`, 'Modeling staging directory\n')
      await advance('parse', 'snapshot')
      agent = await runtime.open({ run, directory, source, chunks: chunksCopy, relations, sourceRelative, assets,
        allowedReads: [source, chunksCopy, relations, ...Object.values(assets)], signal,
        onSession: id => this.change(run.id, { executionSessionId: id }) })
      const execution = agent
      const issues: { stage: ModelingRun['stage']; path: string; detail: string }[] = []
      // Validation is advisory. Execution, cancellation and project integrity failures still stop the run.
      const inspect = async <T>(stage: ModelingRun['stage'], path: string, validate: () => Promise<T>): Promise<T | undefined> => {
        try { return await validate() }
        catch (error) {
          signal.throwIfAborted()
          if (problemOf(error, 'validation') !== 'validation'
            || (error instanceof Error && 'code' in error && ['EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(String(error.code)))) throw error
          await this.check(run)
          issues.push({ stage, path, detail: message(error) })
          return undefined
        }
      }
      const recordChecks = async (stage: ModelingRun['stage']) => {
        const stageIssues = issues.filter(issue => issue.stage === stage)
        await write(`checks/${stage}-artifacts-1.json`, { passed: stageIssues.length === 0, policy: 'continue', issues: stageIssues })
        await this.change(run.id, { validationIssues: issues.length })
      }
      const relationContext = relationSeedSchema.parse(parse(relationsBytes))
      await execution.execute('parse')
      const inputs = await Promise.all(parseOutputs.map(file => inspect('parse', file, () => read(file))))
      const requirements = inputs[0] && await inspect('parse', 'requirements.json', async () => {
        const value = requirementsSchema.parse(parse(inputs[0]!))
        const sourceAbsolute = await confined(run.root, source)
        if (value.run_id !== run.id || value.feature_id !== run.feature.id || value.source.sha256 !== run.sourceSha256
          || value.source.path.replaceAll('\\', '/') !== sourceAbsolute.replaceAll('\\', '/')) {
          throw new Error('Invalid requirements source or identity')
        }
        return value
      })
      const registry = inputs[1] && await inspect('parse', 'entity_registry.json', async () => registrySchema.parse(parse(inputs[1]!)))
      if (inputs[0]) await inspect('parse', 'requirements.json', () => execution.validateRequirements(false))
      if (inputs[1]) await inspect('parse', 'entity_registry.json', () => execution.validateEntityRegistry())
      if (inputs[2] && requirements) await inspect('parse', 'if-then.md', async () => validateIfThen(inputs[2]!.toString('utf8'), requirements))
      const checked = inputs[3] && await inspect('parse', 'relation_delta.json', async () =>
        checkedDelta(parse(inputs[3]!), relationContext, run.feature.name, sourceText, original))
      const previousModel = active?.models.find(model => model.featureId === run.feature.id)
      let delta = checked
      if (!delta) {
        const retained = previousModel ? relationDeltaSchema.parse(parse(await store.verified(previousModel.delta)))
          : relationDeltaSchema.parse({ schema_version: '2.0', source_function: run.feature.name, relations: [] })
        delta = { ...retained, consistency_issues: [...retained.consistency_issues,
          { issue: 'Relation delta did not pass validation; retained the previous contribution or applied no new relations',
            source_run_id: previousModel?.runId ?? null }] }
      }
      await recordChecks('parse')
      const dialogApplicable = (registry?.functions[0]!.entities.pages.length ?? 0) > 0 ||
        !!requirements?.requirements.some(item => item.requirement_type === 'ui' && item.responsibility_scope === 'current_system'
          && item.testability === 'testable' && /页面|控件|弹窗|菜单|跳转|按钮|\b(?:page|popup|menu|widget|button|navigation)\b/i.test(item.source_text))
        || ((!requirements || !registry) && /页面|控件|弹窗|菜单|跳转|按钮|\b(?:page|popup|menu|widget|button|navigation)\b/i.test(sourceText))
      await this.change(run.id, { dialogApplicable })
      const reports: Parameters<typeof makeMapping>[2] = {}
      const models: ModelSource[] = []
      let completed: ModelingRun['stage'] = 'parse'
      for (const kind of modelKinds) {
        if (kind === 'DialogMap' && !dialogApplicable) continue
        await advance(kind, completed)
        await execution.execute(kind)
        const location = modelingDirectories[kind]
        const names = await inspect(kind, location, async () => {
          const names = kind === 'Environment' ? [location]
            : (await readdir(await confined(run.root, `${directory}/${location}`))).filter(name => name.endsWith('.dsl')).sort().map(name => `${location}/${name}`)
          if (!names.length) throw new ModelProblemError('validation', `No ${kind} DSL produced`)
          return names
        })
        const files = (await Promise.all((names ?? []).map(path => inspect(kind, path, async () =>
          ({ kind, path, text: (await read(path)).toString('utf8') }))))).filter((file): file is ModelSource => file !== undefined)
        const receipt = await inspect(kind, reportName(kind), async () => parse(await read(reportName(kind))))
        const syntaxValid = files.length && await inspect(kind, location, async () => {
          await execution.validateSyntax(files)
          return true
        })
        models.push(...files)
        if (receipt !== undefined && syntaxValid) reports[kind] = receipt
        await recordChecks(kind)
        completed = kind
      }
      await advance('validate', completed)
      const unchanged = await Promise.all(parseOutputs.map(async (file, index) => !inputs[index] || sha256(await read(file)) === sha256(inputs[index]!)))
      if (unchanged.includes(false)) throw new ModelProblemError('changed', 'Parsing output changed during DSL generation')
      await inspect('validate', 'model/*.dsl', async () => unifiedChecks(models))
      const mapping = requirements ? makeMapping(requirements, models, reports, (kind, error) => {
        issues.push({ stage: 'validate', path: reportName(kind), detail: message(error) })
      }) : { schema_version: '1.0', run_id: run.id, feature_id: run.feature.id, stage: 'dsl', source_sha256: run.sourceSha256, coverage: [] }
      const gaps = mapping.coverage.filter(item => item.status === 'partial' || item.status === 'missing')
      await write('model/requirement_dsl_map.json', mapping)
      await inspect('validate', 'requirement_dsl_map.json', () => execution.validateRequirements(true))
      await recordChecks('validate')
      await agent.close()
      agent = undefined
      await write('model/relation_delta.checked.json', delta)
      await write('validation.json', { passed: issues.length === 0, policy: 'continue', issues, scope: 'dsl', parser: 'textX', dialogApplicable,
        files: models.map(({ kind, path, text }) => ({ kind, path, sha256: sha256(text) })),
        mappingAvailable: !!requirements, incomplete: gaps })
      await this.change(run.id, { gaps: gaps.length, relationIssues: delta.consistency_issues.length })
      await advance('publish', 'validate')
      await this.commits.run(run.projectId, async () => {
        await this.check(run)
        signal.throwIfAborted()
        const current = await store.read()
        const job = this.jobs.get(run.id)!
        if (!samePublication(current, job.expectedPublication)) {
          throw new ModelProblemError('conflict', 'Project relation revision changed before publication')
        }
        if (current) await store.verified(current.relations)
        const otherModels = (publication: ModelPublication | undefined) =>
          publication?.baselineId === run.baselineId ? publication.models.filter(model => model.featureId !== run.feature.id) : []
        const prior = otherModels(current)
        const merge = async (models: ModelPublication['models']) => {
          const contributions = await Promise.all(models.map(async model => ({
            ...model, delta: relationDeltaSchema.parse(parse(await store.verified(model.delta))),
          })))
          return mergeModelRelations(seed, [...contributions, { featureId: run.feature.id, runId: run.id, sourceSha256: run.sourceSha256, delta }])
        }
        const combined = await merge(prior)
        const modeledRelations = samePublication(previous, current) ? combined : await merge(otherModels(previous))
        await write('requirement_relations.json', combined)
        const artifacts = await collectRunArtifacts(run.root, run.id, this.limits)
        const artifact = (path: string) => artifacts.find(item => item.path === `${base}/${path}`)!
        const revision = current?.revision ?? 0
        const publication: ModelPublication = {
          schema: 1, projectId: run.projectId, baselineId: run.baselineId, revision: revision + 1, runId: run.id,
          relations: artifact('requirement_relations.json'), models: [...prior, { runId: run.id, featureId: run.feature.id, sourceSha256: run.sourceSha256,
            relationSha256: featureRelationsHash(modeledRelations, run.feature.name), delta: artifact('model/relation_delta.checked.json'), artifacts }],
        }
        const success = await store.publish(revision, publication, async () => {
          const checked = await this.check(run)
          await Promise.all([store.verified(this.registered(checked, original)), store.verified(this.registered(checked, seedPath))])
          signal.throwIfAborted()
        })
        if (!success) throw new ModelProblemError('conflict', 'Project relation revision changed before publication')
        published = true
        clearTimeout(timer)
        // Pending sibling runs may merge this publication. Changes outside this queue still conflict.
        for (const sibling of this.jobs.values()) {
          if (sibling.run.projectId === run.projectId && sibling.run.root === run.root && sibling.run.baselineId === run.baselineId
            && samePublication(sibling.expectedPublication, current)) sibling.expectedPublication = publication
        }
        await this.change(run.id, current => ({ state: 'succeeded', stage: 'finished', artifacts, completed: [...current.completed, 'publish'] }))
      })
    } catch (error) {
      clearTimeout(timer)
      if (agent) await agent.close().catch(this.report)
      if (published) { this.report(error); await this.reconcile(this.get(run.id), false); return }
      const failure = signal.aborted ? signal.reason : error
      const cancelled = signal.aborted && !(failure instanceof ModelProblemError && failure.code === 'timeout')
      const problem = problemOf(failure, 'validation')
      await write('failure.json', { passed: false, stage: this.get(run.id).stage, problem, detail: message(failure) }).catch(this.report)
      const artifacts = await collectRunArtifacts(run.root, run.id, this.limits).catch(() => [])
      await this.change(run.id, { state: cancelled ? 'cancelled' : 'failed', problem: cancelled ? undefined : problem,
        detail: cancelled ? undefined : message(failure), artifacts })
    } finally {
      clearTimeout(timer)
    }
  }

  private async reconcile(run: ModelingRun, settle: boolean): Promise<void> {
    const store = this.store(run)
    const publication = await store.read(run.id)
    if (!publication) {
      const artifacts = await collectRunArtifacts(run.root, run.id, this.limits).catch(() => run.artifacts)
      await this.change(run.id, { state: settle ? 'cancelled' : 'interrupted', artifacts })
      return
    }
    const model = publication.models.find(item => item.runId === run.id)
    if (!model || publication.baselineId !== run.baselineId) throw new ModelProblemError('identity', 'Publication does not identify the execution')
    await Promise.all([publication.relations, ...model.artifacts].map(artifact => store.verified(artifact)))
    await this.change(run.id, current => ({ state: 'succeeded', stage: 'finished', artifacts: model.artifacts,
      completed: [...new Set([...current.completed, 'publish' as const])], problem: undefined, detail: undefined }))
  }

  async recover(): Promise<void> {
    for (const run of this.records.list().filter(item => modelRunActive(item.state))) {
      try { await this.reconcile(run, false) }
      catch (error) { await this.change(run.id, { state: 'interrupted', detail: message(error) }) }
    }
  }

  private async stopJobs(): Promise<void> {
    await this.admission
    for (const job of this.jobs.values()) job.abort.abort()
    await Promise.all([...this.jobs.values()].map(job => job.done))
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.stopJobs()
  }
}

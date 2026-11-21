// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ItemizationStore } from '../src/host/itemization-store.ts'
import { sha256, writeOwned } from '../src/host/itemization-files.ts'
import { ModelCommitQueue, ModelingService } from '../src/host/modeling-service.ts'
import { ModelingStore } from '../src/host/modeling-store.ts'
import { ModelEditorConverter } from '../src/host/model-editor-converter.ts'
import { ModelEditorStore } from '../src/host/model-editor-store.ts'
import { ModelExecutionError, type ModelingRuntime, type ModelingStage } from '../src/host/modeling-runtime.ts'
import { resolveProjectConfig } from '../src/host/material-inspection.ts'
import type { ProjectService } from '../src/host/project-service.ts'
import { candidateReferenceSchema, materialVersionSchema } from '../src/shared/itemization.ts'
import { itemizationConfigSchema } from '../src/shared/itemization-api.ts'
import { modelRunActive, modelingResultSchema, type ModelKind, type ModelingAction, type ModelingRun } from '../src/shared/modeling-api.ts'

const identities = { sessionId: 's1', workspaceId: 'w1' }
const sourceText = '# 2 Drive\nDrive shall stop when Brake requests stop.\n'
const dispose: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of dispose.splice(0).reverse()) await cleanup() })

async function fixture({ parallel = false, editor = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-modeling-')))
  dispose.push(() => rm(root, { recursive: true, force: true }))
  const id = randomUUID()
  const featureId = randomUUID()
  const brakeId = randomUUID()
  const store = new ItemizationStore(root, id)
  const write = async (path: string, value: unknown) => {
    const contents = typeof value === 'string' ? value : JSON.stringify(value)
    await writeOwned(root, path, contents)
    return { path, sha256: sha256(contents) }
  }
  const original = await write('.workbench/materials/source.pdf', 'control')
  const markdown = await write('.workbench/materials/source.md', sourceText)
  const material = materialVersionSchema.parse({ id: randomUUID(), label: 'V1', original: original.path, originalSha256: original.sha256,
    markdown: markdown.path, markdownSha256: markdown.sha256 })
  await store.registerMaterial(material, 0)
  const addCandidate = async () => {
    const runId = randomUUID()
    const folder = `workbench-runs/${runId}/candidate`
    const source = await write(`${folder}/2Drive/2Drive.md`, sourceText)
    const brake = parallel ? await write(`${folder}/3Brake/3Brake.md`, '# 3 Brake\nBrake shall hold.\n') : undefined
    const index = await write(`${folder}/index.json`, { relationFingerprint: 'r1', functions: [
      { id: featureId, name: 'Drive', requirementId: 'UserReq.001', contentSha256: source.sha256, path: source.path },
      ...(brake ? [{ id: brakeId, name: 'Brake', requirementId: 'UserReq.002', contentSha256: brake.sha256, path: brake.path }] : []),
    ], relations: [] })
    const chunks = await write(`${folder}/chunks.json`, {})
    const seed = await write(`${folder}/requirement_relations.json`, { schema_version: '2.0',
      requirements: [{ name: 'Drive', source_relative_path: '2Drive/2Drive.md' }, { name: 'Brake', source_relative_path: brake ? '3Brake/3Brake.md' : undefined }],
      relations: [{ source: 'System', target: 'Drive', relation_type: 'inclusion' }] })
    const candidate = candidateReferenceSchema.parse({ id: randomUUID(), materialId: material.id, runId, artifacts: [index, source, chunks, seed, ...(brake ? [brake] : [])] })
    await store.publishCandidate(candidate, (await store.read())!.revision)
    return candidate
  }
  const baseline = await addCandidate()
  const adopt = async (candidate = baseline) => store.adopt(candidate.id, (await store.read())!.revision, [])
  const projects = { execute: async ({ sessionId, workspaceId }: typeof identities) =>
    sessionId !== 's1' || workspaceId !== 'w1' ? { ok: false, problem: 'unbound' } : {
      ok: true, binding: { workspaceId, projectId: id, root, revision: 1, status: 'active', unsettledRuns: [] },
    } } as unknown as ProjectService
  const records = new Map<string, ModelingRun>()
  const createService = () => new ModelingService(projects, { list: () => [...records.values()], put: async run => { records.set(run.id, run) } },
    itemizationConfigSchema.parse({}), resolveProjectConfig({}), new ModelCommitQueue(), () => {})
  const service = createService()
  dispose.push(() => service.close())
  const options = { edge: true, invalid: false, pause: false, dialog: false, invalidParse: false,
    corruptRequirements: false, invalidEvidence: false, invalidDelta: false, invalidFinalContract: false,
    omit: [] as string[], failAt: undefined as ModelingStage | undefined, invalidSyntax: undefined as ModelKind | undefined,
    beforeParse: undefined as ((input: Parameters<ModelingRuntime['open']>[0]) => Promise<void>) | undefined,
    beforeEnvironment: undefined as ((signal: AbortSignal) => Promise<void>) | undefined }
  const calls = { execute: [] as ModelingStage[], requirements: [] as boolean[], registry: 0, syntax: [] as ModelKind[] }
  let entered: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const runtime: ModelingRuntime = { open: async input => {
    const { run } = input
    if (editor) {
      for (const [name, grammar] of [['environment', 'grammar.tx'], ['externalscenario', 'grammar.tx'], ['constraint', 'grammar.tx'], ['dialogmap', 'grammar_dialogmap.tx']]) {
        await write(`workbench-runs/${run.id}/validators/requirement-${name}/${grammar}`, 'controlled textX validator')
      }
    }
    const braking = run.feature.id === brakeId
    const quote = braking ? 'Brake shall hold.' : 'Drive shall stop when Brake requests stop.'
    const section = braking ? '3' : '2'
    await input.onSession(parallel ? `controlled-${run.id}` : 'controlled-session')
    const save = (file: string, value: unknown) => options.omit.includes(file) ? Promise.resolve() : write(`${input.directory}/${file}`, value).catch(async error => {
      if (error.code !== 'EEXIST') throw error
      await writeFile(join(root, input.directory, file), typeof value === 'string' ? value : JSON.stringify(value))
    })
    return {
      execute: async step => {
        calls.execute.push(step)
        if (options.failAt === step) throw new ModelExecutionError('model', `Execution failed at ${step}`)
        if (step === 'parse') {
          entered()
          await options.beforeParse?.(input)
          if (options.pause) {
            input.signal.throwIfAborted()
            await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
          }
          await save('requirements.json', options.corruptRequirements ? '{' : { schema_version: '1.0', run_id: run.id, feature_id: run.feature.id,
            source: { path: join(root, input.source), sha256: run.sourceSha256 }, requirements: [
              { requirement_id: 'REQ-1', source_location: { section, start_line: 2, end_line: 2 },
                source_text: quote, requirement_type: 'behavior', responsibility_scope: 'current_system',
                expected_results: ['Drive stops'], testability: 'testable', reason: '' },
            ] })
          await save('entity_registry.json', { functions: [{ entities: { pages: options.dialog ? [{ name: 'Home' }] : [] } }] })
          await save('if-then.md', options.invalidParse ? 'IF Brake requests stop THEN Drive stops'
            : 'IF Brake requests stop THEN Drive stops // [derivation: null] [requirement_id: REQ-1]')
          await save('relation_delta.json', { schema_version: '2.0', source_function: run.feature.name, relations: options.edge ? [
            { source: run.feature.name, target: braking ? 'Drive' : 'Brake', relation_type: 'dependency', subtype: 'service_dependency', is_inferred: false,
              evidence: [{ section_id: section, text: options.invalidDelta ? 'Unsupported relation' : quote }] },
          ] : [] })
          return
        }
        if (step === 'Environment') await options.beforeEnvironment?.(input.signal)
        const model = {
          Environment: ['Environment.dsl', 'Environment {\nInteraction Stop {\n}\n}'],
          ExternalScenario: ['ExternalScenarios/stop.dsl', `Scenario Stop {\nInteraction ${options.invalid ? 'Unknown' : 'Stop'};\n}`],
          Statechart: ['Statecharts/Drive.dsl', 'Statechart Drive {\nStart Start;\n// requirement_ids: REQ-1\nTransition Stop {\nfrom: Start\nto: Stopped\n};\n}\n'],
          DialogMap: ['DialogMaps/entry.dsl', 'DialogMap Entry {\nEntry Start;\nPage Home {};\n}\n'],
        }[step]
        await save(model[0]!, model[1]!)
        await save(`${step}.evidence.json`, step === 'Statechart' ? [{ requirement_id: 'REQ-1', result: 'Drive stops',
          file: model[0], element: 'Stop', code: options.invalidEvidence ? 'to: Invented' : 'to: Stopped' }] : [])
      },
      validateRequirements: async mapped => {
        calls.requirements.push(mapped)
        if (mapped && options.invalidFinalContract) throw new Error('Invalid final DSL contract')
      },
      validateEntityRegistry: async () => {
        calls.registry++
        if (options.invalidParse) throw new Error('Invalid entity shape')
      },
      validateSyntax: async models => {
        calls.syntax.push(...new Set(models.map(model => model.kind)))
        if (models.some(model => model.kind === options.invalidSyntax)) throw new Error(`Invalid ${options.invalidSyntax} syntax`)
      }, close: async () => {},
    }
  } }
  service.setRuntime(runtime)
  const execute = async (action: ModelingAction) => modelingResultSchema.parse(await service.execute({ ...identities, ...action }))
  const start = (key = randomUUID(), selection = featureId) => execute({ action: 'start', baselineId: baseline.id, featureId: selection, requestKey: key })
  const settle = async (runId: string) => {
    await expect.poll(() => !modelRunActive(records.get(runId)!.state) && !service.unsettled(id), { timeout: 12000 }).toBe(true)
    return records.get(runId)!
  }
  return { root, id, featureId, brakeId, baseline, service, createService, records, options, calls, waiting, execute, start, settle, adopt, addCandidate }
}

it('stores separate editor revisions, preserves originals and adopts with publication CAS', async () => {
  const convert = vi.spyOn(ModelEditorConverter.prototype, 'sync').mockImplementation(async (_kind, _grammar, draft) =>
    ({ text: draft.text, graph: { nodes: [], edges: [] }, wire: { nodes: [], transitions: [] } }))
  const validate = vi.spyOn(ModelEditorConverter.prototype, 'validate').mockResolvedValue('checked')
  try {
    const f = await fixture({ editor: true })
    await f.adopt()
    const run = await f.settle((await f.start()).acceptedRunId!)
    expect(run.state).toBe('succeeded')
    const file = 'Statecharts/Drive.dsl'
    const query = { runId: run.id, revisionId: null, file }
    const original = (await f.execute({ ...query, action: 'editor-open' })).editor!
    expect(original.languageServiceUrl).toBe('ws://127.0.0.1:3000')
    const converted = await f.execute({ ...query, action: 'editor-convert', hash: original.hash!,
      draft: { text: original.text!, changes: [] } })
    expect(converted.editor?.render).toEqual({
      kind: 'Statechart', data: JSON.stringify({ nodes: [], transitions: [] }),
    })
    expect((await f.execute({ ...query, action: 'editor-open', file: '../Drive.dsl' })).problem).toBe('invalid')
    expect((await f.service.execute({ ...query, action: 'editor-open', ...identities, workspaceId: 'denied' })).ok).toBe(false)
    const text = original.text!.replace('to: Stopped', 'to: Start')
    const request = { ...query, action: 'editor-save' as const, hash: original.hash!, expectedLatest: null,
      draft: { text, changes: [] }, layout: {} }
    const saves = await Promise.all([f.execute(request), f.execute(request)])
    expect(saves.map(result => result.ok).sort()).toEqual([false, true])
    expect(saves.find(result => !result.ok)?.problem).toBe('conflict')
    const saved = saves.find(result => result.ok)!.editor!
    const revisionId = saved.revision!.id
    expect(saved.review).toEqual(['REQ-1'])
    expect(JSON.parse(saved.map!).coverage[0]).toMatchObject({ status: 'missing', artifacts: ['Statecharts/Drive.dsl#Drive'], uncovered_assertions: ['Drive stops'] })
    expect(await readFile(join(f.root, saved.revision!.path, 'model', file), 'utf8')).toBe(text)
    expect(await readFile(join(f.root, 'workbench-runs', run.id, 'model', file), 'utf8')).toBe(original.text)
    const restarted = f.createService()
    dispose.push(() => restarted.close())
    const reopened = await restarted.execute({ ...identities, ...query, action: 'editor-open', revisionId })
    expect(reopened.editor?.text).toBe(text)
    expect(reopened.editor?.adopted).toBe(null)
    const adopt = (publication: number) => f.execute({ action: 'editor-adopt', runId: run.id, revisionId, publication })
    expect((await adopt(0)).problem).toBe('conflict')
    expect((await adopt(1)).ok).toBe(true)
    expect((await f.execute({ action: 'inspect' })).runs?.[0]?.currentEditorRevision).toBe(revisionId)
    expect((await adopt(1)).problem).toBe('conflict')
    await f.adopt(await f.addCandidate())
    expect((await f.execute({ ...request, expectedLatest: revisionId })).problem).toBe('conflict')
    expect((await f.execute({ ...query, action: 'editor-open', revisionId })).editor?.text).toBe(text)
  } finally {
    convert.mockRestore()
    validate.mockRestore()
  }
}, 30000)

it('keeps a failed run editable and blocks adoption of an incomplete model', async () => {
  const convert = vi.spyOn(ModelEditorConverter.prototype, 'sync').mockImplementation(async (_kind, _grammar, draft) =>
    ({ text: draft.text, graph: { nodes: [], edges: [] }, wire: { nodes: [], transitions: [] } }))
  try {
    const f = await fixture({ editor: true })
    await f.adopt()
    f.options.failAt = 'Statechart'
    const run = await f.settle((await f.start()).acceptedRunId!)
    expect(run.state).toBe('failed')
    const query = { runId: run.id, revisionId: null, file: 'Environment.dsl' }
    const original = (await f.execute({ ...query, action: 'editor-open' })).editor!
    const request = { ...query, action: 'editor-save' as const, hash: original.hash!, expectedLatest: null,
      draft: { text: original.text! + '\n', changes: [] }, layout: {} }
    const saved = await f.execute(request)
    expect(saved.ok, saved.detail).toBe(true)
    expect(saved.editor?.map).toBeUndefined()
    const adoption = await f.execute({ action: 'editor-adopt', runId: run.id, revisionId: saved.editor!.revision!.id, publication: 0 })
    expect(adoption).toMatchObject({ ok: false, problem: 'validation', detail: 'Required DSL missing: Statechart' })
    expect(await new ModelingStore(f.root, f.id, 1_000_000).read()).toBeUndefined()
    await writeFile(join(f.root, 'workbench-runs', run.id, 'model', 'Environment.dsl'), 'External edit')
    expect((await f.execute({ ...request, expectedLatest: saved.editor!.revision!.id })).problem).toBe('changed')
  } finally { convert.mockRestore() }
}, 30000)

it('can adopt a previously saved revision with assertion-only artifact references', async () => {
  const validate = vi.spyOn(ModelEditorConverter.prototype, 'validate').mockResolvedValue('checked')
  try {
    const f = await fixture({ editor: true })
    await f.adopt()
    const run = await f.settle((await f.start()).acceptedRunId!)
    const store = new ModelEditorStore(run, new ModelingStore(f.root, f.id, 1_000_000), 1_000_000)
    const map = JSON.parse((await store.map())!)
    map.coverage[0].artifacts = ['Statecharts/Drive.dsl#Stop']
    const revision = await store.save(undefined, undefined, await store.models(), {}, JSON.stringify(map, null, 2) + '\n', [], async () => {})
    expect((await f.execute({ action: 'editor-adopt', runId: run.id, revisionId: revision.id, publication: 1 })).ok).toBe(true)
  } finally { validate.mockRestore() }
}, 30000)

it('validates parse outputs once, records failures and continues through publication without another model request', async () => {
  const f = await fixture()
  await f.adopt()
  f.options.invalidParse = true
  const started = await f.start()
  const run = await f.settle(started.acceptedRunId!)
  expect(run.state, run.detail).toBe('succeeded')
  expect(f.calls).toEqual({ execute: ['parse', 'Environment', 'ExternalScenario', 'Statechart'],
    requirements: [false, true], registry: 1, syntax: ['Environment', 'ExternalScenario', 'Statechart'] })
  expect(run.validationIssues).toBe(2)
  const report = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'validation.json'), 'utf8'))
  expect(report).toMatchObject({ passed: false, policy: 'continue', issues: [
    { stage: 'parse', path: 'entity_registry.json', detail: 'Invalid entity shape' },
    { stage: 'parse', path: 'if-then.md', detail: expect.stringContaining('if-then.md needs IF') },
  ] })
  expect((await new ModelingStore(f.root, f.id, 1_000_000).read())?.runId).toBe(run.id)
}, 30000)

it.each(['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'] as const)('continues after one failed %s syntax check', async kind => {
  const f = await fixture()
  await f.adopt()
  f.options.dialog = true
  f.options.invalidSyntax = kind
  const run = await f.settle((await f.start()).acceptedRunId!)
  expect(run).toMatchObject({ state: 'succeeded', stage: 'finished', validationIssues: 1 })
  expect(f.calls.execute).toEqual(['parse', 'Environment', 'ExternalScenario', 'Statechart', 'DialogMap'])
  expect(f.calls.syntax).toEqual(['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'])
  const report = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'validation.json'), 'utf8'))
  expect(report).toMatchObject({ passed: false, issues: [{ stage: kind, detail: `Invalid ${kind} syntax` }] })
  const map = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'model/requirement_dsl_map.json'), 'utf8'))
  expect(map.coverage[0].status).toBe(kind === 'Statechart' ? 'missing' : 'covered')
}, 30000)

it('publishes after cross-file, evidence and final contract failures without retrying any stage', async () => {
  const f = await fixture()
  await f.adopt()
  f.options.invalid = true
  f.options.invalidEvidence = true
  f.options.invalidFinalContract = true
  const run = await f.settle((await f.start()).acceptedRunId!)
  expect(run).toMatchObject({ state: 'succeeded', stage: 'finished', validationIssues: 3, gaps: 1 })
  expect(f.calls.execute).toEqual(['parse', 'Environment', 'ExternalScenario', 'Statechart'])
  expect(f.calls.requirements).toEqual([false, true])
  const report = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'validation.json'), 'utf8'))
  expect(report.issues.map((issue: { detail: string }) => issue.detail)).toEqual([
    expect.stringContaining('does not declare Interaction Unknown'),
    expect.stringContaining('Unverified DSL location or assertion'),
    'Invalid final DSL contract',
  ])
  const map = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'model/requirement_dsl_map.json'), 'utf8'))
  expect(map.coverage[0]).toMatchObject({ status: 'missing', artifacts: ['Statecharts/Drive.dsl#Drive'], assertions: [] })
  const restarted = f.createService()
  dispose.push(() => restarted.close())
  f.records.set(run.id, { ...run, state: 'running', stage: 'publish' })
  await restarted.recover()
  expect((await restarted.execute({ ...identities, action: 'inspect' })).runs?.[0])
    .toMatchObject({ state: 'succeeded', validationIssues: 3 })
}, 30000)

it.each(['malformed', 'missing'])('continues with %s parse outputs and records unavailable mapping without inventing requirements', async mode => {
  const f = await fixture()
  await f.adopt()
  f.options.corruptRequirements = mode === 'malformed'
  if (mode === 'missing') f.options.omit = ['requirements.json', 'entity_registry.json', 'if-then.md', 'relation_delta.json',
    'ExternalScenarios/stop.dsl', 'ExternalScenario.evidence.json']
  const run = await f.settle((await f.start()).acceptedRunId!)
  expect(run.state, run.detail).toBe('succeeded')
  expect(f.calls.execute).toEqual(['parse', 'Environment', 'ExternalScenario', 'Statechart'])
  expect(run.validationIssues).toBeGreaterThan(0)
  const report = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'validation.json'), 'utf8'))
  expect(report).toMatchObject({ passed: false, mappingAvailable: false })
  const map = JSON.parse(await readFile(join(f.root, 'workbench-runs', run.id, 'model/requirement_dsl_map.json'), 'utf8'))
  expect(map).toMatchObject({ run_id: run.id, feature_id: f.featureId, coverage: [] })
  expect((await new ModelingStore(f.root, f.id, 1_000_000).read())?.runId).toBe(run.id)
}, 30000)

it.each([false, true])('retains existing relation contributions when the new delta is invalid (previous publication: %s)', async published => {
  const f = await fixture()
  await f.adopt()
  const previous = published ? await f.settle((await f.start()).acceptedRunId!) : undefined
  f.options.invalidDelta = true
  const run = await f.settle((await f.start()).acceptedRunId!)
  expect(run).toMatchObject({ state: 'succeeded', validationIssues: 1, relationIssues: 1 })
  const publication = (await new ModelingStore(f.root, f.id, 1_000_000).read())!
  expect(publication.runId).toBe(run.id)
  const relations = JSON.parse(await readFile(join(f.root, publication.relations.path), 'utf8'))
  expect(relations.relations.map((edge: { relation_type: string }) => edge.relation_type))
    .toEqual(published ? ['inclusion', 'dependency'] : ['inclusion'])
  expect(relations.consistency_issues[0]).toMatchObject({ source_run_id: previous?.id ?? null })
}, 30000)

it('persists deletion of completed and failed records while preserving published artifacts and request deduplication', async () => {
  const f = await fixture()
  await f.adopt()
  const key = randomUUID()
  const run = await f.settle((await f.start(key)).acceptedRunId!)
  expect(run.state).toBe('succeeded')
  const publication = new ModelingStore(f.root, f.id, 1_000_000)
  const published = await publication.read()
  const artifact = run.artifacts.find(item => item.path.endsWith('/model/requirements.json'))!
  const original = await readFile(join(f.root, artifact.path), 'utf8')
  const deletion = { action: 'delete-run', runId: run.id } as const
  expect(await f.execute(deletion)).toMatchObject({ ok: true, deletedRunId: run.id, runs: [] })
  const deleted = f.records.get(run.id)!
  expect(deleted.deletedAt).toBeTruthy()
  expect(await f.execute(deletion)).toMatchObject({ ok: true, deletedRunId: run.id, runs: [] })
  expect((await f.execute({ action: 'inspect' })).runs).toEqual([])
  expect(f.records.get(run.id)?.sequence).toBe(deleted.sequence)
  expect((await f.start(key)).acceptedRunId).toBe(run.id)
  expect((await f.execute({ action: 'artifact', runId: run.id, path: artifact.path })).content).toBe(original)
  expect(await publication.read()).toEqual(published)

  const restarted = f.createService()
  dispose.push(() => restarted.close())
  await restarted.recover()
  expect(await restarted.execute({ ...identities, action: 'inspect' })).toMatchObject({ ok: true, runs: [] })
  f.options.failAt = 'Statechart'
  const failed = await f.settle((await f.start()).acceptedRunId!)
  expect(failed.state).toBe('failed')
  expect(await f.execute({ action: 'delete-run', runId: failed.id })).toMatchObject({ ok: true, deletedRunId: failed.id, runs: [] })
  expect((await f.execute({ action: 'inspect' })).runs).toEqual([])
  expect(f.records.get(failed.id)?.deletedAt).toBeTruthy()
  expect(await publication.read()).toEqual(published)
}, 30000)

it('acknowledges a committed deletion even when the unrelated baseline index cannot be inspected', async () => {
  const f = await fixture()
  await f.adopt()
  const run = await f.settle((await f.start()).acceptedRunId!)
  const index = f.baseline.artifacts.find(item => item.path.endsWith('/index.json'))!
  const path = join(f.root, index.path)
  await writeFile(path, (await readFile(path, 'utf8')) + '\n')
  expect((await f.execute({ action: 'inspect' })).problem).toBe('changed')
  expect(await f.execute({ action: 'delete-run', runId: run.id })).toEqual({ ok: true, deletedRunId: run.id })
  expect(f.records.get(run.id)?.deletedAt).toBeTruthy()
}, 30000)

it('rejects deleting live, interrupted and cancelled records or records owned by another project', async () => {
  const f = await fixture()
  await f.adopt()
  f.options.pause = true
  const id = (await f.start()).acceptedRunId!
  await f.waiting
  const deletion = { action: 'delete-run', runId: id } as const
  expect((await f.execute(deletion)).problem).toBe('run-not-deletable')
  expect(await f.service.execute({ ...identities, ...deletion, workspaceId: 'denied' }))
    .toMatchObject({ ok: false, problem: 'unbound' })
  await f.execute({ action: 'cancel', runId: id })
  const cancelled = await f.settle(id)
  for (const state of ['queued', 'running', 'cancelling', 'cancelled', 'interrupted'] as const) {
    f.records.set(id, { ...cancelled, state })
    expect((await f.execute(deletion)).problem).toBe('run-not-deletable')
    expect(f.records.get(id)?.deletedAt).toBeUndefined()
  }
  f.records.set(id, { ...cancelled, state: 'failed', projectId: randomUUID() })
  expect((await f.execute(deletion)).problem).toBe('identity')
  expect(f.records.get(id)?.deletedAt).toBeUndefined()
}, 30000)

it('gives Environment a full hour after parsing and records any timeout against that stage', async () => {
  const f = await fixture()
  await f.adopt()
  let releaseParse!: () => void
  let enteredEnvironment!: (signal: AbortSignal) => void
  const parseGate = new Promise<void>(resolve => { releaseParse = resolve })
  const environmentSignal = new Promise<AbortSignal>(resolve => { enteredEnvironment = resolve })
  f.options.beforeParse = () => parseGate
  f.options.beforeEnvironment = async signal => {
    signal.throwIfAborted()
    enteredEnvironment(signal)
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const minute = 60_000
  let runId!: string
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    runId = (await f.start()).acceptedRunId!
    await f.waiting
    vi.advanceTimersByTime(50 * minute)
    releaseParse()
    const signal = await environmentSignal
    vi.advanceTimersByTime(60 * minute - 1)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
  } finally {
    releaseParse()
    vi.useRealTimers()
  }
  const run = await f.settle(runId)
  expect(run).toMatchObject({
    state: 'failed', stage: 'Environment', completed: ['snapshot', 'parse'], problem: 'timeout',
    detail: 'Modeling stage Environment exceeded 3600 seconds',
  })
  expect(JSON.parse(await readFile(join(f.root, 'workbench-runs', runId, 'failure.json'), 'utf8')))
    .toMatchObject({ stage: 'Environment', problem: 'timeout' })
  expect(await new ModelingStore(f.root, f.id, 1_000_000).read()).toBeUndefined()
}, 30000)

it('admits only an adopted baseline, deduplicates submission and preserves the publication on execution failure', async () => {
  const f = await fixture()
  expect((await f.service.execute({ action: 'inspect', workspaceId: 'other', sessionId: 's1' })).problem).toBe('unbound')
  expect((await f.start()).problem).toBe('unreviewed')
  await f.adopt()
  const key = randomUUID()
  const first = (await f.start(key)).acceptedRunId!
  expect((await f.start(key)).acceptedRunId).toBe(first)
  const result = await f.settle(first)
  expect(f.service.executionSessions({ projectId: f.id, root: f.root })).toEqual([{ sessionId: 'controlled-session', runId: first }])
  expect(f.service.executionSessions({ projectId: f.id, root: '/other-project' })).toEqual([])
  expect(result.state, result.detail).toBe('succeeded')
  const manifest = new ModelingStore(f.root, f.id, 1_000_000)
  const published = (await manifest.read())!
  const relations = JSON.parse(await readFile(join(f.root, published.relations.path), 'utf8'))
  expect(relations.relations.map((edge: { relation_type: string }) => edge.relation_type)).toEqual(['inclusion', 'dependency'])
  expect((await f.execute({ action: 'artifact', runId: first, path: '../other.md' })).problem).toBe('invalid')
  f.options.failAt = 'Statechart'
  const failed = await f.settle((await f.start()).acceptedRunId!)
  expect(failed).toMatchObject({ state: 'failed', problem: 'model', detail: 'Execution failed at Statechart' })
  expect((await manifest.read())?.runId).toBe(first)
  f.options.failAt = undefined
  f.options.edge = false
  f.options.dialog = true
  const replacement = await f.settle((await f.start()).acceptedRunId!)
  expect(replacement.state, replacement.detail).toBe('succeeded')
  expect(replacement.artifacts.some(item => item.path.endsWith('/DialogMaps/entry.dsl'))).toBe(true)
  const current = (await manifest.read())!
  expect(JSON.parse(await readFile(join(f.root, current.relations.path), 'utf8')).relations).toHaveLength(1)
  expect((await f.execute({ action: 'inspect' })).runs?.find(item => item.id === first)?.stale).toBe(true)
  await f.adopt(await f.addCandidate())
  expect((await f.execute({ action: 'inspect' })).runs?.find(item => item.id === replacement.id)?.stale).toBe(true)
  f.records.set(first, { ...result, state: 'running', stage: 'publish' })
  await f.service.recover()
  expect(f.records.get(first)?.state).toBe('succeeded')
}, 45000)

it('waits for cancellation and reconciles an orphan without publishing its files', async () => {
  const f = await fixture()
  await f.adopt()
  f.options.pause = true
  const id = (await f.start()).acceptedRunId!
  await f.waiting
  expect((await f.start()).problem).toBe('unsettled')
  await f.execute({ action: 'cancel', runId: id })
  const result = await f.settle(id)
  expect(result.state).toBe('cancelled')
  f.records.set(id, { ...result, state: 'running' })
  await f.service.recover()
  expect(f.records.get(id)?.state).toBe('interrupted')
  await f.execute({ action: 'reconcile', runId: id })
  expect(f.records.get(id)?.state).toBe('cancelled')
  expect(await new ModelingStore(f.root, f.id, 1_000_000).read()).toBeUndefined()
}, 30000)

it('runs two feature sessions concurrently, combines their publications and flags changed relation context', async () => {
  const f = await fixture({ parallel: true })
  await f.adopt()
  const entered = new Set<string>()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.options.beforeParse = async ({ run }) => {
    entered.add(run.feature.id)
    await barrier
  }
  const key = randomUUID()
  let runIds: string[]
  try {
    const [drive, brake] = await Promise.all([f.start(key), f.start(randomUUID(), f.brakeId)])
    expect(drive.ok, drive.detail).toBe(true)
    expect(brake.ok, brake.detail).toBe(true)
    runIds = [drive.acceptedRunId!, brake.acceptedRunId!]
    await expect.poll(() => entered.size).toBe(2)
    expect(new Set(runIds.map(id => f.records.get(id)?.executionSessionId)).size).toBe(2)
    expect((await f.start(key)).acceptedRunId).toBe(drive.acceptedRunId)
    expect((await f.start()).problem).toBe('unsettled')
  } finally { release() }
  const completed = await Promise.all(runIds.map(f.settle))
  for (const result of completed) expect(result.state, result.detail).toBe('succeeded')
  const publication = await new ModelingStore(f.root, f.id, 1_000_000).read()
  expect(publication?.revision).toBe(2)
  expect(publication?.models.map(model => model.runId).sort()).toEqual(runIds.sort())
  const relations = JSON.parse(await readFile(join(f.root, publication!.relations.path), 'utf8'))
  expect(relations.contributions).toHaveLength(2)
  expect(relations.relations).toHaveLength(3)
  expect((await f.execute({ action: 'inspect' })).runs?.every(run => run.stale)).toBe(true)
}, 30000)

it('cancels one concurrent feature while the other finishes and publishes', async () => {
  const f = await fixture({ parallel: true })
  await f.adopt()
  f.options.beforeParse = async ({ run, signal }) => {
    if (run.feature.id === f.featureId) {
      signal.throwIfAborted()
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  }
  const [drive, brake] = await Promise.all([f.start(), f.start(randomUUID(), f.brakeId)])
  await f.waiting
  await f.execute({ action: 'cancel', runId: drive.acceptedRunId! })
  const [cancelled, completed] = await Promise.all([f.settle(drive.acceptedRunId!), f.settle(brake.acceptedRunId!)])
  expect(cancelled.state).toBe('cancelled')
  expect(completed.state, completed.detail).toBe('succeeded')
  const published = await new ModelingStore(f.root, f.id, 1_000_000).read()
  expect(published?.models.map(model => model.featureId)).toEqual([f.brakeId])
}, 30000)

it('rejects a relation revision that changed after admission and leaves its winning publication intact', async () => {
  const f = await fixture()
  await f.adopt()
  const first = await f.settle((await f.start()).acceptedRunId!)
  expect(first.state, first.detail).toBe('succeeded')
  const store = new ModelingStore(f.root, f.id, 1_000_000)
  const previous = (await store.read())!
  const winner = { ...previous, revision: 2, runId: randomUUID() }
  f.options.beforeParse = async () => { expect(await store.publish(1, winner, async () => {})).toBe(true) }
  const next = await f.settle((await f.start()).acceptedRunId!)
  expect(next).toMatchObject({ state: 'failed', problem: 'conflict' })
  expect((await store.read())?.runId).toBe(winner.runId)
}, 30000)

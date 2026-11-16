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
import type { ModelingRuntime } from '../src/host/modeling-runtime.ts'
import { resolveProjectConfig } from '../src/host/material-inspection.ts'
import type { ProjectService } from '../src/host/project-service.ts'
import { candidateReferenceSchema, materialVersionSchema } from '../src/shared/itemization.ts'
import { itemizationConfigSchema } from '../src/shared/itemization-api.ts'
import { modelRunActive, modelingResultSchema, type ModelingAction, type ModelingRun } from '../src/shared/modeling-api.ts'

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
    beforeParse: undefined as ((input: Parameters<ModelingRuntime['open']>[0]) => Promise<void>) | undefined,
    beforeEnvironment: undefined as ((signal: AbortSignal) => Promise<void>) | undefined }
  const retries: string[] = []
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
    const save = (file: string, value: unknown) => write(`${input.directory}/${file}`, value).catch(async error => {
      if (error.code !== 'EEXIST') throw error
      await writeFile(join(root, input.directory, file), typeof value === 'string' ? value : JSON.stringify(value))
    })
    return {
      execute: async (step, feedback) => {
        if (step === 'parse') {
          if (feedback) retries.push(feedback)
          entered()
          await options.beforeParse?.(input)
          if (options.pause) {
            input.signal.throwIfAborted()
            await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
          }
          await save('requirements.json', { schema_version: '1.0', run_id: run.id, feature_id: run.feature.id,
            source: { path: join(root, input.source), sha256: run.sourceSha256 }, requirements: [
              { requirement_id: 'REQ-1', source_location: { section, start_line: 2, end_line: 2 },
                source_text: quote, requirement_type: 'behavior', responsibility_scope: 'current_system',
                expected_results: ['Drive stops'], testability: 'testable', reason: '' },
            ] })
          await save('entity_registry.json', { functions: [{ entities: { pages: options.dialog ? [{ name: 'Home' }] : [] } }] })
          await save('if-then.md', options.invalidParse && !feedback ? 'IF Brake requests stop THEN Drive stops'
            : 'IF Brake requests stop THEN Drive stops // [derivation: null] [requirement_id: REQ-1]')
          await save('relation_delta.json', { schema_version: '2.0', source_function: run.feature.name, relations: options.edge ? [
            { source: run.feature.name, target: braking ? 'Drive' : 'Brake', relation_type: 'dependency', subtype: 'service_dependency', is_inferred: false,
              evidence: [{ section_id: section, text: quote }] },
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
          file: model[0], element: 'Stop', code: 'to: Stopped' }] : [])
      },
      validateRequirements: async () => {},
      validateEntityRegistry: async () => {
        if (options.invalidParse && retries.length === 0) throw new Error('Invalid entity shape')
      },
      validateSyntax: async () => {}, close: async () => {},
    }
  } }
  service.setRuntime(runtime)
  const execute = async (action: ModelingAction) => modelingResultSchema.parse(await service.execute({ ...identities, ...action }))
  const start = (key = randomUUID(), selection = featureId) => execute({ action: 'start', baselineId: baseline.id, featureId: selection, requestKey: key })
  const settle = async (runId: string) => {
    await expect.poll(() => !modelRunActive(records.get(runId)!.state) && !service.unsettled(id), { timeout: 12000 }).toBe(true)
    return records.get(runId)!
  }
  return { root, id, featureId, brakeId, baseline, service, createService, records, options, retries, waiting, execute, start, settle, adopt, addCandidate }
}

it('stores separate editor revisions, preserves originals and adopts with publication CAS', async () => {
  const convert = vi.spyOn(ModelEditorConverter.prototype, 'sync').mockImplementation(async (_kind, _grammar, draft) =>
    ({ text: draft.text, graph: { nodes: [], edges: [] } }))
  const validate = vi.spyOn(ModelEditorConverter.prototype, 'validate').mockResolvedValue('checked')
  try {
    const f = await fixture({ editor: true })
    await f.adopt()
    const run = await f.settle((await f.start()).acceptedRunId!)
    expect(run.state).toBe('succeeded')
    const file = 'Statecharts/Drive.dsl'
    const query = { runId: run.id, revisionId: null, file }
    const original = (await f.execute({ ...query, action: 'editor-open' })).editor!
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
    expect(JSON.parse(saved.map!).coverage[0]).toMatchObject({ status: 'missing', artifacts: [], uncovered_assertions: ['Drive stops'] })
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
    ({ text: draft.text, graph: { nodes: [], edges: [] } }))
  try {
    const f = await fixture({ editor: true })
    await f.adopt()
    f.options.invalid = true
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

it('reports IF/THEN and entity validation errors together and retries the parse once', async () => {
  const f = await fixture()
  await f.adopt()
  f.options.invalidParse = true
  const started = await f.start()
  const run = await f.settle(started.acceptedRunId!)
  expect(run.state, run.detail).toBe('succeeded')
  expect(f.retries).toHaveLength(1)
  expect(f.retries[0]).toContain('entity_registry.json: Invalid entity shape')
  expect(f.retries[0]).toContain('if-then.md needs IF')
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

it('admits only an adopted baseline, deduplicates submission and publishes only validated replacements', async () => {
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
  f.options.invalid = true
  const failed = await f.settle((await f.start()).acceptedRunId!)
  expect(failed.detail).toContain('does not declare')
  expect((await manifest.read())?.runId).toBe(first)
  f.options.invalid = false
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

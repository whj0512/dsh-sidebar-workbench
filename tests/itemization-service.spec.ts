// @vitest-environment node
/** Controlled original-skill output import; this is not a real-model acceptance test. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { ProjectService, type RegistryWorkspace } from '../src/host/project-service.ts'
import { ItemizationService } from '../src/host/itemization-service.ts'
import type { ItemizerRuntime, SegmentRequest } from '../src/host/itemizer-runtime.ts'
import { resolveProjectConfig } from '../src/host/material-inspection.ts'
import { itemizationConfigSchema, type ItemizationRun, type ItemizationCommand } from '../src/shared/itemization-api.ts'
import { sha256 } from '../src/host/itemization-files.ts'
import type { ProjectBinding } from '../src/shared/project.ts'

const source = '# 1 Overview\nSystem includes Drive.\n# 2 Drive\nDrive shall stop.\n'
const chunks = () => ({ document_info: { name: 'Controlled source' }, chunking_summary: {}, chunks: [
  { chunk_id: 'chunk_001', title: 'Overview', chunk_type: 'overview', source_relative_path: '1Overview.md', source_sections: [{ section_id: '1', title: 'Overview', dsl_dimension: [] }], physical_segments: [{ section_id: '1' }] },
  { chunk_id: 'chunk_002', title: 'Drive', chunk_type: 'functional_requirement', source_relative_path: '2Drive/2Drive.md', canonical_function_name: 'Drive', req_id: 'REQ-1', parent_requirement: null,
    requirement_path: [{ section_id: '2', name: 'Drive' }], hierarchy_evidence: [{ section_id: '2', text: 'Drive shall stop.' }],
    source_sections: [{ section_id: '2', title: 'Drive', dsl_dimension: [] }], physical_segments: [{ section_id: '2' }] },
], project_relation_seed: { requirements: [{ name: 'System', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }],
  relation_delta: [{ from: 'System', to: 'Drive', rel_type: 'includes', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }], consistency_issues: [] } })
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(options: { invalid?: boolean; pause?: boolean; clearedConflict?: boolean; originalConflict?: boolean; reviewHold?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'itemizer-host-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'source.docx'), zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>System includes Drive. Drive shall stop.</w:t></w:r></w:p></w:body></w:document>'),
  }))
  await writeFile(join(root, 'source.md'), source)
  const workspace: RegistryWorkspace = { id: 'w1' as RegistryWorkspace['id'], path: root, sessionIds: ['s1' as RegistryWorkspace['sessionIds'][number]] }
  const bindings = new Map<string, ProjectBinding>(), records = new Map<string, ItemizationRun>()
  let service: ItemizationService
  const projects = new ProjectService(() => [workspace], { list: () => [...bindings.values()], put: async item => { bindings.set(item.workspaceId, item) } }, id => service?.unsettled(id) ?? false)
  cleanup.push(() => projects.close())
  await projects.execute({ action: 'initialize', sessionId: 's1', workspaceId: 'w1', materials: { original: 'source.docx', markdown: 'source.md', version: 'V1', sameVersion: true } })
  let finish!: (run: ItemizationRun) => void, entered!: () => void
  const settled = new Promise<ItemizationRun>(resolve => { finish = resolve }), segmentEntered = new Promise<void>(resolve => { entered = resolve })
  const runtime: ItemizerRuntime = {
    probe: async () => {},
    segment: async (request: SegmentRequest) => {
      await request.onSession('controlled-session'); entered()
      if (request.feedback) {
        expect(request.operation).toBe('adjustment')
        expect(request.previousDirectory).toBeTruthy()
      }
      if (options.pause) await new Promise<void>((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) })
      const data = chunks()
      if (options.clearedConflict) {
        await writeFile(join(request.output, '..', 'validation-1.json'), JSON.stringify({ passed: false, issues: [{ code: 'unresolved', message: 'Source definitions contradict each other.' }] }))
        await writeFile(join(request.output, '..', 'submission-1.json'), JSON.stringify({ ...data, project_relation_seed: { ...data.project_relation_seed, consistency_issues: [{ description: 'Conflicting source hierarchy requires a decision.' }] } }))
      }
      if (options.invalid) data.chunks[1]!.source_relative_path = 'missing.md'
      await writeFile(request.output, JSON.stringify({ ...data, project_relation_seed: { ...data.project_relation_seed,
        consistency_issues: options.originalConflict ? [{ issue: 'Source hierarchy remains unresolved.' }] : [] } }), { flag: 'wx' })
      await writeFile(join(request.output, '..', '1Overview.md'), '# 1 Overview\nSystem includes Drive.\n')
      await mkdir(join(request.output, '..', '2Drive'))
      await writeFile(join(request.output, '..', '2Drive/2Drive.md'), '# 2 Drive\nDrive shall stop.\n')
      await writeFile(join(request.output, '..', 'requirement_relations.json'), JSON.stringify({
        requirements: [{ name: 'System' }, { name: 'Drive' }],
        relations: [{ source: 'System', target: 'Drive', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }], consistency_issues: [],
      }))
    },
  }
  service = new ItemizationService(projects, { list: () => [...records.values()], put: async run => { records.set(run.id, run); if (['failed', 'succeeded', 'cancelled'].includes(run.state)) finish(run) } },
    itemizationConfigSchema.parse({ reviewHolds: options.reviewHold ? [{ markdownSha256: sha256(source), reason: 'Human decision: retain the conflict.' }] : [] }), resolveProjectConfig({}), () => {})
  service.setRuntime(runtime); cleanup.push(() => service.close())
  const command = (value: Omit<ItemizationCommand, 'sessionId' | 'workspaceId'>) => service.execute({ ...value, sessionId: 's1', workspaceId: 'w1' })
  return { root, service, projects, runtime, records, settled, segmentEntered, command }
}

it('imports original outputs, leaves a pending candidate, and requires a current comparison to adopt', async () => {
  const f = await fixture(), key = randomUUID()
  const started = await f.command({ action: 'start', requestKey: key })
  expect(started.ok).toBe(true)
  const run = await f.settled
  expect(run.state).toBe('succeeded')
  const inspected = await f.command({ action: 'inspect' })
  expect(inspected.state?.baseline).toBeNull()
  expect(inspected.state?.candidates).toHaveLength(1)
  const duplicate = await f.command({ action: 'start', requestKey: key })
  expect(duplicate.runs).toHaveLength(1)
  const compared = await f.command({ action: 'compare', candidateId: run.candidateId })
  expect(compared.impactFingerprint).toBeTruthy()
  expect((await f.command({ action: 'adopt', candidateId: run.candidateId, expectedRevision: 0, impactFingerprint: compared.impactFingerprint })).ok).toBe(false)
  const adopted = await f.command({ action: 'adopt', candidateId: run.candidateId, expectedRevision: compared.state!.revision, impactFingerprint: compared.impactFingerprint })
  expect(adopted.state?.baseline).toBe(run.candidateId)
  expect(await readFile(join(f.root, 'source.md'), 'utf8')).toBe(source)
  expect(await readFile(join(f.root, `workbench-runs/${run.id}/candidate/2Drive/2Drive.md`), 'utf8')).toContain('Drive shall stop.')
  const adjusted = await f.command({ action: 'start', requestKey: randomUUID(), parentCandidateId: run.candidateId, feedback: 'Review source evidence without changing the function.' })
  expect(adjusted.ok).toBe(true)
  await expect.poll(() => [...f.records.values()].at(-1)?.state, { timeout: 15000 }).toBe('succeeded')
  const adjustment = [...f.records.values()].at(-1)!
  const initialIndex = JSON.parse(await readFile(join(f.root, `workbench-runs/${run.id}/candidate/index.json`), 'utf8'))
  const adjustedIndex = JSON.parse(await readFile(join(f.root, `workbench-runs/${adjustment.id}/candidate/index.json`), 'utf8'))
  expect(adjustedIndex.functions.map((item: { id: string }) => item.id)).toEqual(initialIndex.functions.map((item: { id: string }) => item.id))
}, 30000)

it('refuses missing original function files without a candidate and retains the import report', async () => {
  const f = await fixture({ invalid: true })
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  expect(run.state).toBe('failed')
  expect(run.artifacts).toContain(`workbench-runs/${run.id}/validation.json`)
  expect((await f.command({ action: 'inspect' })).state?.candidates).toEqual([])
}, 30000)

it('removes a settled run from history and keeps its candidate usable', async () => {
  const f = await fixture()
  const requestKey = randomUUID()
  await f.command({ action: 'start', requestKey })
  const run = await f.settled
  await f.service.detachRuntime(f.runtime)

  const deletion = { action: 'delete-run', runId: run.id } as const
  expect(await f.command(deletion)).toMatchObject({ ok: true, runs: [] })
  expect(await f.command(deletion)).toMatchObject({ ok: true, runs: [] })
  expect(await f.command({ action: 'start', requestKey })).toMatchObject({ ok: true, runs: [] })
  expect(await f.command({ action: 'inspect' })).toMatchObject({ runs: [], state: { candidates: [{ id: run.candidateId }] } })

  const compared = await f.command({ action: 'compare', candidateId: run.candidateId })
  const adopted = await f.command({ action: 'adopt', candidateId: run.candidateId,
    expectedRevision: compared.state?.revision, impactFingerprint: compared.impactFingerprint })
  expect(adopted).toMatchObject({ ok: true, runs: [], state: { baseline: run.candidateId } })
}, 30000)

it('cancels an owned semantic step and settles before allowing another operation', async () => {
  const f = await fixture({ pause: true })
  await f.command({ action: 'start', requestKey: randomUUID() }); await f.segmentEntered
  const run = [...f.records.values()][0]!
  expect(await f.command({ action: 'delete-run', runId: run.id })).toMatchObject({ ok: false, problem: 'run-not-settled' })
  await f.command({ action: 'cancel', runId: run.id })
  expect((await f.settled).state).toBe('cancelled')
  expect((await f.command({ action: 'inspect' })).state?.candidates).toEqual([])
}, 30000)

it('reconciles a published candidate after restart without executing it again and retains unresolved ranges', async () => {
  const f = await fixture()
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  await f.service.close()
  f.records.set(run.id, { ...run, state: 'running' })
  const recovered = new ItemizationService(f.projects, { list: () => [...f.records.values()], put: async value => { f.records.set(value.id, value) } }, itemizationConfigSchema.parse({}), resolveProjectConfig({}), () => {})
  cleanup.push(() => recovered.close())
  await recovered.recover()
  expect(f.records.get(run.id)?.state).toBe('interrupted')
  const command = (value: Omit<ItemizationCommand, 'sessionId' | 'workspaceId'>) => recovered.execute({ ...value, sessionId: 's1', workspaceId: 'w1' })
  expect((await command({ action: 'reconcile', runId: run.id })).runs?.[0]?.state).toBe('succeeded')
  expect((await command({ action: 'inspect' })).available).toBe(false)
  f.records.set(run.id, { ...run, candidateId: randomUUID(), state: 'unknown' })
  expect((await command({ action: 'reconcile', runId: run.id })).ok).toBe(false)
  expect(f.records.get(run.id)?.state).toBe('unknown')
  expect(recovered.unsettled(run.projectId)).toBe(true)
}, 30000)

it('drains owned work before detaching its runtime and rejects new execution while detached', async () => {
  const f = await fixture({ pause: true })
  await f.command({ action: 'start', requestKey: randomUUID() }); await f.segmentEntered
  await f.service.detachRuntime(f.runtime)
  expect((await f.settled).state).toBe('cancelled')
  expect((await f.command({ action: 'start', requestKey: randomUUID() })).problem).toBe('executor')
  expect((await f.command({ action: 'inspect' })).state?.candidates).toEqual([])
}, 30000)

it('retains a prior source conflict when a later valid submission clears its issue list', async () => {
  const f = await fixture({ clearedConflict: true })
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  expect(run.state).toBe('succeeded')
  const content = await f.command({ action: 'candidate', candidateId: run.candidateId })
  expect(JSON.parse(content.content!).validation).toMatchObject({ passed: true, reviewBlocked: true,
    sourceConflicts: [{ issues: [{ description: 'Conflicting source hierarchy requires a decision.' }] }] })
  const comparison = await f.command({ action: 'compare', candidateId: run.candidateId })
  expect((await f.command({ action: 'adopt', candidateId: run.candidateId, expectedRevision: comparison.state!.revision, impactFingerprint: comparison.impactFingerprint })).problem).toBe('source-conflict')
  expect((await f.command({ action: 'inspect' })).state?.baseline).toBeNull()
}, 30000)

it('imports original conflict evidence for review and blocks adoption without changing the raw issue', async () => {
  const f = await fixture({ originalConflict: true })
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  expect(run.state).toBe('succeeded')
  const content = await f.command({ action: 'candidate', candidateId: run.candidateId })
  expect(JSON.parse(content.content!).validation).toMatchObject({ workflow: 'original-skills', passed: true, reviewBlocked: true,
    sourceConflicts: [{ issues: [{ issue: 'Source hierarchy remains unresolved.', description: 'Source hierarchy remains unresolved.' }] }] })
  const raw = JSON.parse(await readFile(join(f.root, `workbench-runs/${run.id}/candidate/chunks.json`), 'utf8'))
  expect(raw.project_relation_seed.consistency_issues).toEqual([{ issue: 'Source hierarchy remains unresolved.' }])
  const comparison = await f.command({ action: 'compare', candidateId: run.candidateId })
  expect((await f.command({ action: 'adopt', candidateId: run.candidateId, expectedRevision: comparison.state!.revision, impactFingerprint: comparison.impactFingerprint })).problem).toBe('source-conflict')
}, 30000)

it('keeps the human review hold when a new original output lists no conflicts', async () => {
  const f = await fixture({ reviewHold: true })
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  const content = await f.command({ action: 'candidate', candidateId: run.candidateId })
  expect(JSON.parse(content.content!).validation).toMatchObject({ reviewBlocked: true,
    sourceConflicts: [{ issues: [{ description: 'Human decision: retain the conflict.' }] }] })
  const comparison = await f.command({ action: 'compare', candidateId: run.candidateId })
  expect((await f.command({ action: 'adopt', candidateId: run.candidateId, expectedRevision: comparison.state!.revision, impactFingerprint: comparison.impactFingerprint })).problem).toBe('source-conflict')
}, 30000)

it('allows the approved candidate to be adopted with its conflicts recorded', async () => {
  const f = await fixture({ originalConflict: true, reviewHold: true })
  await f.command({ action: 'start', requestKey: randomUUID() })
  const run = await f.settled
  expect(run.state).toBe('succeeded')
  await f.service.close()

  const approvalReason = 'Use the reviewed V1 as the phase 5 baseline.'
  const approved = new ItemizationService(f.projects, {
    list: () => [...f.records.values()],
    put: async item => { f.records.set(item.id, item) },
  }, itemizationConfigSchema.parse({
    reviewHolds: [{ markdownSha256: sha256(source), reason: 'Earlier decision to retain the conflict.' }],
    candidateApprovals: [{ projectId: run.projectId, candidateId: run.candidateId, reason: approvalReason }],
  }), resolveProjectConfig({}), () => {})
  cleanup.push(() => approved.close())
  const command = (value: Omit<ItemizationCommand, 'sessionId' | 'workspaceId'>) =>
    approved.execute({ ...value, sessionId: 's1', workspaceId: 'w1' })

  const content = await command({ action: 'candidate', candidateId: run.candidateId })
  expect(JSON.parse(content.content!).validation).toMatchObject({
    reviewBlocked: false, approvalReason,
    sourceConflicts: expect.arrayContaining([expect.objectContaining({ report: 'Human review decision' })]),
  })
  const compared = await command({ action: 'compare', candidateId: run.candidateId })
  const adopt = { action: 'adopt' as const, candidateId: run.candidateId,
    expectedRevision: compared.state!.revision, impactFingerprint: compared.impactFingerprint }
  const file = join(f.root, `workbench-runs/${run.id}/candidate/2Drive/2Drive.md`)
  const original = await readFile(file)
  await writeFile(file, 'Changed after comparison.')
  expect((await command(adopt)).problem).toBe('changed')
  await writeFile(file, original)
  expect(await command(adopt)).toMatchObject({
    ok: true, state: { baseline: run.candidateId, adoption: { approvalReason } },
  })
}, 30000)

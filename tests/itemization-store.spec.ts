// @vitest-environment node
/** Independent filesystem writers exercise candidate history, publication races and failed adoption. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ItemizationStore } from '../src/host/itemization-store.ts'
import { materialVersionSchema, candidateReferenceSchema, type MaterialVersion, type CandidateReference } from '../src/shared/itemization.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-versions-'))); roots.push(root)
  await mkdir(join(root, '.workbench'))
  const projectId = randomUUID()
  await writeFile(join(root, '.workbench/project.json'), JSON.stringify({ schema: 1, projectId }))
  const store = new ItemizationStore(root, projectId)
  const material: MaterialVersion = materialVersionSchema.parse({ id: randomUUID(), label: 'V1', original: 'source.pdf', markdown: 'source.md', originalSha256: digest('pdf'), markdownSha256: digest('md') })
  await writeFile(join(root, material.original), 'pdf'); await writeFile(join(root, material.markdown), 'md')
  const runId = randomUUID(), path = `workbench-runs/${runId}/chunks.json`
  await mkdir(join(root, `workbench-runs/${runId}`), { recursive: true })
  await writeFile(join(root, path), '{}')
  const candidate: CandidateReference = candidateReferenceSchema.parse({ id: randomUUID(), runId, materialId: material.id, artifacts: [{ path, sha256: digest('{}') }] })
  return { root, projectId, store, material, candidate }
}

it('keeps the baseline empty until adoption and retains historical generations after reopening', async () => {
  const f = await fixture()
  await f.store.registerMaterial(f.material, 0)
  const pending = await f.store.publishCandidate(f.candidate, 1)
  expect(pending.baseline).toBeNull()
  const adopted = await f.store.adopt(f.candidate.id, 2, ['Drive'])
  expect(adopted.baseline).toBe(f.candidate.id)
  expect((await new ItemizationStore(f.root, f.projectId).read())?.adoption?.impact).toEqual(['Drive'])
  const old = JSON.parse(await readFile(join(f.root, '.workbench/itemization/000000000002.json'), 'utf8'))
  expect(old.baseline).toBeNull()
  expect(JSON.parse(await readFile(join(f.root, '.workbench/project.json'), 'utf8')).schema).toBe(1)
})

it('allows only one independent writer to publish a revision and rejects stale review', async () => {
  const f = await fixture()
  const second = new ItemizationStore(f.root, f.projectId)
  const results = await Promise.allSettled([f.store.registerMaterial(f.material, 0), second.registerMaterial({ ...f.material, id: materialVersionSchema.parse({ ...f.material, id: randomUUID() }).id, label: 'V2' }, 0)])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  await expect(second.registerMaterial({ ...f.material, id: materialVersionSchema.parse({ ...f.material, id: randomUUID() }).id }, 0)).rejects.toMatchObject({ code: 'conflict' })
})

it('refuses changed output and escaped run references without advancing the baseline', async () => {
  const f = await fixture()
  await f.store.registerMaterial(f.material, 0)
  await f.store.publishCandidate(f.candidate, 1)
  await writeFile(join(f.root, f.candidate.artifacts[0]!.path), 'changed')
  await expect(f.store.adopt(f.candidate.id, 2, [])).rejects.toMatchObject({ code: 'changed' })
  expect((await f.store.read())?.revision).toBe(2)
  await expect(f.store.publishCandidate({ ...f.candidate, id: candidateReferenceSchema.parse({ ...f.candidate, id: randomUUID() }).id, artifacts: [{ path: '../outside', sha256: digest('') }] }, 2)).rejects.toMatchObject({ code: 'invalid' })
})

it('does not hide an invalid newest generation by returning the previous baseline', async () => {
  const f = await fixture()
  await f.store.registerMaterial(f.material, 0)
  await writeFile(join(f.root, '.workbench/itemization/000000000002.json'), '{broken')
  await expect(f.store.read()).rejects.toThrow()
})
it('refuses adoption when a material snapshot changed after candidate publication', async () => {
  const f = await fixture()
  await f.store.registerMaterial(f.material, 0)
  await f.store.publishCandidate(f.candidate, 1)
  await writeFile(join(f.root, f.material.markdown), 'modified')
  await expect(f.store.adopt(f.candidate.id, 2, [])).rejects.toMatchObject({ code: 'changed' })
  expect((await f.store.read())?.baseline).toBeNull()
})

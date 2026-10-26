// @vitest-environment node
/** Real filesystem tests use unique temporary roots and no production data. */
import { mkdtemp, writeFile, readFile, mkdir, rm, cp, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectService, confined } from '../src/host/project-service.ts'
import type { ProjectBinding, ProjectCommand } from '../src/shared/project.ts'
import type { RegistryWorkspace as Workspace } from '../src/host/project-service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workbench-'))); roots.push(root)
  const path = join(root, 'project'); await mkdir(path)
  await writeFile(join(path, 'source.pdf'), 'original'); await writeFile(join(path, 'source.md'), '# source')
  let workspaces: Workspace[] = [{ id: 'w1', path, sessionIds: ['s1'], title: 'One' }].map(w => ({ ...w, id: w.id as Workspace['id'], sessionIds: w.sessionIds.map(id => id as Workspace['sessionIds'][number]) }))
  const records = new Map<string, ProjectBinding>()
  let fail = false
  const service = new ProjectService(() => workspaces, { list: () => [...records.values()], put: async b => { if (fail) throw new Error('disk unavailable'); records.set(b.workspaceId, b) } })
  const request: ProjectCommand = { action: 'initialize', workspaceId: 'w1', sessionId: 's1', materials: { original: 'source.pdf', markdown: 'source.md', version: 'V1', sameVersion: true } }
  return { root, path, records, service, request, setWorkspaces: (w: Workspace[]) => { workspaces = w }, fail: (v: boolean) => { fail = v } }
}
it('A01/A22 concurrent initialization shares one identity and preserves source files', async () => {
  const f = await fixture(); const results = await Promise.all(Array.from({ length: 5 }, () => f.service.execute(f.request)))
  expect(results.every(r => r.ok)).toBe(true); expect(new Set(results.map(r => r.project?.projectId)).size).toBe(1)
  expect(f.records.size).toBe(1); expect(await readFile(join(f.path, 'source.pdf'), 'utf8')).toBe('original')
  expect(results[0]?.project?.baseline).toBeNull(); expect(results[0]?.project?.validation).toBe('not-checked')
  await f.service.close()
})
it('A22 recovers a published manifest after binding persistence failed', async () => {
  const f = await fixture(); f.fail(true); expect((await f.service.execute(f.request)).problem).toBe('storage')
  const manifest = JSON.parse(await readFile(join(f.path, '.workbench/project.json'), 'utf8'))
  f.fail(false); const result = await f.service.execute(f.request)
  expect(result.project?.projectId).toBe(manifest.projectId); expect(result.ok).toBe(true); await f.service.close()
})
it('A25/A27 requires explicit reassociation, preserves old revision and rejects unknown old runs', async () => {
  const f = await fixture(); const initialized = await f.service.execute(f.request)
  f.setWorkspaces([{ id: 'w2', path: f.path, sessionIds: ['s2'], title: 'Renamed' }].map(w => ({ ...w, id: w.id as Workspace['id'], sessionIds: w.sessionIds.map(id => id as Workspace['sessionIds'][number]) })))
  const cmd = { ...f.request, workspaceId: 'w2', sessionId: 's2', action: 'inspect' as const }
  expect((await f.service.execute(cmd)).problem).toBe('relink')
  const old = f.records.get('w1')!; f.records.set('w1', { ...old, unsettledRuns: ['unknown-upload'] })
  expect((await f.service.execute({ ...cmd, action: 'relink', expectedProjectId: initialized.project?.projectId })).problem).toBe('unsettled')
  f.records.set('w1', old)
  const r = await f.service.execute({ ...cmd, action: 'relink', expectedProjectId: initialized.project?.projectId })
  expect(r.ok).toBe(true); expect(r.binding?.revision).toBe(2); expect(old.revision).toBe(1); await f.service.close()
})
it('A28 rejects duplicate identities in copied directories', async () => {
  const f = await fixture(); await f.service.execute(f.request)
  const copy = join(f.root, 'copy'); await cp(f.path, copy, { recursive: true })
  f.setWorkspaces([{ id: 'w1', path: f.path, sessionIds: ['s1'] }, { id: 'w2', path: copy, sessionIds: ['s2'] }].map(w => ({ ...w, id: w.id as Workspace['id'], sessionIds: w.sessionIds.map(id => id as Workspace['sessionIds'][number]) })))
  expect((await f.service.execute({ action: 'inspect', workspaceId: 'w2', sessionId: 's2' })).problem).toBe('conflict'); await f.service.close()
})
it('A19/A26 rejects traversal, junctions, missing roots and mismatched Session membership', async () => {
  const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside)
  await symlink(outside, join(f.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(confined(f.path, '../outside', true)).rejects.toThrow('escape')
  await expect(confined(f.path, 'escape/output.json', true)).rejects.toThrow('escape')
  expect((await f.service.execute({ ...f.request, sessionId: 'other' })).problem).toBe('unbound')
  await rm(f.path, { recursive: true }); expect((await f.service.execute(f.request)).problem).toBe('directory'); await f.service.close()
})
it('A01 discovers only known files without creating metadata and keeps unsupported reports unvalidated', async () => {
  const f = await fixture(); await writeFile(join(f.path, 'chunks.json'), '{}'); await writeFile(join(f.path, 'requirement_relations.json'), 'bad json')
  const result = await f.service.execute({ ...f.request, action: 'discover' })
  expect(result.discovered?.map(a => a.status)).toEqual(['recognized', 'unsupported', 'missing'])
  await expect(readFile(join(f.path, '.workbench/project.json'))).rejects.toThrow()
  const adopted = await f.service.execute({ ...f.request, action: 'adopt', materials: undefined })
  expect(adopted.project?.validation).toBe('not-checked'); expect(adopted.project?.artifacts).toEqual(['chunks.json'])
  await f.service.close(); expect((await f.service.execute(f.request)).problem).toBe('unavailable')
})

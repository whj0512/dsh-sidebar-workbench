// @vitest-environment node
/** Real filesystem tests use unique temporary roots and no production data. */
import { mkdtemp, writeFile, readFile, mkdir, rm, cp, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { zipSync, strToU8 } from 'fflate'
import { resolveProjectConfig, inspectMaterial } from '../src/host/material-inspection.ts'
import { afterEach, expect, it } from 'vitest'
import { ProjectService, confined } from '../src/host/project-service.ts'
import { commandSchema, type ProjectBinding, type ProjectCommand } from '../src/shared/project.ts'
import type { RegistryWorkspace as Workspace } from '../src/host/project-service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workbench-'))); roots.push(root)
  const path = join(root, 'project'); await mkdir(path)
  const pdf = await PDFDocument.create(); pdf.addPage(); await writeFile(join(path, 'source.pdf'), await pdf.save()); await writeFile(join(path, 'source.md'), '# source')
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
  expect(f.records.size).toBe(1); expect((await readFile(join(f.path, 'source.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
  expect(results[0]?.project?.baseline).toBeNull(); expect(results[0]?.project?.validation).toBe('not-checked')
  await f.service.close()
})
it('A22 recovers a published manifest after binding persistence failed', async () => {
  const f = await fixture(); f.fail(true); expect((await f.service.execute(f.request)).problem).toBe('storage')
  const manifest = JSON.parse(await readFile(join(f.path, '.workbench/project.json'), 'utf8'))
  f.fail(false); const result = await f.service.execute(f.request)
  expect(result.project?.projectId).toBe(manifest.projectId); expect(result.ok).toBe(true); await f.service.close()
})
it('rejects removed discovery commands and requires materials even when existing artifacts are present', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.path, 'chunks.json'), '{}')
    for (const action of ['discover', 'adopt']) expect(commandSchema.safeParse({ ...f.request, action }).success).toBe(false)
    expect((await f.service.execute({ ...f.request, materials: undefined })).problem).toBe('materials')
    await expect(readFile(join(f.path, '.workbench/project.json'))).rejects.toThrow()
    const result = await f.service.execute(f.request)
    expect(result.ok).toBe(true)
    expect(result.project?.materials).toEqual(f.request.materials)
    expect(result.project?.baseline).toBeNull()
    expect(result.project?.artifacts).toEqual([])
    expect(JSON.parse(await readFile(join(f.path, '.workbench/project.json'), 'utf8')).materials).toEqual(f.request.materials)
    expect(await readFile(join(f.path, 'chunks.json'), 'utf8')).toBe('{}')
  } finally { await f.service.close() }
})
it('A25/A27 requires explicit reassociation, preserves old revision and rejects unknown old runs', async () => {
  const f = await fixture(); const initialized = await f.service.execute(f.request)
  f.setWorkspaces([{ id: 'w2', path: f.path, sessionIds: ['s2'], title: 'Renamed' }].map(w => ({ ...w, id: w.id as Workspace['id'], sessionIds: w.sessionIds.map(id => id as Workspace['sessionIds'][number]) })))
  const cmd = { ...f.request, workspaceId: 'w2', sessionId: 's2', action: 'inspect' as const }
  expect((await f.service.execute(cmd)).problem).toBe('relink')
  const old = f.records.get('w1')!; f.records.set('w1', { ...old, unsettledRuns: ['unknown-upload'] })
  expect((await f.service.execute({ ...cmd, action: 'relink', expectedProjectId: initialized.project?.projectId, expectedRevision: 1 })).problem).toBe('unsettled')
  f.records.set('w1', old)
  const r = await f.service.execute({ ...cmd, action: 'relink', expectedProjectId: initialized.project?.projectId, expectedRevision: 1 })
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
it('lists workspace files before initialization and rejects traversal, junctions and other sessions', async () => {
  const f = await fixture()
  await mkdir(join(f.path, 'docs'))
  await writeFile(join(f.path, 'docs', '需求 文档.md'), '# source')
  const command = { ...f.request, action: 'files' as const, query: 'docs/' }
  expect((await f.service.execute(command)).files).toEqual([{ path: 'docs/需求 文档.md', directory: false }])
  expect((await f.service.execute({ ...command, query: 'docs/不存在' })).files).toEqual([])
  expect((await f.service.execute({ ...command, query: '../' })).problem).toBe('escape')
  expect((await f.service.execute({ ...command, sessionId: 'other' })).problem).toBe('unbound')
  await symlink(f.root, join(f.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await f.service.execute({ ...command, query: 'linked/' })).problem).toBe('escape')
  expect((await f.service.execute({ ...command, query: '' })).files?.some(file => file.path === 'linked')).toBe(false)
  await expect(readFile(join(f.path, '.workbench/project.json'))).rejects.toThrow()
  await f.service.close()
})

it('persists material fingerprints and reports changed or missing files without rewriting the manifest', async () => {
  const f = await fixture()
  try {
    const initialized = await f.service.execute(f.request)
    expect(initialized.resources?.map(r => r.status)).toEqual(['valid', 'valid'])
    expect(initialized.project?.resources?.every(r => r.sha256?.length === 64)).toBe(true)
    const saved = await readFile(join(f.path, '.workbench/project.json'), 'utf8')
    await writeFile(join(f.path, 'source.md'), '# updated content')
    const inspected = await f.service.execute({ ...f.request, action: 'inspect' })
    expect(inspected.resources?.find(r => r.kind === 'markdown')?.status).toBe('changed')
    await rm(join(f.path, 'source.md'))
    expect((await f.service.execute({ ...f.request, action: 'inspect' })).resources?.find(r => r.kind === 'markdown')?.status).toBe('missing')
    expect(await readFile(join(f.path, '.workbench/project.json'), 'utf8')).toBe(saved)
  } finally { await f.service.close() }
})

it('rejects disguised PDFs and empty Markdown before creating a project', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.path, 'source.pdf'), 'not a PDF')
    await writeFile(join(f.path, 'source.md'), '  ')
    const result = await f.service.execute(f.request)
    expect(result.problem).toBe('materials')
    expect(result.resources?.map(r => r.status)).toEqual(['invalid-format', 'invalid-format'])
    await expect(readFile(join(f.path, '.workbench/project.json'))).rejects.toThrow()
  } finally { await f.service.close() }
})

it('checks DOCX package structure and enforces file and expanded XML limits', async () => {
  const f = await fixture()
  const path = join(f.path, 'source.docx')
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  const docx = zipSync({ '[Content_Types].xml': strToU8(contentTypes), 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>') })
  try {
    await writeFile(path, docx)
    expect((await inspectMaterial(path, 'source.docx', 'original', resolveProjectConfig({}))).status).toBe('valid')
    expect((await inspectMaterial(path, 'source.docx', 'original', resolveProjectConfig({ maxMaterialBytes: 10 }))).status).toBe('too-large')
    expect((await inspectMaterial(path, 'source.docx', 'original', resolveProjectConfig({ maxDocumentXmlBytes: 10 }))).status).toBe('invalid-format')
    await writeFile(path, zipSync({ 'word/document.xml': strToU8('<broken') }))
    expect((await inspectMaterial(path, 'source.docx', 'original', resolveProjectConfig({}))).status).toBe('invalid-format')
    expect(() => resolveProjectConfig({ maxMaterialBytes: 0 })).toThrow()
  } finally { await f.service.close() }
})

it('rejects a project nested below an initialized ancestor or above a deep descendant', async () => {
  const f = await fixture()
  try {
    await f.service.execute(f.request)
    const child = join(f.path, 'a', 'b'); await mkdir(child, { recursive: true })
    f.setWorkspaces([{ id: 'w1' as Workspace['id'], path: child, sessionIds: ['s1' as Workspace['sessionIds'][number]] }])
    // Use a new repository to avoid a root mismatch masking the ancestor check.
    const nested = new ProjectService(() => [{ id: 'w1' as Workspace['id'], path: child, sessionIds: ['s1' as Workspace['sessionIds'][number]] }], { list: () => [], put: async () => {} })
    try { expect((await nested.execute(f.request)).problem).toBe('conflict') } finally { await nested.close() }
    const parent = new ProjectService(() => [{ id: 'w1' as Workspace['id'], path: f.root, sessionIds: ['s1' as Workspace['sessionIds'][number]] }], { list: () => [], put: async () => {} })
    try { expect((await parent.execute(f.request)).problem).toBe('conflict') } finally { await parent.close() }
  } finally { await f.service.close() }
})

it('reopens a published project and requires the displayed revision before moving a binding', async () => {
  const f = await fixture()
  try {
    const initial = await f.service.execute(f.request)
    f.setWorkspaces([{ id: 'w2' as Workspace['id'], path: f.path, sessionIds: ['s2' as Workspace['sessionIds'][number]] }])
    const command = { ...f.request, workspaceId: 'w2', sessionId: 's2' }
    const inspection = await f.service.execute({ ...command, action: 'inspect' })
    expect(inspection.relink).toMatchObject({ previousWorkspaceId: 'w1', nextWorkspaceId: 'w2', previousRoot: f.path, nextRoot: f.path, revision: 1, unsettled: false })
    expect((await f.service.execute({ ...command, action: 'relink', expectedProjectId: initial.project?.projectId, expectedRevision: 0 })).problem).toBe('identity')
    expect((await f.service.execute({ ...command, action: 'relink', expectedProjectId: initial.project?.projectId, expectedRevision: 1 })).binding?.revision).toBe(2)
    expect((await f.service.execute({ ...command, action: 'inspect' })).problem).toBeUndefined()
    expect(initial.project?.materials).toEqual(f.request.materials)
  } finally { await f.service.close() }
})

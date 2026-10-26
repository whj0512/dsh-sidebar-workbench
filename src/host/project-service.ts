/** Host-owned project identities. One serialized mutation chain protects both directions of each binding. */
import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { manifestSchema, type ProjectBinding, type ProjectCommand, type ProjectManifest, type ProjectProblem, type ProjectResult } from '../shared/project.ts'

/** Persistence is supplied by the Host domain, never by browser storage. */
export interface BindingRepository {
  list(): readonly ProjectBinding[]
  put(binding: ProjectBinding): Promise<void>
}
export type RegistryWorkspace = Pick<Workspace, 'id' | 'path' | 'sessionIds'>
/** Structured failure whose code is localized by the consuming Client. */
export class ProjectError extends Error {
  constructor(readonly code: ProjectProblem) { super(code) }
}
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const within = (root: string, path: string): boolean => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`) }

/** @param root - Canonical Workspace.path. @param resource - Project-relative path. @param missing - Allow absent final segments for owned outputs. @returns Confined path; symlinks/junctions are rejected. */
export async function confined(root: string, resource: string, missing = false): Promise<string> {
  if (!resource || isAbsolute(resource) || resource.includes(':') || resource.split(/[\\/]/).some(p => p === '..' || p === '.' || !p)) throw new ProjectError('escape')
  const canonical = await realpath(root)
  if (resolve(canonical) !== resolve(root)) throw new ProjectError('directory')
  let path = root
  for (const part of resource.split(/[\\/]/)) {
    path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink() || !within(root, await realpath(path))) throw new ProjectError('escape')
    } catch (error) {
      if (missing && absent(error)) continue
      throw error
    }
  }
  return path
}

/** Host lifecycle owner. Shutting down drains accepted work before storage is closed. */
export class ProjectService {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  /** @param workspaces - Authoritative registry. @param bindings - Plugin domain. */
  constructor(private readonly workspaces: () => readonly RegistryWorkspace[], private readonly bindings: BindingRepository,
    private readonly unsettled: (projectId: string) => boolean = () => false) {}
  /** @param command - Validated wire command. @returns Durable result or structured failure; failed writes never report success. */
  execute(command: ProjectCommand): Promise<ProjectResult> {
    if (this.stopped) return Promise.resolve({ ok: false, problem: 'unavailable' })
    const task = this.tail.then(() => this.perform(command)).catch((error: unknown): ProjectResult => ({ ok: false,
      problem: error instanceof ProjectError ? error.code : absent(error) ? 'directory' : error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code)) ? 'permission' : 'storage' }))
    this.tail = task.then(() => {}); return task
  }
  private async workspace(command: ProjectCommand): Promise<RegistryWorkspace> {
    const ws = this.workspaces().find(w => w.id === command.workspaceId && w.sessionIds.some(id => id === command.sessionId))
    if (!ws) throw new ProjectError('unbound')
    try { if (!(await lstat(ws.path)).isDirectory()) throw new ProjectError('directory'); await access(ws.path, constants.R_OK) }
    catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError(absent(error) ? 'directory' : 'permission') }
    return ws
  }
  private async manifest(root: string): Promise<ProjectManifest | undefined> {
    try { return manifestSchema.parse(JSON.parse(await readFile(await confined(root, '.workbench/project.json'), 'utf8'))) }
    catch (error) { if (absent(error)) return undefined; if (error instanceof ProjectError) throw error; throw new ProjectError('identity') }
  }
  private async publish(root: string, manifest: ProjectManifest): Promise<void> {
    const directory = await confined(root, '.workbench', true)
    await mkdir(directory, { recursive: false }).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
    await confined(root, '.workbench')
    const destination = await confined(root, '.workbench/project.json', true)
    const temp = join(directory, `${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx')
    try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    // An existing identity is never replaced by initialization; orphan temp files are harmless and not adopted.
    if (await this.manifest(root)) throw new ProjectError('identity')
    await rename(temp, destination)
  }
  private async discover(root: string): Promise<NonNullable<ProjectResult['discovered']>> {
    const paths = ['chunks.json', 'requirement_relations.json', 'testcase/requirement_testcase_map.json']
    const results: NonNullable<ProjectResult['discovered']> = []
    for (const path of paths) {
      try {
        const file = await confined(root, path)
        const info = await lstat(file)
        if (!info.isFile() || info.size > 1024 * 1024) { results.push({ path, status: 'unsupported', validation: 'not-checked' }); continue }
        try { JSON.parse(await readFile(file, 'utf8')); results.push({ path, status: 'recognized', validation: 'not-checked' }) }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; results.push({ path, status: 'unsupported', validation: 'not-checked' }) }
      } catch (error) { if (!absent(error)) throw error; results.push({ path, status: 'missing', validation: 'not-checked' }) }
    }
    return results
  }
  private async perform(command: ProjectCommand): Promise<ProjectResult> {
    const ws = await this.workspace(command)
    for (const b of this.bindings.list()) if (b.status === 'active' && !this.workspaces().some(w => w.id === b.workspaceId))
      await this.bindings.put({ ...b, status: 'removed' })
    let project = await this.manifest(ws.path)
    let binding = this.bindings.list().find(b => b.workspaceId === ws.id)
    const projectId = project?.projectId
    const others = projectId ? this.bindings.list().filter(b => b.projectId === projectId && b.workspaceId !== ws.id) : []
    const other = others.at(-1)
    if (binding && (!project || project.projectId !== binding.projectId || binding.root !== ws.path)) throw new ProjectError('identity')
    if (others.some(b => b.status === 'active')) throw new ProjectError('conflict')
    if (other && command.action !== 'relink') return { ok: false, problem: 'relink', project, binding: other }
    if (command.action === 'inspect') return { ok: true, ...(project ? { project } : {}), ...(binding ? { binding } : {}) }
    if (command.action === 'discover') return { ok: true, discovered: await this.discover(ws.path), ...(project ? { project } : {}) }
    if (command.action === 'relink') {
      if (!project || command.expectedProjectId !== project.projectId) throw new ProjectError('identity')
      if (others.some(b => b.unsettledRuns.length) || binding?.unsettledRuns.length || this.unsettled(project.projectId)) throw new ProjectError('unsettled')
    }
    if (!project) {
      if (command.action === 'relink') throw new ProjectError('identity')
      // Only direct children are inspected for nested identities; no traversal into other workspaces.
      for (const child of await readdir(ws.path, { withFileTypes: true })) if (child.isDirectory() && child.name !== '.workbench') {
        try { await lstat(join(ws.path, child.name, '.workbench', 'project.json')); throw new ProjectError('conflict') }
        catch (error) { if (!absent(error)) throw error }
      }
      if (command.action === 'initialize') {
        const materials = command.materials
        if (!materials || !/\.(pdf|docx)$/i.test(materials.original) || !/\.md$/i.test(materials.markdown)) throw new ProjectError('materials')
        for (const file of [materials.original, materials.markdown]) {
          try { const path = await confined(ws.path, file); if (!(await lstat(path)).isFile()) throw new ProjectError('materials'); await access(path, constants.R_OK) }
          catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError('materials') }
        }
      }
      const discovered = command.action === 'adopt' ? await this.discover(ws.path) : []
      if (command.action === 'adopt' && !discovered.some(a => a.status === 'recognized')) throw new ProjectError('materials')
      project = { schema: 1, projectId: randomUUID(), baseline: null, materials: command.materials ?? null,
        artifacts: discovered.filter(a => a.status === 'recognized').map(a => a.path), createdAt: new Date().toISOString(), validation: 'not-checked' }
      await this.publish(ws.path, project)
    }
    await this.workspace(command)
    binding = { workspaceId: ws.id, projectId: project.projectId, revision: binding?.revision ?? Math.max(0, ...others.map(b => b.revision)) + 1, root: ws.path, status: 'active', unsettledRuns: [] }
    await this.bindings.put(binding)
    return { ok: true, project, binding }
  }
  /** @returns Settlement of accepted operations; new requests are refused immediately. */
  async close(): Promise<void> { this.stopped = true; await this.tail }
}

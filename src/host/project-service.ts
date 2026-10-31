/** Host-owned project identities. One serialized mutation chain protects both directions of each binding. */
import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, open, readFile, readdir, realpath, link, unlink } from 'node:fs/promises'
import { inspectMaterial, resolveProjectConfig, type ProjectConfig } from './material-inspection.ts'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { manifestSchema, type ProjectBinding, type ProjectCommand, type ProjectManifest, type ProjectProblem, type ProjectResult, type ProjectResource } from '../shared/project.ts'

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
    private readonly unsettled: (projectId: string) => boolean = () => false,
    private readonly config: ProjectConfig = resolveProjectConfig({})) {}
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
    try {
      try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
      // Exclusive publication also prevents another Host from replacing this identity.
      await link(temp, destination)
    } finally { await unlink(temp) }
  }
  private async resources(root: string, project: ProjectManifest): Promise<ProjectResource[]> {
    const entries: { path: string; kind: ProjectResource['kind'] }[] = project.materials
      ? [{ path: project.materials.original, kind: 'original' }, { path: project.materials.markdown, kind: 'markdown' }] : []
    entries.push(...project.artifacts.map(path => ({ path, kind: 'artifact' as const })))
    const results: ProjectResource[] = []
    for (const entry of entries) {
      try {
        const current = await inspectMaterial(await confined(root, entry.path), entry.path, entry.kind, this.config)
        const saved = project.resources?.find(resource => resource.path === entry.path && resource.kind === entry.kind)
        results.push(saved?.sha256 && current.sha256 && saved.sha256 !== current.sha256 ? { ...current, status: 'changed' } : current)
      } catch (error) {
        results.push({ ...entry, checkedAt: new Date().toISOString(), status: error instanceof ProjectError ? 'unsafe' : absent(error) ? 'missing' : 'unreadable' })
      }
    }
    return results
  }
  private async rejectNested(root: string): Promise<void> {
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
      try { await lstat(join(parent, '.workbench/project.json')); throw new ProjectError('conflict') }
      catch (error) { if (!absent(error)) throw error }
    }
    const queue = [root]
    let count = 0
    for (let index = 0; index < queue.length; index++) {
      const directory = queue[index]!
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (++count > this.config.maxProjectScanEntries) throw new ProjectError('invalid')
        if (!child.isDirectory() || child.isSymbolicLink()) continue
        const path = join(directory, child.name)
        if (child.name === '.workbench') {
          if (directory !== root) {
            try { await lstat(join(path, 'project.json')); throw new ProjectError('conflict') }
            catch (error) { if (!absent(error)) throw error }
          }
          continue
        }
        queue.push(path)
      }
    }
  }
  private async perform(command: ProjectCommand): Promise<ProjectResult> {
    const ws = await this.workspace(command)
    if (command.action === 'files') {
      const query = (command.query ?? '').replaceAll('\\', '/')
      if (query.startsWith('/') || query.includes(':') || query.split('/').some(p => p === '..' || p === '.')) throw new ProjectError('escape')
      const slash = query.lastIndexOf('/')
      const parent = slash < 0 ? '' : query.slice(0, slash)
      const prefix = query.slice(slash + 1).toLocaleLowerCase()
      const directory = parent ? await confined(ws.path, parent) : await realpath(ws.path)
      if (!parent && resolve(directory) !== resolve(ws.path)) throw new ProjectError('directory')
      const entries = await readdir(directory, { withFileTypes: true })
      return { ok: true, files: entries.filter(e => !e.isSymbolicLink() && (e.isFile() || e.isDirectory()) && e.name.toLocaleLowerCase().startsWith(prefix))
        .map(e => ({ path: parent ? `${parent}/${e.name}` : e.name, directory: e.isDirectory() }))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)) }
    }
    for (const b of this.bindings.list()) if (b.status === 'active' && !this.workspaces().some(w => w.id === b.workspaceId))
      await this.bindings.put({ ...b, status: 'removed' })
    let project = await this.manifest(ws.path)
    let binding = this.bindings.list().find(b => b.workspaceId === ws.id)
    const projectId = project?.projectId
    const others = projectId ? this.bindings.list().filter(b => b.projectId === projectId && b.workspaceId !== ws.id) : []
    const other = others.at(-1)
    if (binding && (!project || project.projectId !== binding.projectId)) throw new ProjectError('identity')
    if (others.some(b => b.status === 'active')) throw new ProjectError('conflict')
    const previous = binding ? (binding.root !== ws.path || binding.status !== 'active' ? binding : undefined) : other
    const resources = project ? await this.resources(ws.path, project) : undefined
    const revision = previous?.revision ?? 0
    const relink = previous ? { previousWorkspaceId: previous.workspaceId, previousRoot: previous.root, nextWorkspaceId: ws.id,
      nextRoot: ws.path, revision, unsettled: previous.unsettledRuns.length > 0 || this.unsettled(previous.projectId) } : undefined
    if (relink && command.action !== 'relink') return { ok: false, problem: 'relink', project, binding: previous, resources, relink }
    if (command.action === 'inspect') return { ok: true, ...(project ? { project, resources } : {}), ...(binding ? { binding } : {}) }
    if (project && command.action === 'initialize' && (!project.materials || !command.materials ||
      project.materials.original !== command.materials.original || project.materials.markdown !== command.materials.markdown ||
      project.materials.version !== command.materials.version || project.materials.sameVersion !== command.materials.sameVersion)) throw new ProjectError('materials')
    if (project && command.action === 'initialize' && resources?.some(resource => resource.kind !== 'artifact' && resource.status !== 'valid'))
      return { ok: false, problem: 'materials', project, binding, resources }
    if (command.action === 'relink') {
      if (!project || command.expectedProjectId !== project.projectId || !relink || command.expectedRevision !== revision) throw new ProjectError('identity')
      if (relink.unsettled || others.some(b => b.unsettledRuns.length)) throw new ProjectError('unsettled')
    }
    if (!project) {
      if (command.action === 'relink') throw new ProjectError('identity')
      await this.rejectNested(ws.path)
      if (command.action === 'initialize') {
        const materials = command.materials
        if (!materials || !/\.(pdf|docx)$/i.test(materials.original) || !/\.md$/i.test(materials.markdown)) throw new ProjectError('materials')
        for (const file of [materials.original, materials.markdown]) {
          try { const path = await confined(ws.path, file); if (!(await lstat(path)).isFile()) throw new ProjectError('materials'); await access(path, constants.R_OK) }
          catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError('materials') }
        }
      }
      project = { schema: 1, projectId: randomUUID(), baseline: null, materials: command.materials ?? null,
        artifacts: [], createdAt: new Date().toISOString(), validation: 'not-checked' }
      project.resources = await this.resources(ws.path, project)
      if (project.resources.some(resource => resource.status !== 'valid')) return { ok: false, problem: 'materials', resources: project.resources }
      await this.workspace(command)
      await this.publish(ws.path, project)
    }
    await this.workspace(command)
    binding = { workspaceId: ws.id, projectId: project.projectId, revision: command.action === 'relink' ? revision + 1 : binding?.revision ?? Math.max(0, ...others.map(b => b.revision)) + 1, root: ws.path, status: 'active', unsettledRuns: [] }
    await this.bindings.put(binding)
    return { ok: true, project, binding, resources: await this.resources(ws.path, project) }
  }
  /** @returns Settlement of accepted operations; new requests are refused immediately. */
  async close(): Promise<void> { this.stopped = true; await this.tail }
}

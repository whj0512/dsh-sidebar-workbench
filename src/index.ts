/** Host project data service. Business execution and model-visible inputs are not registered. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { bindingSchema, commandSchema, type ProjectCommand, type ProjectResult } from './shared/project.ts'
import { remoteContribution } from './shared/remote.ts'
import { resolveProjectConfig } from './host/material-inspection.ts'
import { ProjectService } from './host/project-service.ts'
import { RunService, durableRunSchema } from './host/run-service.ts'
import { ProjectError, confined } from './host/project-service.ts'

export const inject = ['workspaceRegistry', 'storageDomain', 'typert', 'remoteAccess']
declare module '@deepseek-ai/cordis' { interface Context { workbenchProjects: WorkbenchProjects } }

/** Thin Remote owner. Non-owner peers are denied until a resource-scoped policy is integrated. */
class WorkbenchProjects extends TypertRemoteService {
  constructor(ctx: Context, private readonly projects: ProjectService) { super(ctx, 'workbenchProjects', { namespace: 'workbench' }) }
  /** @param request - Workspace-scoped command. @returns Durable project response; unavailable executors remain disabled. */
  @Remote('command')
  command(request: ProjectCommand): Promise<ProjectResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return Promise.resolve({ ok: false, problem: 'permission' })
    return this.projects.execute(commandSchema.parse(request))
  }
}

/** @param ctx - Host services; all contributions and storage handles belong to this fiber. @param config - Optional validated material and directory scan limits. */
export async function apply(ctx: Context, config?: unknown): Promise<void> {
  const limits = resolveProjectConfig(config)
  const domain = await ctx.storageDomain.open({ name: 'sidebar_workbench', version: 1, tables: { bindings: { valueSchema: bindingSchema }, runs: { valueSchema: durableRunSchema } } })
  ctx.effect(() => () => domain.close(), 'workbench: storage lifetime')
  const table = domain.table('bindings')
  const runTable = domain.table('runs')
  const runs = new RunService({ list: () => [...runTable.entries()].map(([, value]) => value), put: run => runTable.put(run.id, run) }, async binding => {
    const current = table.get(binding.workspaceId)
    const ws = ctx.workspaceRegistry.list().find(w => w.id === binding.workspaceId)
    if (!ws || !current || current.status !== 'active' || current.revision !== binding.revision || current.projectId !== binding.projectId || ws.path !== binding.root) throw new ProjectError('identity')
    await confined(ws.path, '.workbench/project.json')
  }, () => false)
  ctx.effect(() => () => runs.close(), 'workbench: run lifetime')
  await runs.recover()
  const projects = new ProjectService(() => ctx.workspaceRegistry.list(), {
    list: () => [...table.entries()].map(([, value]) => value), put: binding => table.put(binding.workspaceId, binding),
  }, id => runs.unsettled(id).length > 0, limits)
  ctx.effect(() => () => projects.close(), 'workbench: project lifetime')
  ctx.effect(() => ctx.typert.register({ package: remoteContribution.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors,
  }), 'workbench: strict remote descriptors')
  new WorkbenchProjects(ctx, projects)
}

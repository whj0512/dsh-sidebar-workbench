/** Host project identity, durable itemization jobs and owner-only review commands. */
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
import { z } from 'zod'
import { itemizationCommandSchema, itemizationConfigSchema, itemizationRunSchema, type ItemizationCommand, type ItemizationResult } from './shared/itemization-api.ts'
import { ItemizationService } from './host/itemization-service.ts'
import { ItemizationStore } from './host/itemization-store.ts'
import { DshItemizerRuntime } from './host/itemizer-runtime.ts'
import { OriginalSkillTools } from './host/original-skill-tools.ts'

export const inject = ['workspaceRegistry', 'storageDomain', 'typert', 'remoteAccess']
declare module '@deepseek-ai/cordis' { interface Context { workbenchProjects: WorkbenchProjects } }

/** Thin Remote owner. Non-owner peers are denied until a resource-scoped policy is integrated. */
class WorkbenchProjects extends TypertRemoteService {
  constructor(ctx: Context, private readonly projects: ProjectService, private readonly itemizations: ItemizationService) { super(ctx, 'workbenchProjects', { namespace: 'workbench' }) }
  /** @param request - Workspace-scoped command. @returns Durable project response; unavailable executors remain disabled. */
  @Remote('command')
  async command(request: ProjectCommand): Promise<ProjectResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return Promise.resolve({ ok: false, problem: 'permission' })
    const result = await this.projects.execute(commandSchema.parse(request))
    if (result.ok && result.project && result.binding) {
      const state = await new ItemizationStore(result.binding.root, result.project.projectId).read()
      const candidate = state?.candidates.find(item => item.id === state.baseline)
      if (candidate) return { ...result, project: { ...result.project, baseline: state?.materials.find(item => item.id === candidate.materialId)?.label ?? null,
        artifacts: [...new Set([...result.project.artifacts, ...candidate.artifacts.map(item => item.path)])] } }
    }
    return result
  }
  /** @param request - Owner-only project-scoped execution or review action. @returns Durable jobs and review results. */
  @Remote('itemization')
  itemization(request: ItemizationCommand): Promise<ItemizationResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return Promise.resolve({ ok: false, problem: 'permission' })
    return this.itemizations.execute(itemizationCommandSchema.parse(request))
  }
}

/** @param ctx - Host services; all contributions and storage handles belong to this fiber. @param config - Optional validated material and directory scan limits. */
export async function apply(ctx: Context, config?: unknown): Promise<void> {
  const options = z.object({ maxMaterialBytes: z.number().optional(), maxDocumentXmlBytes: z.number().optional(), maxProjectScanEntries: z.number().optional(), itemization: itemizationConfigSchema.optional() }).strict().parse(config ?? {})
  const { itemization: executionOptions, ...resourceOptions } = options
  const limits = resolveProjectConfig(resourceOptions), execution = executionOptions ?? itemizationConfigSchema.parse({})
  const domain = await ctx.storageDomain.open({ name: 'sidebar_workbench', version: 1, tables: { bindings: { valueSchema: bindingSchema }, runs: { valueSchema: durableRunSchema }, itemizations: { valueSchema: itemizationRunSchema } } })
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
  let itemizations: ItemizationService | undefined
  const projects = new ProjectService(() => ctx.workspaceRegistry.list(), {
    list: () => [...table.entries()].map(([, value]) => value), put: binding => table.put(binding.workspaceId, binding),
  }, id => runs.unsettled(id).length > 0 || !!itemizations?.unsettled(id), limits)
  ctx.effect(() => () => projects.close(), 'workbench: project lifetime')
  const executionTable = domain.table('itemizations')
  itemizations = new ItemizationService(projects, { list: () => [...executionTable.entries()].map(([, value]) => value), put: run => executionTable.put(run.id, run) },
    execution, limits, error => ctx.logger.warn(`Workbench itemization: ${error instanceof Error ? error.message : 'unknown failure'}`))
  const service = itemizations
  await service.recover()
  ctx.effect(() => () => service.close(), 'workbench: itemization lifetime')
  ctx.inject(['agents', 'agentPresets', 'agentDefaultModel', 'tools', 'llm', 'skills', 'subagents', 'workingDirectory'], child => {
    new OriginalSkillTools(child, execution).install()
    const runtime = new DshItemizerRuntime(child, execution)
    service.setRuntime(runtime)
    child.effect(() => () => service.detachRuntime(runtime), 'workbench: execution providers')
  })
  ctx.effect(() => ctx.typert.register({ package: remoteContribution.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors,
  }), 'workbench: strict remote descriptors')
  new WorkbenchProjects(ctx, projects, service)
}

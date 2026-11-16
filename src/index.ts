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
import { modelingCommandSchema, modelingRunSchema, type ModelingCommand, type ModelingResult } from './shared/modeling-api.ts'
import { ModelCommitQueue, ModelingService } from './host/modeling-service.ts'
import { DshModelingRuntime } from './host/modeling-runtime.ts'
import { converterUrlSchema, defaultConverterUrl } from './host/model-editor-converter.ts'

export const inject = ['workspaceRegistry', 'storageDomain', 'typert', 'remoteAccess']
declare module '@deepseek-ai/cordis' { interface Context { workbenchProjects: WorkbenchProjects } }

/** Thin Remote owner. Non-owner peers are denied until a resource-scoped policy is integrated. */
class WorkbenchProjects extends TypertRemoteService {
  constructor(ctx: Context, private readonly projects: ProjectService, private readonly itemizations: ItemizationService,
    private readonly models: ModelingService, private readonly commits: ModelCommitQueue) { super(ctx, 'workbenchProjects', { namespace: 'workbench' }) }
  /** @param request - Workspace-scoped command. @returns Durable project response; unavailable executors remain disabled. */
  @Remote('command')
  async command(request: ProjectCommand): Promise<ProjectResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return Promise.resolve({ ok: false, problem: 'permission' })
    const result = await this.projects.execute(commandSchema.parse(request))
    if (result.ok && result.project && result.binding) {
      const modelingSessions = this.models.executionSessions(result.binding)
      const execution = modelingSessions.length > 0 ? { modelingSessions } : {}
      const state = await new ItemizationStore(result.binding.root, result.project.projectId).read()
      const candidate = state?.candidates.find(item => item.id === state.baseline)
      if (candidate) return { ...result, ...execution, project: { ...result.project, baseline: state?.materials.find(item => item.id === candidate.materialId)?.label ?? null,
        artifacts: [...new Set([...result.project.artifacts, ...candidate.artifacts.map(item => item.path)])] } }
      return { ...result, ...execution }
    }
    return result
  }
  /** @param request - Owner-only project-scoped execution or review action. @returns Durable jobs and review results. */
  @Remote('itemization')
  async itemization(request: ItemizationCommand): Promise<ItemizationResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return { ok: false, problem: 'permission' }
    const command = itemizationCommandSchema.parse(request)
    if (command.action !== 'adopt') return this.itemizations.execute(command)
    const result = await this.projects.execute({ action: 'inspect', sessionId: command.sessionId, workspaceId: command.workspaceId })
    if (!result.ok || !result.project) return { ok: false, problem: result.problem ?? 'identity' }
    return this.commits.run(result.project.projectId, () => this.itemizations.execute(command))
  }
  @Remote('modeling')
  modeling(request: ModelingCommand): Promise<ModelingResult> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return Promise.resolve({ ok: false, problem: 'permission' })
    return this.models.execute(modelingCommandSchema.parse(request))
  }
}

/** @param ctx - Host services; all contributions and storage handles belong to this fiber. @param config - Optional validated material and directory scan limits. */
export async function apply(ctx: Context, config?: unknown): Promise<void> {
  const options = z.object({ maxMaterialBytes: z.number().optional(), maxDocumentXmlBytes: z.number().optional(), maxProjectScanEntries: z.number().optional(),
    itemization: itemizationConfigSchema.optional(), modelEditor: z.object({ converterBaseUrl: converterUrlSchema.default(defaultConverterUrl) }).strict().optional(),
  }).strict().parse(config ?? {})
  const { itemization: executionOptions, modelEditor, ...resourceOptions } = options
  const limits = resolveProjectConfig(resourceOptions), execution = executionOptions ?? itemizationConfigSchema.parse({})
  const domain = await ctx.storageDomain.open({ name: 'sidebar_workbench', version: 1, tables: { bindings: { valueSchema: bindingSchema }, runs: { valueSchema: durableRunSchema },
    itemizations: { valueSchema: itemizationRunSchema }, modeling: { valueSchema: modelingRunSchema } } })
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
  let models: ModelingService | undefined
  const commits = new ModelCommitQueue()
  const projects = new ProjectService(() => ctx.workspaceRegistry.list(), {
    list: () => [...table.entries()].map(([, value]) => value), put: binding => table.put(binding.workspaceId, binding),
  }, id => runs.unsettled(id).length > 0 || !!itemizations?.unsettled(id) || !!models?.unsettled(id), limits)
  ctx.effect(() => () => projects.close(), 'workbench: project lifetime')
  const executionTable = domain.table('itemizations')
  itemizations = new ItemizationService(projects, { list: () => [...executionTable.entries()].map(([, value]) => value), put: run => executionTable.put(run.id, run) },
    execution, limits, error => ctx.logger.warn(`Workbench itemization: ${error instanceof Error ? error.message : 'unknown failure'}`))
  const service = itemizations
  await service.recover()
  ctx.effect(() => () => service.close(), 'workbench: itemization lifetime')
  const modelingTable = domain.table('modeling')
  models = new ModelingService(projects, { list: () => [...modelingTable.entries()].map(([, value]) => value), put: run => modelingTable.put(run.id, run) },
    execution, limits, commits, error => ctx.logger.warn(`Workbench modeling: ${error instanceof Error ? error.message : 'unknown failure'}`), modelEditor?.converterBaseUrl)
  const modelService = models
  await modelService.recover()
  ctx.effect(() => () => modelService.close(), 'workbench: modeling lifetime')
  ctx.inject(['agents', 'agentPresets', 'agentDefaultModel', 'tools', 'llm', 'skills', 'subagents', 'workingDirectory'], child => {
    new OriginalSkillTools(child, execution).install()
    const runtime = new DshItemizerRuntime(child, execution)
    service.setRuntime(runtime)
    child.effect(() => () => service.detachRuntime(runtime), 'workbench: execution providers')
  })
  ctx.inject(['agents', 'agentPresets', 'agentDefaultModel', 'tools', 'llm', 'skills'], child => {
    const runtime = new DshModelingRuntime(child, execution, limits.maxMaterialBytes)
    modelService.setRuntime(runtime)
    child.effect(() => () => modelService.detachRuntime(runtime), 'workbench: modeling providers')
  })
  ctx.effect(() => ctx.typert.register({ package: remoteContribution.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors,
  }), 'workbench: strict remote descriptors')
  new WorkbenchProjects(ctx, projects, service, modelService, commits)
}

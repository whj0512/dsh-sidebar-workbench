/** Original-skill Agent execution with durable manual prompts and managed lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-session-title'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ItemizationConfig } from '../shared/itemization-api.ts'
import { itemizationPrompt } from './itemization-prompts.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workbench-itemization': { kind: 'workbench-itemization'; runId: string }
    'workbench-original-skill': { kind: 'workbench-original-skill'; runId: string; release?: string }
    'workbench-itemization-feedback': { kind: 'workbench-itemization-feedback'; runId: string }
  }
}

/** Structured failures retain partial files and never adopt a baseline. */
export class ItemizerExecutionError extends Error {
  /** @param code - Failure category. @param detail - Diagnostic retained by the owning run. */
  constructor(readonly code: 'executor' | 'skill-unavailable' | 'model' | 'output-limit' | 'credentials' | 'validation' | 'timeout' | 'unknown', detail?: string) { super(detail ?? code) }
}

/** @param ctx - Host skill registry. @param agent - Preset and workspace supplying the catalog. @param name - DSH skill name or legacy role alias. @param signal - Lookup cancellation. @returns Registered, model-invocable skill. */
export async function loadItemizationSkill(ctx: Context, agent: Agent, name: string, signal: AbortSignal): Promise<SkillDefinition> {
  const registeredName = name.toLowerCase().replaceAll('_', '-')
  const skill = await ctx.skills.get(registeredName, { cwd: agent.session.header.cwd, scope: agent, signal })
  if (!skill || !isModelInvocable(skill)) {
    throw new ItemizerExecutionError('skill-unavailable', `Register model-invocable skill "${registeredName}" in the execution preset's DSH skill catalog`)
  }
  return skill
}

export interface SegmentRequest {
  readonly runId: string; readonly root: string; readonly workspaceId: string
  readonly materialLabel: string
  readonly originalDocument: string; readonly markdown: string; readonly output: string
  readonly operation: 'initial' | 'adjustment' | 'new-version'; readonly previousDirectory?: string
  readonly assets?: readonly { readonly reference: string; readonly path: string }[]
  readonly feedback: string; readonly signal: AbortSignal
  readonly onSession: (sessionId: string) => Promise<void>
}
export interface ItemizerRuntime {
  probe(signal: AbortSignal): Promise<void>
  segment(request: SegmentRequest): Promise<void>
}

const operationTitles: Record<SegmentRequest['operation'], string> = {
  initial: '文档条目化',
  adjustment: '条目化调整',
  'new-version': '新版本条目化',
}

/** Runs the installed original skill with the profile's normal Agent capabilities. */
export class DshItemizerRuntime implements ItemizerRuntime {
  constructor(private readonly ctx: Context, private readonly config: ItemizationConfig) {}

  /** @param signal - Admission cancellation. @returns Readiness of Host services before the Agent's scoped skill lookup. */
  async probe(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentPresets.resolve(this.config.executionPreset)
    await this.ctx.llm.resolveCallConfig(this.ctx.agentDefaultModel.currentSelection())
    if (!this.ctx.subagents.getProvider(this.config.subagentProvider)) throw new ItemizerExecutionError('executor', 'Original skill subagent provider is unavailable')
  }

  /** @param request - Immutable source paths, output directory and selected manual scenario. @returns After the Agent and its children finish; output review is owned by the Host. */
  async segment(request: SegmentRequest): Promise<void> {
    const { signal } = request
    signal.throwIfAborted()
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const preset = await this.ctx.agentPresets.resolve(this.config.executionPreset)
    const output = dirname(request.output), runDirectory = dirname(output)
    const prompt = itemizationPrompt({ operation: request.operation, original: request.originalDocument,
      markdown: request.markdown, output, previous: request.previousDirectory })
    const handle = await this.ctx.agents.create({ sessionId: brandString<SessionId>(randomUUID()), meta: { cwd: request.root, agentPreset: preset.id },
      agentOptions: { ...selection, maxTokens: this.config.maxModelOutputTokens }, signal,
      setup: async agentCtx => { await this.ctx.agentPresets.mount(agentCtx, preset.id) } })
    const abort = () => handle.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const workspace = this.ctx.workspaceRegistry.list().find(item => item.id === request.workspaceId && item.path === request.root)
      if (!workspace) throw new ItemizerExecutionError('executor', 'Workspace removed')
      const skill = await loadItemizationSkill(this.ctx, handle.agent, 'requirement-itemizer', signal)
      const title = `${operationTitles[request.operation]} · ${request.materialLabel} · ${workspace.title}`
      this.ctx.get('sessionTitle')?.rename(handle.agent.session, title)
      await workspace.attachSession(handle.agent.id)
      await request.onSession(handle.agent.id)
      const context = `This run's output directory: ${output}
Original input: ${request.originalDocument}
MinerU input: ${request.markdown}
Input image snapshots: ${JSON.stringify(request.assets ?? [])}
Previous results: ${request.previousDirectory ?? '(none)'}
Run deadline budget (milliseconds): ${this.config.operationTimeoutMs}
Shell compatibility target: ${this.config.shellToolName}
Python executable: ${this.config.pythonExecutable}
Use the profile's file, shell, and managed Agent tools. Keep registered skill resources, inputs, and previous results unchanged. Place task-specific helpers and new results in this run's output directory.

${renderSkillContent(skill)}`
      await writeFile(join(runDirectory, 'prompt.txt'), prompt, { flag: 'wx' })
      await writeFile(join(runDirectory, 'execution-context.txt'), context, { flag: 'wx' })
      await writeFile(join(runDirectory, 'execution.json'), `${JSON.stringify({
        schema: 3, workflow: 'original-skills', model: selection, preset: preset.id, budgets: this.config,
        skill: { name: skill.name, provider: skill.provider, source: skill.source, path: skill.path, resourceBase: skill.resourceBase },
        instructionsSha256: createHash('sha256').update(skill.content).digest('hex'),
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
      }, null, 2)}\n`, { flag: 'wx' })
      await this.ctx.workingDirectory.set(handle.agent, output, signal)
      handle.agent.model.select(selection)
      handle.agent.send(createUserMessage({ source: { kind: 'workbench-original-skill', runId: request.runId }, content: [{ type: 'text', text: context }] }), 'next-step', false)
      if (request.feedback.trim()) handle.agent.send(createUserMessage({ source: { kind: 'workbench-itemization-feedback', runId: request.runId }, content: [{ type: 'text', text: request.feedback }] }), 'next-step', false)
      handle.agent.followup(createUserMessage({ source: { kind: 'workbench-itemization', runId: request.runId }, content: [{ type: 'text', text: prompt }] }))
      do { await handle.agent.whenIdle() } while (await this.ctx.subagents.waitForChildren(handle.agent))
      signal.throwIfAborted()
      const end = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
      if (end?.data.reason.kind === 'max-tokens') throw new ItemizerExecutionError('output-limit')
      if (end?.data.reason.kind === 'error') {
        if (['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(end.data.reason.error.code)) throw new ItemizerExecutionError('credentials')
        throw new ItemizerExecutionError('model', end.data.reason.error.message)
      }
      if (end?.data.reason.kind !== 'completed') throw new ItemizerExecutionError('model', 'Original skill Agent did not complete')
    } finally {
      signal.removeEventListener('abort', abort)
      await handle.dispose()
    }
  }
}

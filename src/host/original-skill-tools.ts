/** QwenPaw-compatible names delegate through Harness policy and subagent APIs. */
import { getTraceable, type Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolRunContext, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import { z } from 'zod'
import type { ItemizationConfig } from '../shared/itemization-api.ts'
import { loadItemizationSkill } from './itemizer-runtime.ts'

const textOutput: ToolDefinition['output'] = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const readArgs = z.object({ file_path: z.string().optional(), path: z.string().optional(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }).strict()
const writeArgs = z.object({ file_path: z.string().optional(), path: z.string().optional(), content: z.string() }).strict()
const shellArgs = z.object({ command: z.string().min(1), cwd: z.string().optional(), timeout: z.number().positive().max(2147483).optional() }).strict()
const chatArgs = z.object({ to_agent: z.string().min(1), text: z.string().min(1), timeout: z.number().positive().max(2147483).optional() }).strict()

/** Owns compatibility calls until their native tools and child activations settle. */
export class OriginalSkillTools {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly config: ItemizationConfig) {}

  private managed<T>(work: (signal: AbortSignal) => Promise<T>, exec: ToolRunContext): Promise<T> {
    const signal = AbortSignal.any([exec.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const task = work(signal)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  private async forward(name: string, args: Record<string, string | number>, exec: ToolRunContext, signal: AbortSignal) {
    if (!exec.agent) throw new Error('Original skill tools require an owning Agent')
    const caller = exec.agent.ctx
    const native = this.ctx.agentPresets.serviceFor({ ctx: caller }, 'tools') ?? caller.tools
    const tools = getTraceable(caller, native)
    const pipeline = new ToolExecutionPipeline(caller.extend({ tools }))
    const prepared = await pipeline.prepare({ name, arguments: args, callId: ToolCallId(`${exec.callId}:native`), rootCallId: exec.rootCallId,
      parent: exec.token, agent: exec.agent, toolSet: exec.toolSet, signal })
    const dispatched = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    const result = await pipeline.complete(prepared.exec, dispatched)
    for (const context of result.additionalContexts ?? []) exec.deferContext(context)
    if (result.isError) throw new Error(result.error?.message ?? `Native ${name} failed`)
    if (result.concludesTurn) exec.concludeTurn()
    return { text: result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }
  }

  /** @returns Registers aliases as reversible Host effects; native tools remain available. */
  install(): void {
    const register = (tool: ToolDefinition) => this.ctx.effect(() => this.ctx.tools.register(tool), `original skills: ${tool.name}`)
    register({ name: 'read_file', description: 'Read a file using the Harness read tool and its normal permissions.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, additionalProperties: false },
      output: textOutput, execute: (args, exec) => this.managed(async signal => {
        const input = readArgs.parse(args), file = input.file_path ?? input.path
        if (!file) throw new Error('file_path is required')
        if (input.end_line !== undefined && input.end_line < (input.start_line ?? 1)) throw new Error('end_line precedes start_line')
        return this.forward('read', { file_path: file, ...(input.start_line ? { offset: input.start_line } : {}),
          ...(input.end_line ? { limit: input.end_line - (input.start_line ?? 1) + 1 } : {}) }, exec, signal)
      }, exec) })
    register({ name: 'write_file', description: 'Write UTF-8 text using the Harness write tool and its normal permissions.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['content'], additionalProperties: false },
      output: textOutput, execute: (args, exec) => this.managed(async signal => {
        const input = writeArgs.parse(args), file = input.file_path ?? input.path
        if (!file) throw new Error('file_path is required')
        return this.forward('write', { file_path: file, content: input.content }, exec, signal)
      }, exec) })
    register({ name: 'execute_shell_command', description: 'Run a command through the configured Harness shell tool, retaining sandbox, approval and job handling. timeout is in seconds.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number', minimum: 1 } }, required: ['command'], additionalProperties: false },
      output: textOutput, execute: (args, exec) => this.managed(async signal => {
        const input = shellArgs.parse(args)
        return this.forward(this.config.shellToolName, { command: input.command, description: 'Execute original requirements skill command',
          ...(input.cwd ? { workdir: input.cwd } : {}), ...(input.timeout ? { timeoutMs: Math.ceil(input.timeout * 1000) } : {}) }, exec, signal)
      }, exec) })
    register({ name: 'chat_with_agent', description: 'Delegate to the named original-skill role and wait for its actual result. Uses Harness managed subagents; timeout is in seconds.',
      parameters: { type: 'object', properties: { to_agent: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'number', minimum: 1 } }, required: ['to_agent', 'text'], additionalProperties: false },
      timeoutMs: this.config.operationTimeoutMs, output: textOutput,
      execute: (args, exec) => this.managed(async signal => {
        if (!exec.agent) throw new Error('Agent delegation requires an owning Agent')
        const input = chatArgs.parse(args)
        const taskSignal = input.timeout ? AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(input.timeout * 1000))]) : signal
        const skillName = this.config.agentSkillAliases[input.to_agent] ?? input.to_agent
        const skill = await loadItemizationSkill(this.ctx, exec.agent, skillName, taskSignal)
        const started = await this.ctx.subagents.startActivation({ provider: this.config.subagentProvider, label: input.to_agent,
          request: { parent: exec.agent, maxDepth: this.config.maxSubagentDepth,
            prompt: [{ type: 'text', text: renderSkillContent(skill) }, { type: 'text', text: input.text }] },
          signal: taskSignal, delivery: 'caller' })
        const abort = () => { void started.dispose().catch(error => this.ctx.logger.warn(`Original skill child disposal: ${error instanceof Error ? error.message : 'unknown failure'}`)) }
        taskSignal.addEventListener('abort', abort, { once: true })
        try {
          if (taskSignal.aborted) abort()
          const result = await started.result
          if (result.stopReason !== 'completed') throw new Error(`Original skill Agent ${input.to_agent} stopped: ${result.stopReason}. ${result.diagnostic ?? ''}`)
          return { text: result.output.filter(block => block.type === 'text').map(block => block.text).join('\n') }
        } finally {
          taskSignal.removeEventListener('abort', abort)
          await started.dispose()
        }
      }, exec) })
    this.ctx.effect(() => () => this.close(), 'original skills: active compatibility calls')
  }

  /** @returns Cancels and drains owned compatibility work before tools or providers unload. */
  async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
  }
}

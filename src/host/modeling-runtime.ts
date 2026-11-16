import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ItemizationConfig } from '../shared/itemization-api.ts'
import type { ModelingRun, ModelKind } from '../shared/modeling-api.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { posix, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { loadItemizationSkill } from './itemizer-runtime.ts'
import { boundedFile, sha256, writeOwned } from './itemization-files.ts'
import { confined } from './project-service.ts'
import { entityRegistryValidationView, modelingDirectories, pythonCheck, strictTextx, type ModelSource } from './modeling-validation.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workbench-modeling': { kind: 'workbench-modeling'; runId: string; stage: ModelingStage }
  }
}
export type ModelingStage = 'parse' | ModelKind
export type ModelInput = { run: ModelingRun; directory: string; source: string; chunks: string; relations: string; sourceRelative: string;
  assets: Record<string, string>; allowedReads: string[]; signal: AbortSignal; onSession: (id: string) => Promise<void> }
export interface ModelingAgent {
  execute(stage: ModelingStage, feedback?: string): Promise<void>
  validateRequirements(ids: boolean): Promise<void>
  validateEntityRegistry(): Promise<void>
  validateSyntax(models: ModelSource[]): Promise<void>
  close(): Promise<void>
}
export interface ModelingRuntime { open(input: ModelInput): Promise<ModelingAgent> }
export const parseOutputs = ['requirements.json', 'entity_registry.json', 'if-then.md', 'relation_delta.json'] as const
export const reportName = (kind: ModelKind) => `${kind}.evidence.json`
const names: Record<ModelingStage, string> = {
  parse: 'requirement-context-parse', Environment: 'requirement-environment', ExternalScenario: 'requirement-externalscenario',
  Statechart: 'requirement-constraint', DialogMap: 'requirement-dialogmap',
}
const goals: Record<ModelingStage, string> = {
  parse: '提取原子需求、实体和 IF/THEN 条件逻辑，并从本功能原文提取项目关系增量',
  Environment: '根据实体表生成环境 DSL，声明后续维度使用的交互',
  ExternalScenario: '根据功能原文和条件逻辑生成外部场景 DSL，引用 Environment 中的交互',
  Statechart: '根据功能原文和条件逻辑生成状态图 DSL',
  DialogMap: '根据实体表和原文生成对话图 DSL，描述有依据的页面、控件和跳转',
}
const textOutput: ToolDefinition['output'] = { schema: { type: 'object', properties: { text: { type: 'string' } },
  required: ['text'], additionalProperties: false }, render: (_args, result) => [{ type: 'text', text: (result as { text: string }).text }] }
const readSchema = z.object({ path: z.string(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }).strict()
const writeSchema = z.object({ path: z.string(), content: z.string() }).strict()

export class ModelExecutionError extends Error {
  constructor(readonly code: 'executor' | 'skill-unavailable' | 'model' | 'credentials' | 'validation', detail: string) { super(detail) }
}

function allowedOutput(stage: ModelingStage, file: string): boolean {
  if (stage === 'parse') return parseOutputs.some(item => item === file)
  if (file === reportName(stage)) return true
  const directory = modelingDirectories[stage]
  if (stage === 'Environment') return file === directory
  return file.startsWith(`${directory}/`) && /^[^/:\\]+\.dsl$/.test(file.slice(directory.length + 1))
}

export class DshModelingRuntime implements ModelingRuntime {
  constructor(private readonly ctx: Context, private readonly config: ItemizationConfig, private readonly limit: number) {}

  async open(input: ModelInput): Promise<ModelingAgent> {
    const { ctx, config } = this
    const { run, signal, directory } = input
    const workspace = ctx.workspaceRegistry.list().find(item => item.id === run.request.workspaceId && item.path === run.root)
    if (!workspace) throw new ModelExecutionError('executor', 'Workspace removed')
    const preset = await ctx.agentPresets.resolve(config.executionPreset)
    const selection = ctx.agentDefaultModel.currentSelection()
    try { await ctx.llm.resolveCallConfig(selection) }
    catch (error) {
      throw new ModelExecutionError('model', error instanceof Error ? error.message : 'Configured model is unavailable')
    }
    const featureDir = await confined(run.root, directory)
    const allowedReads = new Set(input.allowedReads)
    const allowedImages = new Set(Object.values(input.assets))
    const stageReferences = new Map<ModelingStage, { skill: string; reference: string }>()
    let stage: ModelingStage | undefined
    const keep = new Set<string>()
    const tries = new Map<ModelingStage, number>()
    const checks = new Map<string, number>()
    const normalize = (path: string) => {
      const portable = path.replaceAll('\\', '/')
      const result = isAbsolute(path) ? relative(run.root, path).replaceAll('\\', '/') : `${directory}/${portable}`
      if (result.split('/').some(part => !part || part === '.' || part === '..') || result.includes(':')) throw new Error('Invalid run-relative path')
      return result
    }
    const permitted = (path: string) => path.startsWith(`${directory}/`) && stage !== undefined && allowedOutput(stage, path.slice(directory.length + 1))
    let hasImageTool = false
    const handle = await ctx.agents.create({ sessionId: brandString<SessionId>(randomUUID()), meta: { cwd: run.root, agentPreset: preset.id },
      agentOptions: { ...selection, maxTokens: config.maxModelOutputTokens }, signal, setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
        hasImageTool = allowedImages.size > 0 && !!agentCtx.tools.get('read_image')
        agentCtx.tools.restrict({ allow: hasImageTool ? ['read_image'] : [] })
        agentCtx.tools.guard(execution => {
          if (execution.name === 'workbench_model_read' || execution.name === 'workbench_model_write') return
          if (hasImageTool && execution.name === 'read_image') {
            const args = z.object({ file_path: z.string() }).safeParse(execution.arguments)
            if (args.success && isAbsolute(args.data.file_path)) {
              try { if (allowedImages.has(normalize(args.data.file_path))) return }
              catch { /* Deny invalid or foreign paths. */ }
            }
          }
          return 'Tool or asset is outside this modeling run'
        })
        agentCtx.tools.register({ name: 'workbench_model_read', description: 'Read a text input, an approved output, or the current stage reference. Optional inclusive 1-based line ranges.',
          parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
            required: ['path'], additionalProperties: false }, output: textOutput, execute: async (args, exec) => {
            const data = readSchema.parse(args)
            const path = normalize(data.path)
            const files = stage === undefined ? undefined : stageReferences.get(stage)
            const reference = files !== undefined && (path === files.skill || path === files.reference)
            if (!reference && !allowedReads.has(path) && !keep.has(path)) {
              if (permitted(path)) throw new Error('This stage has not created that output yet. Create it with workbench_model_write.')
              throw new Error('File is not registered in this modeling run')
            }
            if (!/\.(?:md|json|dsl|tx)$/i.test(path)) throw new Error('This tool reads text only')
            exec.signal.throwIfAborted()
            const original = (await boundedFile(run.root, path, this.limit)).toString('utf8')
            const lines = original.split(/\r?\n/)
            const start = data.start_line ?? 1
            const end = data.end_line ?? lines.length
            if (end < start || start > lines.length) throw new Error('Invalid line span')
            if (reference) {
              let last = start
              let text = lines[start - 1]!
              while (last < Math.min(end, lines.length) && text.length + lines[last]!.length < 6000) {
                text += '\n' + lines[last++]!
              }
              const next = last < Math.min(end, lines.length) ? `\nContinue with start_line=${last + 1}.` : ''
              return { text: `Lines ${start}-${last} of ${lines.length}:\n${text}${next}` }
            }
            const text = lines.slice(start - 1, end).join('\n')
            if (text.length > Math.max(config.maxSourceReadChars, 24_000)) {
              throw new Error(`Text exceeds the read limit. Read smaller line ranges (file has ${lines.length} lines).`)
            }
            return { text: `Lines ${start}-${Math.min(end, lines.length)} of ${lines.length}:\n${text}` }
          } })
        agentCtx.tools.register({ name: 'workbench_model_write', description: 'Save a UTF-8 result for the active stage. Use the exact relative output path.',
          parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
            additionalProperties: false }, output: textOutput, execute: async (args, exec) => {
            const data = writeSchema.parse(args)
            const path = normalize(data.path)
            if (!permitted(path) || allowedReads.has(path)) throw new Error('Path cannot be written by this stage')
            if (!data.content.trim() || Buffer.byteLength(data.content) > this.limit) throw new Error('Invalid result size')
            exec.signal.throwIfAborted()
            await mkdir(await confined(run.root, posix.dirname(path), true), { recursive: true })
            const file = await confined(run.root, path, true)
            if (!keep.has(path)) {
              await writeFile(file, data.content, { flag: 'wx' })
              keep.add(path)
            } else {
              const handle = await open(file, 'r+')
              try {
                const info = await handle.stat()
                if (info.nlink !== 1 || !info.isFile()) throw new Error('Unsafe output file')
                await handle.writeFile(data.content)
                await handle.truncate(Buffer.byteLength(data.content))
              } finally { await handle.close() }
            }
            return { text: `Saved ${data.path}` }
          } })
      } })
    const abort = () => handle.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', abort, { once: true })
    let opened = false
    const close = async () => {
      signal.removeEventListener('abort', abort)
      await handle.dispose()
    }
    try {
      signal.throwIfAborted()
      const skills = new Map<string, SkillDefinition>()
      for (const name of [...Object.values(names), 'requirement-analysis-pipeline']) {
        try { skills.set(name, await loadItemizationSkill(ctx, handle.agent, name, signal)) }
        catch (error) { throw new ModelExecutionError('skill-unavailable', error instanceof Error ? error.message : name) }
      }
      const provenance: { name: string; provider: string; instructionsSha256: string; resources: { path: string; sha256: string }[] }[] = []
      const localResource = async (name: string, path: string) => {
        const base = skills.get(name)!.resourceBase
        if (base?.kind !== 'directory') throw new ModelExecutionError('skill-unavailable', `Skill ${name} needs local resource ${path}`)
        const bytes = await boundedFile(base.path, path, this.limit).catch(() => { throw new ModelExecutionError('skill-unavailable', `Missing ${path} in ${name}`) })
        provenance.find(item => item.name === name)!.resources.push({ path, sha256: sha256(bytes) })
        const copy = `workbench-runs/${run.id}/validators/${name}/${posix.basename(path)}`
        await writeOwned(run.root, copy, bytes)
        return confined(run.root, copy)
      }
      for (const skill of skills.values()) provenance.push({ name: skill.name, provider: skill.provider, instructionsSha256: sha256(skill.content), resources: [] })
      const grammar = new Map<ModelKind, string>()
      for (const kind of Object.keys(modelingDirectories) as ModelKind[]) {
        grammar.set(kind, await localResource(names[kind], kind === 'DialogMap' ? 'scripts/grammar_dialogmap.tx' : 'scripts/grammar.tx'))
      }
      const contract = await localResource('requirement-analysis-pipeline', 'scripts/validate_stage_contract.py')
      const registryCheck = await localResource(names.parse, 'scripts/validate_entity_registry.py')
      const stageContract = await localResource('requirement-analysis-pipeline', 'references/stage-contract-v1.md')
      for (const step of Object.keys(names) as ModelingStage[]) {
        const path = `workbench-runs/${run.id}/validators/${names[step]}/SKILL.md`
        await writeOwned(run.root, path, skills.get(names[step])!.content)
        stageReferences.set(step, { skill: path, reference: normalize(step === 'parse' ? stageContract : grammar.get(step)!) })
      }
      const version = await pythonCheck(config.pythonExecutable, ['-c', 'import sys, textx; print(sys.version.split()[0], textx.__version__)'], featureDir, signal)
        .catch(error => { throw new ModelExecutionError('executor', `Python/textX: ${String(error).slice(0, 300)}`) })
      for (const file of grammar.values()) await pythonCheck(config.pythonExecutable, ['-c', strictTextx, file], featureDir, signal)
      const source = await confined(run.root, input.source)
      const projectDir = await confined(run.root, posix.dirname(input.chunks))
      let imageIndex: string | undefined
      if (hasImageTool) {
        const paths = Object.fromEntries(await Promise.all(Object.entries(input.assets)
          .map(async ([reference, path]) => [reference, await confined(run.root, path)])))
        const path = `workbench-runs/${run.id}/input/registered_images.json`
        await writeOwned(run.root, path, JSON.stringify(paths, null, 2))
        allowedReads.add(path)
        imageIndex = await confined(run.root, path)
      }
      ctx.get('sessionTitle')?.rename(handle.agent.session, `建模至 DSL · ${run.feature.name} · ${run.materialLabel}`)
      await workspace.attachSession(handle.agent.id)
      await input.onSession(handle.agent.id)
      await writeOwned(run.root, `workbench-runs/${run.id}/execution.json`, JSON.stringify({ preset: preset.id, model: selection, python: version.trim(),
        validatorSha256: sha256(strictTextx), skills: provenance }, null, 2))
      handle.agent.model.select(selection)
      const runCheck = async (stage: string, script: string, args: string[]) => {
        const attempt = (checks.get(stage) ?? 0) + 1
        checks.set(stage, attempt)
        const path = `workbench-runs/${run.id}/checks/${stage}-${attempt}.txt`
        try {
          const output = await pythonCheck(config.pythonExecutable, [script, ...args], featureDir, signal)
          await writeOwned(run.root, path, output)
        } catch (error) {
          if (!signal.aborted) await writeOwned(run.root, path, String(error))
          throw error
        }
      }
      opened = true
      return {
        execute: async (step, feedback) => {
          signal.throwIfAborted()
          stage = step
          const { skill, reference } = stageReferences.get(step)!
          const outputs = step === 'parse' ? parseOutputs.join('、')
            : `${modelingDirectories[step]}${step === 'Environment' ? '' : '/*.dsl'}、${reportName(step)}`
          const prompt = [
            `请按流水线二处理「${run.feature.name}」，当前阶段为 ${step === 'parse' ? '原文解析' : step}。`,
            `功能 Markdown：${source}`,
            `项目根目录：${projectDir}（含 chunks.json 和关系快照）`,
            `目标：${goals[step]}。输出到 ${featureDir}：${outputs}。`,
            '要求：原文 Markdown 保持只读。只记录原文明确支持的关系和 DSL，疑点留待确认。用 workbench_model_read 读文件，workbench_model_write 按相对路径保存。完成后简述结果或阻塞原因，由 Host 校验并推进。',
            `参考（按需分段读取）：${await confined(run.root, skill)}，${await confined(run.root, reference)}`,
            step === 'parse'
              ? [
                  `需求记录标识：${JSON.stringify({ schema_version: '1.0', run_id: run.id, feature_id: run.feature.id,
                    source: { path: source, sha256: run.sourceSha256 } })}`,
                  '逐字引用原文、标注行号和责任范围。实体表按技能结构填写。IF/THEN 的同一行注释写入 [derivation: null] [requirement_id: 实际ID]。关系使用本功能名及原文引句，歧义写入 consistency_issues。',
                ].join('\n')
              : [
                  `输入：${parseOutputs.slice(0, 3).join('、')}${step !== 'Environment' ? '、Environment.dsl' : ''}。`,
                  step === 'Environment' ? 'Environment.evidence.json 写入 []。'
                    : '证据数组项为 {requirement_id,result,file,element,code}。result 逐字引用 expected_results，file 用相对路径，element 填唯一声明名，code 摘录实现结果的语句。无证据的结果省略。用 // requirement_ids: ID 标记。',
                ].join('\n'),
            imageIndex ? `图片：从 ${imageIndex} 查路径，仅在原文引用时用 read_image 查看。`
              : allowedImages.size ? '无法读取引用图片时，将图中待核实的信息留为疑点。' : '',
            feedback ? `校验反馈，请在当前阶段修正：\n${feedback}` : '',
          ].filter(Boolean).join('\n')
          const attempt = (tries.get(step) ?? 0) + 1
          tries.set(step, attempt)
          await writeOwned(run.root, `workbench-runs/${run.id}/prompts/${step}-${attempt}.txt`, prompt)
          try {
            handle.agent.followup(createUserMessage({ source: { kind: 'workbench-modeling', runId: run.id, stage: step }, content: [{ type: 'text', text: prompt }] }))
            await handle.agent.whenIdle()
            signal.throwIfAborted()
            const end = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason
            if (end?.kind === 'error' && ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(end.error.code)) {
              throw new ModelExecutionError('credentials', 'Configured model credentials are unavailable')
            }
            if (end?.kind !== 'completed') {
              const detail = end?.kind === 'error' ? `${end.error.code} · ${end.error.message}` : end?.kind ?? 'no result'
              throw new ModelExecutionError('model', `Agent turn ended with ${detail}`)
            }
          } finally { stage = undefined }
        },
        validateRequirements: mapped => runCheck(mapped ? 'dsl-contract' : 'context-contract', contract,
          ['requirements.json', '--source', source, '--json', ...mapped ? ['--stage', 'dsl', '--map', 'requirement_dsl_map.json'] : []]),
        validateEntityRegistry: async () => {
          const registry = JSON.parse((await boundedFile(run.root, `${directory}/entity_registry.json`, this.limit)).toString('utf8').replace(/^\uFEFF/, ''))
          const attempt = (checks.get('entity-registry') ?? 0) + 1
          const path = `workbench-runs/${run.id}/checks/entity-registry-input-${attempt}.json`
          await writeOwned(run.root, path, JSON.stringify(entityRegistryValidationView(registry)))
          try {
            await runCheck('entity-registry', registryCheck, [await confined(run.root, path)])
          } catch (error) {
            const issues = error instanceof Error ? error.message.split(/\r?\n/).filter(line => line.includes('[ERR]')) : []
            if (!issues.length) throw error
            throw new Error(issues.join('\n'))
          }
        },
        validateSyntax: async models => {
          for (const [kind, file] of grammar) {
            const checked = models.filter(model => model.kind === kind).map(model => model.path)
            if (!checked.length) continue
            await runCheck(kind, '-c', [strictTextx, file, ...checked])
          }
        },
        close,
      }
    } finally {
      if (!opened) await close()
    }
  }
}

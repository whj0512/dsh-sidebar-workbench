import { spawn } from 'node:child_process'
import { z } from 'zod'
import { modelKinds, type ModelKind } from '../shared/modeling-api.ts'

const requirement = z.object({
  requirement_id: z.string().min(1), source_location: z.object({ section: z.string(), start_line: z.number().int().positive(), end_line: z.number().int().positive() }),
  source_text: z.string().min(1), requirement_type: z.string(), responsibility_scope: z.string(),
  expected_results: z.array(z.string()), testability: z.enum(['testable', 'non_testable', 'external_dependency', 'deferred']), reason: z.string(),
}).passthrough()
export const requirementsSchema = z.object({
  schema_version: z.literal('1.0'), run_id: z.string(), feature_id: z.string(),
  source: z.object({ path: z.string(), sha256: z.string() }), requirements: z.array(requirement).min(1),
}).passthrough()
export type Requirements = z.infer<typeof requirementsSchema>
export const registrySchema = z.object({
  functions: z.array(z.object({ entities: z.object({ pages: z.array(z.unknown()).default([]) }).passthrough() })).length(1),
}).passthrough()
export const modelingDirectories: Record<ModelKind, string> = {
  Environment: 'Environment.dsl', ExternalScenario: 'ExternalScenarios', Statechart: 'Statecharts', DialogMap: 'DialogMaps',
}
export const modelReceipts = z.array(z.object({ requirement_id: z.string(), result: z.string().min(1), file: z.string(),
  element: z.string().min(1), code: z.string().trim().min(1) }).strict())

export function validateIfThen(markdown: string, requirements: Requirements): void {
  const ids = new Set(requirements.requirements.map(item => item.requirement_id))
  if (!markdown.trim()) throw new Error('if-then.md is empty')
  const invalid = new Set<string>()
  let blockIds: string[] = []
  let attributable = false
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    const line = raw.trim()
    const standalone = /^\/\//.test(line)
    const inlineAt = line.search(/\s\/\//)
    const logic = inlineAt < 0 ? line : line.slice(0, inlineAt)
    const pair = /^IF\s+\S.*?\s+THEN\s+\S/i.test(logic)
    if (!standalone && !pair) {
      if (/^(?:#{1,6}\s|>|\x60{3,}|~{3,})/.test(line)) blockIds = []
      continue
    }
    const comment = standalone ? line.slice(2) : inlineAt < 0 ? '' : line.slice(inlineAt + 3)
    const markers = [...comment.matchAll(/\[\s*requirement_id\s*:\s*([^\]]*)\]/gi)].map(match => match[1]!.trim())
    const bare = /^\s*requirement_id\s*:\s*([^\s\]]*)/i.exec(comment)
    if (bare) markers.push(bare[1]!)
    for (const id of markers) {
      if (!ids.has(id)) invalid.add(`line ${index + 1}: ${id || '(empty ID)'}`)
    }
    if (standalone && markers.length) blockIds = markers
    if (pair && (markers.length || blockIds.length)) attributable = true
  }
  if (invalid.size) throw new Error(`if-then.md contains unknown requirement IDs (${[...invalid].slice(0, 8).join(', ')})`)
  if (!attributable && requirements.requirements.some(item => item.testability === 'testable')) {
    throw new Error('if-then.md needs IF ... THEN ... // [derivation: null] [requirement_id: ACTUAL_ID] with an ID from requirements.json')
  }
}

const object = z.record(z.string(), z.unknown())
const physicalInterface = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['CAN', 'LIN', 'ETHERNET', 'FLEXRAY', '硬线', '诊断', '服务', 'HARDWIRE', 'DIAGNOSTIC', 'SERVICE']),
  connected_devices: z.array(z.string().trim().min(1)),
  signals_carried: z.array(z.string().trim().min(1)),
  description: z.string(),
})

/** Adapt the skill's current registry format to its older validator without rewriting modeling data. */
export function entityRegistryValidationView(value: unknown): unknown {
  const registry = z.looseObject({
    functions: z.array(z.looseObject({ entities: object })),
    cross_references: object.optional(),
  }).parse(structuredClone(value))
  for (const { entities } of registry.functions) {
    const signals = object.safeParse(entities.signals)
    if (signals.success) {
      for (const signal of Object.values(signals.data)) {
        const parsed = object.safeParse(signal)
        if (!parsed.success || !Array.isArray(parsed.data.usages)) continue
        for (const usage of parsed.data.usages) {
          const record = object.safeParse(usage)
          if (record.success && record.data.entity_value === null && record.data.entity_value_description === null) {
            usage.entity_value = []
            usage.entity_value_description = []
          }
        }
      }
    }
    if (Array.isArray(entities.interfaces)) {
      entities.interfaces = entities.interfaces.filter(entry => {
        const record = object.safeParse(entry)
        return !record.success || !physicalInterface.safeParse({
          ...record.data, type: typeof record.data.type === 'string' ? record.data.type.toUpperCase() : record.data.type,
        }).success
      })
    }
  }
  const references = registry.cross_references
  if (references && !('interface_transitions' in references) && Array.isArray(references.page_transitions)) {
    references.interface_transitions = references.page_transitions
  }
  return registry
}

export type ModelSource = { kind: ModelKind; path: string; text: string }
const snippet = (value: string) => value.replace(/\s+/g, ' ').trim()
const commentsAndStrings = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const withoutComments = (value: string) => value.replace(commentsAndStrings, token => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token)
const syntaxOnly = (value: string) => value.replace(commentsAndStrings, token => token.replace(/[^\r\n]/g, ' '))

function locateAssertion(model: ModelSource, element: string, requirement: string): string | undefined {
  const masked = syntaxOnly(model.text)
  const declaration = [...masked.matchAll(/\b(?:Scenario|Statechart|State|Condition|Call|Transition|DialogMap|Page)\s+([^\s{};]+)\s*\{/g)]
    .filter(match => match[1] === element)
  if (declaration.length !== 1) return
  const start = declaration[0]!.index!
  const brace = start + declaration[0]![0].lastIndexOf('{')
  let depth = 1
  let end = brace + 1
  for (; depth && end < masked.length; end++) {
    if (masked[end] === '{') depth++
    if (masked[end] === '}') depth--
  }
  const preceding = model.text.slice(0, start).split(/\r?\n/).slice(-3).join('\n')
  const segment = preceding + model.text.slice(start, end)
  const hasId = [...segment.matchAll(commentsAndStrings)].some(match => match[0].startsWith('/') &&
    match[0].split(/[\s,;:\[\]]+/).includes(requirement))
  return hasId ? withoutComments(model.text.slice(brace + 1, end - 1)) : undefined
}

export function makeMapping(requirements: Requirements, models: readonly ModelSource[], reports: Partial<Record<ModelKind, unknown>>) {
  const mapped = new Map(requirements.requirements.map(item => [item.requirement_id, item]))
  const assertions = new Map<string, Map<string, Set<string>>>()
  for (const kind of modelKinds) {
    if (!(kind in reports)) continue
    for (const row of modelReceipts.parse(reports[kind])) {
      const item = mapped.get(row.requirement_id)
      const model = models.find(file => file.path === row.file && file.kind === kind)
      if (!item || item.testability !== 'testable' || !item.expected_results.includes(row.result) || !model || kind === 'Environment') {
        throw new Error(`Invalid DSL assertion for ${row.requirement_id} (${row.file})`)
      }
      const source = locateAssertion(model, row.element, item.requirement_id)
      if (!source || !snippet(source).includes(snippet(row.code))
        || !/[=<>!]|\b(?:to|action|display_text|Postcondition|Ensure|Expectation|Assert|Then|Transition|Widget)\b/i.test(row.code)) {
        throw new Error(`Unverified DSL location or assertion: ${row.file}#${row.element} (${item.requirement_id})`)
      }
      const byResult = assertions.get(item.requirement_id) ?? new Map<string, Set<string>>()
      const refs = byResult.get(row.result) ?? new Set<string>()
      refs.add(`${row.file}#${row.element}`)
      byResult.set(row.result, refs)
      assertions.set(item.requirement_id, byResult)
    }
  }
  return { schema_version: '1.0', run_id: requirements.run_id, feature_id: requirements.feature_id,
    stage: 'dsl', source_sha256: requirements.source.sha256, coverage: requirements.requirements.map(item => {
      const claims = assertions.get(item.requirement_id)
      const covered = [...claims?.keys() ?? []]
      const uncovered = item.expected_results.filter(result => !covered.includes(result))
      const status = item.testability !== 'testable' ? item.testability
        : !covered.length ? 'missing' : uncovered.length ? 'partial' : 'covered'
      return { requirement_id: item.requirement_id, status, artifacts: [...new Set([...claims?.values() ?? []].flatMap(refs => [...refs]))],
        assertions: covered, uncovered_assertions: item.testability === 'testable' ? uncovered : [],
        reason: item.testability !== 'testable' ? item.reason : uncovered.length ? 'DSL evidence incomplete' : '' }
    }) }
}

/** A receipt can survive a revision only when its marked declaration and assertion survive. */
export function unchangedModelReceipt(before: ModelSource, after: ModelSource, receipt: z.infer<typeof modelReceipts>[number]): boolean {
  const original = locateAssertion(before, receipt.element, receipt.requirement_id)
  const edited = locateAssertion(after, receipt.element, receipt.requirement_id)
  const tokens = (text: string) => JSON.stringify(text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+/g))
  return original !== undefined && edited !== undefined && tokens(original) === tokens(edited)
}

export function unifiedChecks(models: readonly ModelSource[]): void {
  const environment = withoutComments(models.find(item => item.kind === 'Environment')?.text ?? '')
  const interactions = new Set([...environment.matchAll(/\bInteraction\s+([^\s{;]+)\s*\{/g)].map(match => match[1]))
  for (const model of models) {
    const code = withoutComments(model.text)
    if (model.kind === 'ExternalScenario') {
      for (const ref of code.matchAll(/\bInteraction\s+([^\s{;]+)\s*;/g)) {
        if (!interactions.has(ref[1])) throw new Error(`${model.path}: Environment does not declare Interaction ${ref[1]}`)
      }
    } else if (model.kind === 'Statechart' && !/\bStart\s+[^;]+;/.test(code)) {
      throw new Error(`${model.path}: missing Statechart Start`)
    } else if (model.kind === 'DialogMap') {
      const nodes = new Set([...code.matchAll(/\b(?:Page|Entry)\s+([^\s{;]+)/g)].map(match => match[1]))
      for (const ref of code.matchAll(/\b(?:from|to)\s*:\s*([^\s;]+)/g)) {
        if (!nodes.has(ref[1])) throw new Error(`${model.path}: undefined DialogMap node ${ref[1]}`)
      }
    }
  }
}

/** Run only plugin-selected validators. Resolve after the process and its pipes close, including on abort. */
export function pythonCheck(python: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', '-X', 'utf8', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let output = ''
    let failure: Error | undefined
    const append = (buffer: Buffer) => {
      if (output.length > 100_000) {
        failure ??= new Error('Python validator output exceeds limit')
        child.kill()
      } else output += buffer.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', error => { failure ??= error })
    child.once('close', code => {
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code !== 0) reject(new Error(output.trim().slice(0, 3000) || `Python validator exited with code ${code}`))
      else resolve(output)
    })
  })
}

export const strictTextx = [
  'import sys',
  'from textx import metamodel_from_file',
  'grammar, *files = sys.argv[1:]',
  'model = metamodel_from_file(grammar)',
  'for file in files:',
  '    model.model_from_file(file, encoding="utf-8-sig")',
  '    print(file)',
].join('\n')

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { EditorDraft } from '../shared/model-editor.ts'
import type { ModelKind, ModelProblem } from '../shared/modeling-api.ts'
import { projectGraph } from './model-editor-graph.ts'
import { pythonCheck } from './modeling-validation.ts'

export const defaultConverterUrl = 'http://127.0.0.1:8000'
export const converterUrlSchema = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}, 'Use a loopback BAIC converter origin')
export class ModelEditorError extends Error {
  constructor(readonly code: ModelProblem, detail: string) { super(detail) }
}

const suffix: Record<ModelKind, string> = { Environment: '/IBD', ExternalScenario: '/ESD', Statechart: '', DialogMap: '/UI' }
export const editorLimit = 1_000_000
const wireLimit = 8_000_000
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const signatures = String.raw`
import hashlib, json, sys
from textx import TextXError, metamodel_from_file
grammar, *files = sys.argv[1:]
mm = metamodel_from_file(grammar)

def freeze(value):
    if isinstance(value, list):
        return [freeze(item) for item in value]
    attrs = getattr(type(value), '_tx_attrs', None)
    if attrs is None:
        return value
    result = {}
    for name, attr in attrs.items():
        item = getattr(value, name)
        if attr.ref and not attr.cont:
            ref = lambda obj: [type(obj).__name__, obj.name]
            encoded = [ref(obj) for obj in item] if isinstance(item, list) else ref(item) if item else None
        else:
            encoded = freeze(item)
        # BAIC emits explicit empty optional lists in DialogMap.
        if encoded in (None, {'WidgetList': {}}, {'StringList': {}}, []):
            continue
        result[name] = encoded
    return {type(value).__name__: result}

for path in files:
    try:
        data = freeze(mm.model_from_file(path, encoding='utf-8-sig'))
        print(hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest())
    except TextXError as error:
        sys.exit(str(error))
`

export async function grammarSignatures(python: string, grammar: Uint8Array, texts: readonly string[]): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-model-editor-'))
  try {
    const file = join(scratch, 'grammar.tx')
    await writeFile(file, grammar)
    const paths = await Promise.all(texts.map(async (text, index) => {
      const path = join(scratch, `${index}.dsl`)
      await writeFile(path, text)
      return path
    }))
    const result = await pythonCheck(python, ['-c', signatures, file, ...paths], scratch, AbortSignal.timeout(15_000))
    const hashes = result.trim().split(/\s+/)
    if (hashes.length !== texts.length || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('Unexpected textX validator output')
    }
    return hashes
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// Do not mistake a quoted expression containing // for a trace comment.
const codeOrComment = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const markers = (text: string) => [...text.matchAll(codeOrComment)]
  .filter(match => match[0].startsWith('/') && /requirement_ids?\s*:/i.test(match[0]))
  .map(match => match[0].trim())

/** The registered ESD ID can consume the closing parenthesis of an unpadded condition. */
function padScenarioConditions(text: string): string {
  const masked = text.replace(codeOrComment, part => part.replace(/[^\r\n]/g, ' '))
  const boundaries = [...masked.matchAll(/\b(?:if|elif|while)\s*\(([^\r\n]*)\)\s*\{/g)]
  for (const match of boundaries.reverse()) {
    const start = match.index + match[0].indexOf('(') + 1
    const end = match.index + match[0].lastIndexOf(')')
    text = text.slice(0, start) + ' ' + text.slice(start, end).trim() + ' ' + text.slice(end)
  }
  return text
}

/** BAIC UI omits the header. Its declarations retain their own order in the grammar check. */
function retainDialogHeader(text: string, source: string): string {
  const rootIndex = (value: string) => value.replace(codeOrComment, part => ' '.repeat(part.length)).search(/\bDialogMap\s+[^\s{]+\s*\{/)
  const before = rootIndex(source)
  const after = rootIndex(text)
  if (before < 0 || after < 0 || markers(text).length) return text
  const header = source.slice(0, before)
  return markers(header).length ? header + text.slice(after) : text
}

export class ModelEditorConverter {
  constructor(private readonly origin: string, private readonly python: string, private readonly request: typeof fetch = fetch) {}

  private async call(path: string, body: string, json: boolean, outputLimit: number): Promise<string> {
    if (Buffer.byteLength(body) > wireLimit) throw new ModelEditorError('converter-response', 'BAIC request exceeds the editor limit')
    let response: Response
    try {
      response = await this.request(new URL(path, this.origin), {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8' },
      })
    } catch (error) {
      throw new ModelEditorError('converter-unavailable', `${this.origin}${path}: ${errorText(error)}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 400 || response.status === 422 ? 'converter-dialect' : 'converter-response'
      throw new ModelEditorError(code, `${path}: HTTP ${response.status}`)
    }
    if (!response.body) throw new ModelEditorError('converter-response', `${path}: empty response`)
    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > outputLimit) throw new Error('response exceeds the editor limit')
        chunks.push(value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw new ModelEditorError('converter-response', `${path}: ${errorText(error)}`)
    } finally { reader.releaseLock() }
  }

  async validate(kind: ModelKind, grammar: Uint8Array, content: string) {
    try { return (await grammarSignatures(this.python, grammar, [content]))[0]! }
    catch (error) { throw new ModelEditorError('validation', `${kind} textX: ${errorText(error)}`) }
  }

  async sync(kind: ModelKind, grammar: Uint8Array, draft: EditorDraft, environment?: string) {
    const forward = async (text: string) => {
      const scenario = kind === 'ExternalScenario'
      if (scenario && !environment) throw new ModelEditorError('converter-dialect', 'ExternalScenario requires Environment.dsl from the same revision')
      const data = await this.call('/dsl-to-rbg' + suffix[kind], scenario
        ? JSON.stringify({ scenario_dsl: text, environment_dsl: environment }) : text, scenario, wireLimit)
      try {
        const wire: unknown = JSON.parse(data)
        return { wire, ...projectGraph(kind, wire) }
      } catch (error) { throw new ModelEditorError('converter-response', `${kind}: ${errorText(error)}`) }
    }
    const backward = async (wire: unknown) => {
      const output = await this.call('/rbg-to-dsl' + suffix[kind], JSON.stringify(wire), true, editorLimit)
      if (kind === 'ExternalScenario') return padScenarioConditions(output)
      if (kind === 'DialogMap') return retainDialogHeader(output, draft.text)
      return output
    }
    const original = await this.validate(kind, grammar, draft.text)
    const base = await forward(draft.text)
    const roundtrip = await backward(base.wire)
    const equalMarkers = (text: string) => JSON.stringify(markers(text)) === JSON.stringify(markers(draft.text))
    const validateOutput = async (text: string) => {
      try { return await this.validate(kind, grammar, text) }
      catch (error) { throw new ModelEditorError('converter-dialect', `BAIC output failed the registered grammar: ${errorText(error)}`) }
    }
    if (await validateOutput(roundtrip) !== original || !equalMarkers(roundtrip)) {
      throw new ModelEditorError('converter-loss', `${kind} round trip changed DSL declarations, references or requirement markers`)
    }
    if (!draft.changes.length) return { text: draft.text, graph: base.graph, wire: base.wire }
    try { base.apply(draft.changes) }
    catch (error) { throw new ModelEditorError('converter-loss', errorText(error)) }
    const edited = await backward(base.wire)
    const editedSignature = await validateOutput(edited)
    const result = await forward(edited)
    const repeated = await backward(result.wire)
    const cells = [...base.graph.nodes, ...base.graph.edges]
    const resultCells = [...result.graph.nodes, ...result.graph.edges]
    const expectedFields = new Map(cells.flatMap(cell => cell.fields.map(field => [`${cell.id}/${field.key}`, field.value] as const)))
    for (const change of draft.changes) expectedFields.set(`${change.cell}/${change.field}`, change.value)
    const fieldsMatch = cells.length === resultCells.length && resultCells.every((cell, index) =>
      cells[index]?.id === cell.id && cells[index]?.type === cell.type && cells[index]?.fields.length === cell.fields.length &&
      cell.fields.every(field => expectedFields.get(`${cell.id}/${field.key}`) === field.value))
    if (await validateOutput(repeated) !== editedSignature || !equalMarkers(edited) || !equalMarkers(repeated)
      || !fieldsMatch) {
      throw new ModelEditorError('converter-loss', 'BAIC did not preserve the edited graph fields or requirement markers')
    }
    return { text: edited, graph: result.graph, wire: result.wire }
  }
}

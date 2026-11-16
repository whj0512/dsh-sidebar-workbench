import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { editorId, editorLayout } from '../shared/model-editor.ts'
import { modelArtifactSchema, modelKinds, type ModelKind, type ModelingRun } from '../shared/modeling-api.ts'
import { boundedFile, writeOwned, sha256 } from './itemization-files.ts'
import { ModelEditorError, editorLimit } from './model-editor-converter.ts'
import type { ModelingStore } from './modeling-store.ts'
import { modelingDirectories, type ModelSource } from './modeling-validation.ts'
import { confined } from './project-service.ts'

type Artifact = z.infer<typeof modelArtifactSchema>
export const revisionSchema = z.object({
  schema: z.literal(1), id: editorId, runId: editorId, projectId: editorId, baselineId: editorId,
  bindingRevision: z.number().int().positive(), parent: editorId.nullable(), createdAt: z.string(), number: z.number().int().positive(),
  artifacts: z.array(modelArtifactSchema), layout: z.record(z.string(), editorLayout),
  map: modelArtifactSchema.optional(), review: z.array(z.string()),
}).strict()
export type EditorRevision = z.infer<typeof revisionSchema>
export const editorBase = (run: ModelingRun) => `workbench-runs/${run.id}`
export const editorRevisionPath = (run: ModelingRun, id: string) => `${editorBase(run)}/revisions/${id}`
const indexName = (number: number) => String(number).padStart(12, '0') + '.json'
export const editorSummary = (run: ModelingRun, revision: EditorRevision) =>
  ({ id: revision.id, createdAt: revision.createdAt, path: editorRevisionPath(run, revision.id) })
export const editorJson = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))

export function editorKind(file: string): ModelKind | undefined {
  return modelKinds.find(kind => {
    const directory = modelingDirectories[kind]
    return kind === 'Environment' ? file === directory : file.startsWith(directory + '/') && /^[^/:\\]+\.dsl$/.test(file.slice(directory.length + 1))
  })
}

const grammarPath: Record<ModelKind, string> = {
  Environment: 'requirement-environment/grammar.tx',
  ExternalScenario: 'requirement-externalscenario/grammar.tx',
  Statechart: 'requirement-constraint/grammar.tx',
  DialogMap: 'requirement-dialogmap/grammar_dialogmap.tx',
}

export class ModelEditorStore {
  private readonly base: string
  private readonly index: string

  constructor(private readonly run: ModelingRun, private readonly store: ModelingStore, private readonly limit: number) {
    this.base = editorBase(run)
    this.index = `${this.base}/revisions`
  }

  async catalog() {
    const names = await readdir(await confined(this.run.root, this.index, true)).catch(error => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    const numbers = names.filter(name => /^\d{12}\.json$/.test(name)).sort()
    return Promise.all(numbers.map(async name => {
      const revision = revisionSchema.parse(editorJson(await boundedFile(this.run.root, `${this.index}/${name}`, this.limit)))
      const { run } = this
      const folder = editorRevisionPath(run, revision.id)
      if (name !== indexName(revision.number) || revision.runId !== run.id || revision.projectId !== run.projectId ||
        revision.baselineId !== run.baselineId || revision.bindingRevision !== run.bindingRevision ||
        revision.artifacts.some(item => !item.path.startsWith(`${folder}/model/`) || !editorKind(item.path.slice(folder.length + 7))) ||
        (revision.map && revision.map.path !== `${folder}/model/requirement_dsl_map.json`)) {
        throw new ModelEditorError('changed', `Invalid editor revision manifest: ${name}`)
      }
      return revision
    }))
  }

  registered(path: string) { return this.run.artifacts.find(item => item.path === `${this.base}/${path}`) }

  async original(path: string) {
    const ref = this.registered(path)
    if (!ref) throw new ModelEditorError('validation', `Source run did not register ${path}`)
    return this.store.verified(ref)
  }

  grammar(kind: ModelKind) { return this.original(`validators/${grammarPath[kind]}`) }

  files(revision?: EditorRevision) {
    const prefix = (revision ? editorRevisionPath(this.run, revision.id) : this.base) + '/model/'
    return (revision?.artifacts ?? this.run.artifacts).flatMap(artifact => {
      if (!artifact.path.startsWith(prefix)) return []
      const file = artifact.path.slice(prefix.length)
      const kind = editorKind(file)
      return kind ? [{ file, kind, artifact }] : []
    })
  }

  async text(artifact: Artifact) {
    const bytes = await this.store.verified(artifact)
    if (bytes.length > editorLimit) throw new ModelEditorError('validation', `${artifact.path} exceeds the editor limit`)
    return bytes.toString('utf8')
  }

  async models(revision?: EditorRevision): Promise<ModelSource[]> {
    return Promise.all(this.files(revision).map(async ({ file, kind, artifact }) =>
      ({ path: file, kind, text: await this.text(artifact) })))
  }

  async map(revision?: EditorRevision) {
    const ref = revision ? revision.map : this.registered('model/requirement_dsl_map.json')
    return ref ? this.text(ref) : undefined
  }

  async save(previous: EditorRevision | undefined, parent: EditorRevision | undefined, models: ModelSource[],
    layout: EditorRevision['layout'], map: string | undefined, review: string[], check: () => Promise<void>) {
    const { run } = this
    const id = randomUUID()
    const folder = editorRevisionPath(run, id)
    const write = async (file: string, text: string) => {
      const path = `${folder}/model/${file}`
      await writeOwned(run.root, path, text)
      return { path, sha256: sha256(text) }
    }
    const artifacts: Artifact[] = []
    for (const model of models) artifacts.push(await write(model.path, model.text))
    const mapped = map === undefined ? undefined : await write('requirement_dsl_map.json', map)
    const revision = revisionSchema.parse({ schema: 1, id, runId: run.id, projectId: run.projectId, baselineId: run.baselineId,
      bindingRevision: run.bindingRevision, parent: parent?.id ?? null, createdAt: new Date().toISOString(), number: (previous?.number ?? 0) + 1,
      artifacts, layout, map: mapped, review })
    await mkdir(await confined(run.root, this.index, true), { recursive: true })
    const temporary = await confined(run.root, `${folder}/manifest.tmp`, true)
    const destination = await confined(run.root, `${this.index}/${indexName(revision.number)}`, true)
    const handle = await open(temporary, 'wx')
    try {
      try {
        await handle.writeFile(JSON.stringify(revision) + '\n')
        await handle.sync()
      } finally { await handle.close() }
      await check()
      try { await link(temporary, destination) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw new ModelEditorError('conflict', 'Another editor saved a revision')
        }
        throw error
      }
      return revision
    } finally { await unlink(temporary).catch(() => {}) }
  }
}

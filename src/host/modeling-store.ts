import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { modelArtifactSchema } from '../shared/modeling-api.ts'
import { boundedFile, sha256 } from './itemization-files.ts'
import { confined } from './project-service.ts'

export class ModelArtifactChanged extends Error {}

const path = '.workbench/modeling'
const id = z.string().uuid()
const publishedModel = z.object({
  runId: id, featureId: id, sourceSha256: z.string(), relationSha256: z.string(),
  editorRevisionId: id.optional(),
  delta: modelArtifactSchema, artifacts: z.array(modelArtifactSchema),
}).strict()
const generation = z.object({
  schema: z.literal(1), projectId: id, baselineId: id, revision: z.number().int().positive(), runId: id,
  relations: modelArtifactSchema, models: z.array(publishedModel),
}).strict()
export type ModelPublication = z.infer<typeof generation>

export class ModelingStore {
  constructor(private readonly root: string, private readonly projectId: string, private readonly limit: number) {}

  async read(runId?: string): Promise<ModelPublication | undefined> {
    const names = await readdir(await confined(this.root, path, true)).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names.filter(name => /^\d{12}\.json$/.test(name)).sort().reverse()) {
      const value = generation.parse(JSON.parse((await boundedFile(this.root, `${path}/${name}`, this.limit)).toString('utf8')))
      if (value.projectId !== this.projectId || name !== this.name(value.revision)) throw new Error('Invalid model publication identity')
      if (!runId || value.runId === runId) return value
    }
  }

  private name(revision: number): string { return `${String(revision).padStart(12, '0')}.json` }

  async publish(expected: number, value: ModelPublication, check: () => Promise<void>): Promise<boolean> {
    if (((await this.read())?.revision ?? 0) !== expected) return false
    const record = generation.parse(value)
    if (record.revision !== expected + 1 || record.projectId !== this.projectId) throw new Error('Invalid model publication revision')
    await mkdir(await confined(this.root, path, true), { recursive: true })
    const temporary = await confined(this.root, `${path}/${randomUUID()}.tmp`, true)
    const target = await confined(this.root, `${path}/${this.name(record.revision)}`, true)
    const handle = await open(temporary, 'wx')
    try {
      try {
        await handle.writeFile(JSON.stringify(record) + '\n')
        await handle.sync()
      } finally { await handle.close() }
      await check()
      try { await link(temporary, target) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
        throw error
      }
      return true
    } finally { await unlink(temporary).catch(() => {}) }
  }

  async verified(artifact: { path: string; sha256: string }): Promise<Buffer> {
    const bytes = await boundedFile(this.root, artifact.path, this.limit)
    if (sha256(bytes) !== artifact.sha256) throw new ModelArtifactChanged(`Changed artifact: ${artifact.path}`)
    return bytes
  }
}

/** Append-only project state. Exclusive generation publication arbitrates writers across Host processes. */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { confined } from './project-service.ts'
import { itemizationStateSchema, type ItemizationState, type MaterialVersion, type CandidateReference, type CandidateId } from '../shared/itemization.ts'

/** Stable itemization failure identity; the Client owns localized display text. */
export class ItemizationError extends Error {
  /** @param code - Handling-relevant failure; no failed publication changes the previous baseline. */
  constructor(readonly code: 'conflict' | 'identity' | 'invalid' | 'changed' | 'unreviewed' | 'source-conflict' | 'run-not-settled') { super(code) }
}

/** Independent state for one canonical workspace directory and project identity. */
export class ItemizationStore {
  /** @param root - Canonical workspace directory. @param projectId - Identity already authorized by ProjectService. */
  constructor(private readonly root: string, private readonly projectId: string) {}

  /** @returns The newest generation, or undefined before the first write. Invalid newest state never falls back. */
  async read(): Promise<ItemizationState | undefined> {
    let directory: string
    try { directory = await confined(this.root, '.workbench/itemization') }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const generations = (await readdir(directory)).filter(name => /^\d{12}\.json$/.test(name)).sort()
    const latest = generations.at(-1)
    if (!latest) return undefined
    const state = itemizationStateSchema.parse(JSON.parse(await readFile(await confined(this.root, `.workbench/itemization/${latest}`), 'utf8')))
    if (state.projectId !== this.projectId || latest !== this.filename(state.revision)) throw new ItemizationError('identity')
    return state
  }

  private filename(revision: number): string {
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999999999) throw new ItemizationError('invalid')
    return `${String(revision).padStart(12, '0')}.json`
  }

  private async write(expectedRevision: number, update: (state: ItemizationState) => ItemizationState): Promise<ItemizationState> {
    const previous = await this.read()
    if ((previous?.revision ?? 0) !== expectedRevision) throw new ItemizationError('conflict')
    const initial: ItemizationState = previous ?? { schema: 1, projectId: this.projectId, revision: 1, materials: [], candidates: [], baseline: null }
    const state = itemizationStateSchema.parse({ ...update(initial), revision: expectedRevision + 1 })
    const directory = await confined(this.root, '.workbench/itemization', true)
    await mkdir(directory, { recursive: true })
    await confined(this.root, '.workbench/itemization')
    const target = await confined(this.root, `.workbench/itemization/${this.filename(state.revision)}`, true)
    const temporary = join(dirname(target), `${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx')
    try {
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
      try { await link(temporary, target) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ItemizationError('conflict')
        throw error
      }
    } finally { await unlink(temporary) }
    return state
  }

  /** @param material - Inspected snapshot references. @param revision - Last observed state revision, zero for an empty store. @returns Published state. */
  async registerMaterial(material: MaterialVersion, revision: number): Promise<ItemizationState> {
    await this.verifyMaterial(material)
    return this.write(revision, state => {
      if (state.materials.some(item => item.id === material.id || item.label === material.label)) throw new ItemizationError('conflict')
      return { ...state, materials: [...state.materials, material] }
    })
  }

  private async verifyMaterial(material: MaterialVersion): Promise<void> {
    for (const [path, expected] of [[material.original, material.originalSha256], [material.markdown, material.markdownSha256], ...(material.assets ?? []).map(asset => [asset.path, asset.sha256])]) {
      const file = await confined(this.root, path!)
      if (createHash('sha256').update(await readFile(file)).digest('hex') !== expected) throw new ItemizationError('changed')
    }
  }

  private async verify(candidate: CandidateReference): Promise<void> {
    const seen = new Set<string>()
    for (const artifact of candidate.artifacts) {
      if (seen.has(artifact.path) || !artifact.path.startsWith(`workbench-runs/${candidate.runId}/`)) throw new ItemizationError('invalid')
      seen.add(artifact.path)
      const file = await confined(this.root, artifact.path)
      const digest = createHash('sha256').update(await readFile(file)).digest('hex')
      if (digest !== artifact.sha256) throw new ItemizationError('changed')
    }
  }

  /** @param candidate - Validated, immutable run outputs. @param revision - Last observed state revision. @returns State with a pending candidate; baseline is unchanged. */
  async publishCandidate(candidate: CandidateReference, revision: number): Promise<ItemizationState> {
    await this.verify(candidate)
    return this.write(revision, state => {
      if (!state.materials.some(item => item.id === candidate.materialId) || state.candidates.some(item => item.id === candidate.id)
        || candidate.parentCandidateId && !state.candidates.some(item => item.id === candidate.parentCandidateId)) throw new ItemizationError('invalid')
      return { ...state, candidates: [...state.candidates, candidate] }
    })
  }

  /** @param candidateId - Entire candidate reviewed by the user. @param revision - State revision displayed during review. @param impact - Confirmed impact list from version comparison. @returns State with the single adopted baseline. */
  async adopt(candidateId: CandidateId, revision: number, impact: readonly string[], review?: Pick<NonNullable<ItemizationState['adoption']>, 'matches' | 'confirmedUnmatched' | 'approvalReason'>): Promise<ItemizationState> {
    const current = await this.read()
    if (!current || current.revision !== revision) throw new ItemizationError('conflict')
    const candidate = current.candidates.find(item => item.id === candidateId)
    if (!candidate) throw new ItemizationError('unreviewed')
    const material = current.materials.find(item => item.id === candidate.materialId)
    if (!material) throw new ItemizationError('invalid')
    await this.verifyMaterial(material)
    await this.verify(candidate)
    return this.write(revision, state => ({ ...state, baseline: candidateId,
      adoption: { candidateId, previousCandidateId: state.baseline, impact: [...impact], acceptedAt: new Date().toISOString(), ...review } }))
  }
}

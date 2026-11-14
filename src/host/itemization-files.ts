/** Confined, size-bounded snapshots and candidate indexes for itemization. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { posix, extname } from 'node:path'
import { z } from 'zod'
import { confined } from './project-service.ts'
import { inspectMaterial, type ProjectConfig } from './material-inspection.ts'
import { materialVersionSchema, type MaterialVersion, type CandidateReference } from '../shared/itemization.ts'
import type { ProjectCommand } from '../shared/project.ts'
import { compareItemizations, type ComparedFunction, type ComparedRelation, type FeatureId } from '../shared/itemization-diff.ts'
import { ItemizerExecutionError } from './itemizer-runtime.ts'

/** @param value - Exact bytes or stable serialized input. @returns Lowercase SHA-256. */
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
/** @param root - Workspace. @param path - Registered relative file. @param limit - Configured maximum bytes. @returns Bounded bytes. */
export async function boundedFile(root: string, path: string, limit: number): Promise<Buffer> {
  const file = await confined(root, path)
  const info = await stat(file)
  if (!info.isFile() || info.size > limit) throw new ItemizerExecutionError('validation', 'File exceeds limit')
  const bytes = await readFile(file)
  if (bytes.length > limit) throw new ItemizerExecutionError('validation', 'File changed while reading')
  return bytes
}
/** @param root - Workspace. @param path - Owned run-relative output. @param value - Exact file content. @returns Exclusive creation; existing files are never replaced. */
export async function writeOwned(root: string, path: string, value: string | Buffer): Promise<void> {
  const parent = posix.dirname(path)
  await mkdir(await confined(root, parent, true), { recursive: true })
  await writeFile(await confined(root, path, true), value, { flag: 'wx' })
}
/** @param markdown - Exact source text. @returns Local image references; remote URLs are retained without fetching. */
export function imageReferences(markdown: string): string[] {
  const references = [...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1] ?? match[2]!).filter(value => !/^(?:https?:|data:|#)/i.test(value))
  return [...new Set(references)]
}
/** @param root - Workspace. @param materials - Inspected source selection. @param limits - Existing material limits. @returns Immutable original, Markdown and referenced image snapshots. */
export async function snapshotMaterials(root: string, materials: NonNullable<ProjectCommand['materials']>, limits: ProjectConfig): Promise<MaterialVersion> {
  const originalInfo = await inspectMaterial(await confined(root, materials.original), materials.original, 'original', limits)
  const markdownInfo = await inspectMaterial(await confined(root, materials.markdown), materials.markdown, 'markdown', limits)
  if (originalInfo.status !== 'valid' || markdownInfo.status !== 'valid') throw new ItemizerExecutionError('validation', 'Invalid source material')
  const original = await boundedFile(root, materials.original, limits.maxMaterialBytes), markdown = await boundedFile(root, materials.markdown, limits.maxMaterialBytes)
  if (sha256(original) !== originalInfo.sha256 || sha256(markdown) !== markdownInfo.sha256) throw new ItemizerExecutionError('validation', 'Source changed during snapshot')
  const id = randomUUID(), directory = `.workbench/materials/${id}`
  const originalPath = `${directory}/original${extname(materials.original).toLowerCase()}`, markdownPath = `${directory}/source.md`
  const assets: NonNullable<MaterialVersion['assets']> = []
  for (const reference of imageReferences(markdown.toString('utf8'))) {
    const decoded = decodeURIComponent(reference.split('#')[0]!)
    if (/^[a-z]+:|^[\\/]/i.test(decoded)) throw new ItemizerExecutionError('validation', 'Absolute asset reference')
    const source = posix.normalize(posix.join(posix.dirname(materials.markdown.replaceAll('\\', '/')), decoded.replaceAll('\\', '/')))
    const bytes = await boundedFile(root, source, limits.maxMaterialBytes), hash = sha256(bytes)
    const path = `${directory}/assets/${assets.length}-${hash}${extname(source)}`
    await writeOwned(root, path, bytes); assets.push({ reference, path, sha256: hash })
  }
  await writeOwned(root, originalPath, original); await writeOwned(root, markdownPath, markdown)
  return materialVersionSchema.parse({ id, label: materials.version, original: originalPath, markdown: markdownPath,
    originalSha256: sha256(original), markdownSha256: sha256(markdown), assets })
}

export const chunksSchema = z.object({ chunks: z.array(z.object({
  chunk_id: z.string(), chunk_type: z.string(), title: z.string(), canonical_function_name: z.string().optional(),
  req_id: z.string().optional(), source_relative_path: z.string().optional(),
}).passthrough()).min(1), project_relation_seed: z.record(z.string(), z.unknown()) }).passthrough()
export const candidateIndexSchema = z.object({ relationFingerprint: z.string(), contentPath: z.string().optional(), relationPath: z.string().optional(), sourceChunks: z.string().optional(), functions: z.array(z.object({ id: z.string().uuid().transform(value => value as FeatureId),
  requirementId: z.string().nullable(), name: z.string(), contentSha256: z.string(), path: z.string() }).strict()),
  relations: z.array(z.object({ source: z.string().uuid().transform(value => value as FeatureId), target: z.string().uuid().transform(value => value as FeatureId), evidenceSha256: z.string() }).strict()) }).strict()
export type CandidateIndex = z.infer<typeof candidateIndexSchema>

/** @param root - Workspace. @param runId - Owning run. @param material - Input asset snapshot. @param limits - File limits. @returns Candidate index and all exact artifact references. */
export async function indexCandidate(root: string, runId: string, material: MaterialVersion, limits: ProjectConfig, previous?: CandidateIndex,
  imported?: { contentPath: string; relationPath: string; sourceChunks: string }): Promise<{ index: CandidateIndex; artifacts: CandidateReference['artifacts'] }> {
  const directory = `workbench-runs/${runId}/candidate`
  const chunks = chunksSchema.parse(JSON.parse((await boundedFile(root, imported?.contentPath ?? `${directory}/chunks.json`, limits.maxMaterialBytes)).toString('utf8')))
  let functions: (ComparedFunction & { path: string })[] = []
  const markdownFiles: string[] = []
  const visit = async (relative: string): Promise<void> => {
    for (const item of await readdir(await confined(root, relative), { withFileTypes: true })) {
      if (markdownFiles.length >= limits.maxProjectScanEntries) throw new ItemizerExecutionError('validation', 'Output entry limit')
      const path = `${relative}/${item.name}`
      if (item.isDirectory()) await visit(path)
      else if (item.isFile() && /\.md$/i.test(item.name)) markdownFiles.push(path)
      else if (item.isSymbolicLink()) throw new ItemizerExecutionError('validation', 'Output symlink')
    }
  }
  await visit(directory)
  for (const file of markdownFiles) {
    const content = (await boundedFile(root, file, limits.maxMaterialBytes)).toString('utf8')
    for (const reference of imageReferences(content)) {
      const destination = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(reference.split('#')[0]!)))
      if (!destination.startsWith(`workbench-runs/${runId}/`)) throw new ItemizerExecutionError('validation', 'Image escapes run')
      const asset = material.assets?.find(item => item.reference === reference)
      if (!asset) {
        if (imported && material.assets?.length) {
          const digest = sha256(await boundedFile(root, destination, limits.maxMaterialBytes))
          if (material.assets.some(item => item.sha256 === digest)) continue
        }
        throw new ItemizerExecutionError('validation', 'Unregistered image asset')
      }
      const bytes = await boundedFile(root, asset.path, limits.maxMaterialBytes)
      try { await writeOwned(root, destination, bytes) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || sha256(await boundedFile(root, destination, limits.maxMaterialBytes)) !== asset.sha256) throw error
      }
    }
  }
  for (const chunk of chunks.chunks.filter(item => item.chunk_type === 'functional_requirement')) {
    if (!chunk.canonical_function_name || !chunk.source_relative_path) throw new ItemizerExecutionError('validation', 'Function path missing')
    const path = posix.normalize(`${directory}/${chunk.source_relative_path}`)
    if (!path.startsWith(`${directory}/`)) throw new ItemizerExecutionError('validation', 'Function path escapes candidate')
    functions.push({ id: randomUUID() as FeatureId, requirementId: chunk.req_id || null, name: chunk.canonical_function_name,
      contentSha256: sha256(await boundedFile(root, path, limits.maxMaterialBytes)), path })
  }
  if (previous) {
    const matches = compareItemizations(previous.functions, functions, []).matches
    const inherited = new Map(matches.map(match => [match.candidate, match.previous]))
    functions = functions.map(item => ({ ...item, id: inherited.get(item.id) ?? item.id }))
  }
  const relationFile: unknown = JSON.parse((await boundedFile(root, imported?.relationPath ?? `${directory}/requirement_relations.json`, limits.maxMaterialBytes)).toString('utf8').replace(/^\uFEFF/, ''))
  const relationsData = z.object({ relations: z.array(z.object({ source: z.string(), target: z.string(), evidence: z.array(z.unknown()) }).passthrough()), consistency_issues: z.array(z.unknown()) }).passthrough().parse(relationFile)
  if (!imported && relationsData.consistency_issues.length) throw new ItemizerExecutionError('validation', 'Unresolved relations')
  const relations: ComparedRelation[] = []
  for (const relation of relationsData.relations) {
    const source = functions.find(item => item.name === relation.source), target = functions.find(item => item.name === relation.target)
    // Source-defined system nodes remain in the raw relation asset; function
    // matching compares their evidence through a separate relation digest.
    if (source && target) relations.push({ source: source.id, target: target.id, evidenceSha256: sha256(JSON.stringify(relation.evidence)) })
  }
  const index = candidateIndexSchema.parse({ functions, relations, relationFingerprint: sha256(JSON.stringify(relationFile)), ...imported })
  await writeOwned(root, `${directory}/index.json`, `${JSON.stringify(index, null, 2)}\n`)
  if (!imported) await writeOwned(root, `${directory}/project_relation_seed.json`, `${JSON.stringify(chunks.project_relation_seed, null, 2)}\n`)
  return { index, artifacts: await collectRunArtifacts(root, runId, limits) }
}

/** @param root - Canonical workspace. @param runId - Owning run. @param limits - Resource bounds. @returns Existing owned files, including partial diagnostics; no semantic validation is implied. */
export async function collectRunArtifacts(root: string, runId: string, limits: ProjectConfig): Promise<CandidateReference['artifacts']> {
  const artifacts: CandidateReference['artifacts'] = []
  const collect = async (relative: string): Promise<void> => {
    for (const item of await readdir(await confined(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${item.name}`
      if (artifacts.length >= limits.maxProjectScanEntries) throw new ItemizerExecutionError('validation', 'Output entry limit')
      if (item.isDirectory()) await collect(path)
      else artifacts.push({ path, sha256: sha256(await boundedFile(root, path, limits.maxMaterialBytes)) })
    }
  }
  await collect(`workbench-runs/${runId}`)
  return artifacts
}

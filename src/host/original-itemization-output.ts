/** Import original-skill files for review without rewriting their semantic output. */
import { posix } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from './material-inspection.ts'
import type { MaterialVersion } from '../shared/itemization.ts'
import { boundedFile, collectRunArtifacts, indexCandidate, writeOwned, type CandidateIndex } from './itemization-files.ts'
import { ItemizerExecutionError } from './itemizer-runtime.ts'

const originalChunksSchema = z.object({ chunks: z.array(z.object({ chunk_id: z.string(), title: z.string(), chunk_type: z.string(), canonical_function_name: z.string().optional(), source_relative_path: z.string().optional() }).passthrough()).min(1),
  project_relation_seed: z.record(z.string(), z.unknown()).optional() }).passthrough()

/** @param value - Original unresolved issue. @returns Presentation metadata; the original JSON remains unchanged. */
function displayIssue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { description: value }
  const issue = z.object({ description: z.string().optional(), issue: z.string().optional() }).passthrough().safeParse(value)
  return issue.success ? { ...issue.data, description: issue.data.description ?? issue.data.issue ?? JSON.stringify(value) } : { description: JSON.stringify(value) ?? String(value) }
}

/** @param root - Workspace. @param runId - Run owning all imported files. @param material - Snapshot identity. @param limits - Filesystem limits. @param previous - Previous index for stable function identities. @returns Indexed draft; source issues remain review blockers. */
export async function importOriginalItemization(root: string, runId: string, material: MaterialVersion, limits: ProjectConfig, previous?: CandidateIndex) {
  const directory = `workbench-runs/${runId}`, candidate = `${directory}/candidate`
  const artifacts = await collectRunArtifacts(root, runId, limits)
  const outputs = artifacts.filter(file => file.path.startsWith(`${candidate}/`) && posix.basename(file.path) === 'chunks.json')
  if (outputs.length !== 1) throw new ItemizerExecutionError('validation', 'Expected one original-skill chunks.json in this run output')
  const sourceChunks = outputs[0]!.path, base = posix.dirname(sourceChunks)
  const raw = originalChunksSchema.parse(JSON.parse((await boundedFile(root, sourceChunks, limits.maxMaterialBytes)).toString('utf8').replace(/^\uFEFF/, '')))
  const issues: { code: string; location: string; message: string }[] = []
  let missingFunctionFile = false
  const seed = raw.project_relation_seed ?? {}
  if (!raw.project_relation_seed) issues.push({ code: 'missing-seed', location: sourceChunks, message: 'Original output has no project_relation_seed; review is required' })
  const view = { ...raw, project_relation_seed: seed, chunks: raw.chunks.map(chunk => {
    if (chunk.chunk_type === 'functional_requirement' && (!chunk.source_relative_path || !chunk.canonical_function_name)) {
      missingFunctionFile = true
      issues.push({ code: 'missing-item-metadata', location: chunk.chunk_id, message: 'Original function output has no canonical name or Markdown path' })
    }
    if (!chunk.source_relative_path) return chunk
    const path = posix.normalize(posix.join(base, chunk.source_relative_path.replaceAll('\\', '/')))
    if (!path.startsWith(`${candidate}/`)) throw new ItemizerExecutionError('validation', 'Original item path escapes this candidate')
    if (chunk.chunk_type === 'functional_requirement' && !artifacts.some(file => file.path === path)) {
      missingFunctionFile = true
      issues.push({ code: 'missing-item', location: path, message: 'Original function Markdown is missing' })
    }
    return { ...chunk, source_relative_path: posix.relative(candidate, path) }
  }) }
  if (!view.chunks.some(chunk => chunk.chunk_type === 'functional_requirement')) issues.push({ code: 'missing-functions', location: sourceChunks, message: 'Original output lists no functional requirements' })
  let relationPath = `${base}/requirement_relations.json`
  if (!artifacts.some(file => file.path === relationPath)) {
    issues.push({ code: 'missing-relations', location: relationPath, message: 'Original relation output is missing; no relationship completion is assumed' })
    relationPath = `${candidate}/panel-relations.json`
    await writeOwned(root, relationPath, `${JSON.stringify({ relations: [], consistency_issues: [{ description: 'Original relation file is missing' }] }, null, 2)}\n`)
  }
  const relationValue = z.object({ consistency_issues: z.array(z.unknown()).optional() }).passthrough().parse(JSON.parse((await boundedFile(root, relationPath, limits.maxMaterialBytes)).toString('utf8').replace(/^\uFEFF/, '')))
  const seedConflicts = Array.isArray(seed.consistency_issues) ? seed.consistency_issues : []
  const sourceConflicts = [
    ...(seedConflicts.length ? [{ report: sourceChunks, issues: seedConflicts.map(displayIssue) }] : []),
    ...(relationValue.consistency_issues?.length ? [{ report: relationPath, issues: relationValue.consistency_issues.map(displayIssue) }] : []),
  ]
  const contentPath = `${candidate}/panel-content.json`
  await writeOwned(root, contentPath, `${JSON.stringify(view, null, 2)}\n`)
  await writeOwned(root, `${directory}/validation.json`, `${JSON.stringify({ schema: 1, workflow: 'original-skills', validationScope: 'artifact-import',
    passed: issues.length === 0, reviewBlocked: issues.length > 0 || sourceConflicts.length > 0, issues, sourceConflicts,
    originalChunks: sourceChunks, note: 'Original skill checks and their stdout are retained in the execution Session; this report only checks artifact import.' }, null, 2)}\n`)
  if (missingFunctionFile) throw new ItemizerExecutionError('validation', 'Original output references missing function Markdown')
  return indexCandidate(root, runId, material, limits, previous, { contentPath, relationPath, sourceChunks })
}

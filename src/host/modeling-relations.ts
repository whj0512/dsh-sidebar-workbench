import { z } from 'zod'
import { sha256 } from './itemization-files.ts'

const evidence = z.object({ section_id: z.string().trim().min(1), text: z.string().trim().min(1), source_file: z.string().optional() }).passthrough()
const edge = z.object({ source: z.string(), target: z.string(), relation_type: z.string(), subtype: z.string().nullish(),
  is_inferred: z.boolean(), evidence: z.array(evidence).min(1) }).passthrough()
const resourceEdge = edge.extend({ relation_type: z.literal('resource_artifact').default('resource_artifact'),
  subtype: z.string().trim().min(1) })
const external = z.object({ id: z.string().regex(/^external:[a-z0-9_-]+(?::[a-z0-9_-]+)+$/),
  name: z.string().trim().min(1), kind: z.enum(['external_requirement', 'external_resource', 'external_document']),
  system_name: z.string().optional(), aliases: z.array(z.string()).optional(), evidence: z.array(evidence).min(1) }).passthrough()
export const relationSeedSchema = z.object({ schema_version: z.literal('2.0'),
  requirements: z.array(z.object({ name: z.string(), source_relative_path: z.string().nullable().optional() }).passthrough()),
  relations: z.array(z.unknown()), consistency_issues: z.array(z.unknown()).default([]),
  external_candidates: z.array(external).default([]), resource_artifact_relations: z.array(z.unknown()).default([]),
  external_references: z.array(z.unknown()).default([]),
}).passthrough()
export const relationDeltaSchema = relationSeedSchema.pick({ schema_version: true, consistency_issues: true, external_candidates: true, external_references: true }).extend({
  source_function: z.string(), relations: z.array(edge), resource_artifact_relations: z.array(resourceEdge).default([]),
}).strict()
export type RelationSeed = z.infer<typeof relationSeedSchema>
export type RelationDelta = z.infer<typeof relationDeltaSchema>

function unique<T>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [JSON.stringify(item), item])).values()]
}

export function checkedDelta(value: unknown, seed: RelationSeed, name: string, source: string, sourcePath: string): RelationDelta {
  const delta = relationDeltaSchema.parse(value)
  if (delta.source_function !== name) throw new Error('Relation delta belongs to another function')
  const internal = new Set(seed.requirements.map(item => item.name))
  const known = new Map([...seed.external_candidates, ...delta.external_candidates].map(item => [item.id, item.kind]))
  const normalize = (items: z.infer<typeof evidence>[]) => items.map(item => {
    const normalizeLine = (line: string) => line.replace(/\r\n/g, '\n')
    if (!normalizeLine(source).includes(normalizeLine(item.text))) throw new Error(`Relation evidence is absent from the function source: ${item.section_id}`)
    return { ...item, source_file: sourcePath }
  })
  const filter = <T extends z.infer<typeof edge>>(items: T[], resource: boolean): T[] => items.flatMap(item => {
    const target = known.get(item.target)
    const evidence = normalize(item.evidence)
    if (item.source !== name || item.is_inferred
      || (resource ? item.relation_type !== 'resource_artifact' : !['conflict', 'dependency'].includes(item.relation_type))) {
      throw new Error('Relation delta has invalid ownership or type')
    }
    if (resource ? !target || target === 'external_requirement' : !internal.has(item.target) && target !== 'external_requirement') {
      delta.consistency_issues.push({ issue: 'Unresolved relation endpoint', source: name, target: item.target, evidence })
      return []
    }
    return [{ ...item, evidence }]
  })
  return { ...delta, relations: filter(delta.relations, false), resource_artifact_relations: filter(delta.resource_artifact_relations, true),
    external_candidates: delta.external_candidates.map(item => ({ ...item, evidence: normalize(item.evidence) })) }
}

type Contribution = { featureId: string; runId: string; sourceSha256: string; delta: RelationDelta }

export function mergeModelRelations(seed: RelationSeed, contributions: readonly Contribution[]) {
  const ordered = [...contributions].sort((a, b) => a.featureId.localeCompare(b.featureId))
  const externalNodes = new Map(seed.external_candidates.map(item => [item.id, item]))
  const dedupe = (items: z.infer<typeof edge>[]) => {
    const edges = new Map<string, z.infer<typeof edge>>()
    for (const item of items) {
      const key = JSON.stringify([item.source, item.target, item.relation_type, item.subtype, item.is_inferred])
      const previous = edges.get(key)
      edges.set(key, previous ? { ...previous, evidence: unique([...previous.evidence, ...item.evidence]) } : item)
    }
    return [...edges.values()]
  }
  for (const candidate of ordered.flatMap(item => item.delta.external_candidates)) {
    const old = externalNodes.get(candidate.id)
    if (old && (old.kind !== candidate.kind || old.name !== candidate.name || old.system_name !== candidate.system_name)) {
      throw new Error(`Conflicting external relation identity: ${candidate.id}`)
    }
    externalNodes.set(candidate.id, old ? { ...old, aliases: unique([...(old.aliases ?? []), ...(candidate.aliases ?? [])]),
      evidence: unique([...old.evidence, ...candidate.evidence]) } : candidate)
  }
  const unresolved: unknown[] = []
  const requirementNames = new Set(seed.requirements.map(item => item.name))
  const retain = (item: z.infer<typeof edge>) => {
    const target = externalNodes.get(item.target)
    if (item.relation_type === 'resource_artifact' ? target && target.kind !== 'external_requirement'
      : requirementNames.has(item.target) || target?.kind === 'external_requirement') return true
    unresolved.push({ issue: 'Endpoint no longer part of the combined relation snapshot', source: item.source, target: item.target, evidence: item.evidence })
    return false
  }
  const edges = dedupe(ordered.flatMap(item => item.delta.relations)).filter(retain)
  const resources = dedupe(ordered.flatMap(item => item.delta.resource_artifact_relations)).filter(retain)
  return {
    ...seed,
    relations: [...seed.relations, ...edges],
    resource_artifact_relations: [...seed.resource_artifact_relations, ...resources],
    external_candidates: [...externalNodes.values()],
    external_references: unique([...seed.external_references, ...ordered.flatMap(item => item.delta.external_references)]),
    consistency_issues: unique([...seed.consistency_issues, ...ordered.flatMap(item => item.delta.consistency_issues), ...unresolved]),
    contributions: ordered.map(({ featureId, runId, sourceSha256, delta }) => ({
      featureId, runId, sourceSha256, source: delta.source_function,
    })),
  }
}

export function featureRelationsHash(relations: RelationSeed, name: string): string {
  const incident = [...relations.relations, ...relations.resource_artifact_relations]
    .filter((item): item is { source: unknown; target: unknown } => !!item && typeof item === 'object' &&
      'source' in item && 'target' in item && (item.source === name || item.target === name))
  const endpoints = new Set(incident.flatMap(item => [item.source, item.target]))
  return sha256(JSON.stringify([incident, relations.external_candidates.filter(item => endpoints.has(item.id))]))
}

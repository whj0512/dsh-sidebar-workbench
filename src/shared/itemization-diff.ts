/** Functional comparison uses original requirement IDs and explicit matches; chunk numbering is local to a candidate. */
import type { Branded } from '@deepseek-ai/dsh-brand'
export type FeatureId = Branded<'WorkbenchFeatureId'>
export interface ComparedFunction {
  readonly id: FeatureId
  readonly requirementId: string | null
  readonly name: string
  readonly contentSha256: string
}
export interface ComparedRelation {
  readonly source: FeatureId
  readonly target: FeatureId
  readonly evidenceSha256: string
}
export interface FunctionMatch {
  readonly previous: FeatureId
  readonly candidate: FeatureId
}
export interface ItemizationDiff {
  readonly matches: readonly FunctionMatch[]
  readonly added: readonly FeatureId[]
  readonly deleted: readonly FeatureId[]
  readonly renamed: readonly FunctionMatch[]
  readonly changed: readonly FunctionMatch[]
  readonly unmatched: readonly { readonly previous: readonly FeatureId[]; readonly candidate: readonly FeatureId[] }[]
  readonly relationsChanged: boolean
  readonly affected: readonly FeatureId[]
}

/** @param previous - Adopted function references. @param candidate - Candidate function references. @param explicit - User-confirmed one-to-one matches. @param oldRelations - Adopted relation references. @param newRelations - Candidate relation references. @returns Parallel change categories; ambiguous matches remain unresolved. */
export function compareItemizations(previous: readonly ComparedFunction[], candidate: readonly ComparedFunction[],
  explicit: readonly FunctionMatch[], oldRelations: readonly ComparedRelation[] = [], newRelations: readonly ComparedRelation[] = []): ItemizationDiff {
  const matches: FunctionMatch[] = []
  const oldUsed = new Set<FeatureId>(), newUsed = new Set<FeatureId>()
  const byOld = new Map(previous.map(item => [item.id, item])), byNew = new Map(candidate.map(item => [item.id, item]))
  if (byOld.size !== previous.length || byNew.size !== candidate.length) throw new Error('Duplicate function identity')
  const add = (match: FunctionMatch) => {
    if (!byOld.has(match.previous) || !byNew.has(match.candidate) || oldUsed.has(match.previous) || newUsed.has(match.candidate)) throw new Error('Invalid or repeated function match')
    matches.push(match); oldUsed.add(match.previous); newUsed.add(match.candidate)
  }
  for (const match of explicit) add(match)
  const uniqueMatch = (key: (item: ComparedFunction) => string | null) => {
    for (const old of previous) {
      if (oldUsed.has(old.id)) continue
      const value = key(old)
      if (value === null || !value) continue
      // Count against the whole index: a duplicate ID never becomes unique
      // merely because another duplicate was consumed by an earlier match.
      if (previous.filter(item => key(item) === value).length !== 1 || candidate.filter(item => key(item) === value).length !== 1) continue
      const next = candidate.find(item => key(item) === value)
      if (next && !newUsed.has(next.id)) {
        if (old.requirementId && next.requirementId && old.requirementId !== next.requirementId) continue
        add({ previous: old.id, candidate: next.id })
      }
    }
  }
  uniqueMatch(item => item.requirementId)
  uniqueMatch(item => item.name)
  const renamed: FunctionMatch[] = [], changed: FunctionMatch[] = []
  const affected = new Set<FeatureId>()
  for (const match of matches) {
    const old = byOld.get(match.previous)!, next = byNew.get(match.candidate)!
    if (old.name !== next.name) { renamed.push(match); affected.add(next.id) }
    if (old.contentSha256 !== next.contentSha256) { changed.push(match); affected.add(next.id) }
  }
  const deleted = previous.filter(item => !oldUsed.has(item.id)).map(item => item.id)
  const added = candidate.filter(item => !newUsed.has(item.id)).map(item => item.id)
  const unmatched = deleted.length && added.length ? [{ previous: deleted, candidate: added }] : []
  const remap = new Map(matches.map(match => [match.previous, match.candidate]))
  const signature = (relation: ComparedRelation, old: boolean) => JSON.stringify([
    old ? remap.get(relation.source) ?? `deleted:${relation.source}` : relation.source,
    old ? remap.get(relation.target) ?? `deleted:${relation.target}` : relation.target, relation.evidenceSha256,
  ])
  const before = new Set(oldRelations.map(item => signature(item, true)))
  const after = new Set(newRelations.map(item => signature(item, false)))
  const relationsChanged = before.size !== after.size || [...before].some(value => !after.has(value))
  for (const relation of oldRelations) if (!after.has(signature(relation, true))) {
    affected.add(remap.get(relation.source) ?? relation.source); affected.add(remap.get(relation.target) ?? relation.target)
  }
  for (const relation of newRelations) if (!before.has(signature(relation, false))) { affected.add(relation.source); affected.add(relation.target) }
  for (const id of [...added, ...deleted]) affected.add(id)
  return { matches, added, deleted, renamed, changed, unmatched, relationsChanged, affected: [...affected].sort() }
}

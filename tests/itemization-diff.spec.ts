/** Version comparisons do not use mutable chunk sequence numbers or fuzzy names. */
import { expect, it } from 'vitest'
import { compareItemizations, type ComparedFunction, type FeatureId } from '../src/shared/itemization-diff.ts'
const feature = (id: string) => id as FeatureId
const fn = (id: string, name: string, requirementId: string | null = null, contentSha256 = 'same'): ComparedFunction => ({ id: feature(id), name, requirementId, contentSha256 })

it('reports rename and content changes together despite renumbered chunks', () => {
  const diff = compareItemizations([fn('old', 'Drive', 'REQ-1')], [fn('new', 'Drive mode', 'REQ-1', 'changed')], [])
  expect(diff.renamed).toEqual([{ previous: 'old', candidate: 'new' }]); expect(diff.changed).toEqual(diff.renamed)
  expect(diff.added).toEqual([]); expect(diff.affected).toEqual(['new'])
})
it('keeps unmatched rename candidates for review and accepts explicit resolution', () => {
  const old = [fn('a', 'Drive')], next = [fn('b', 'Driving')]
  expect(compareItemizations(old, next, []).unmatched).toHaveLength(1)
  expect(compareItemizations(old, next, [{ previous: feature('a'), candidate: feature('b') }]).unmatched).toEqual([])
})
it('rejects repeated manual matches and leaves duplicated source IDs unresolved', () => {
  const old = [fn('a', 'First', 'REQ'), fn('b', 'Second', 'REQ')], next = [fn('c', 'Other', 'REQ')]
  expect(compareItemizations(old, next, []).matches).toEqual([])
  expect(() => compareItemizations(old, next, [{ previous: feature('a'), candidate: feature('c') }, { previous: feature('b'), candidate: feature('c') }])).toThrow('match')
})
it('does not automatically match different original requirement IDs solely by identical names', () => {
  expect(compareItemizations([fn('a', 'Drive', 'REQ-1')], [fn('b', 'Drive', 'REQ-2')], []).matches).toEqual([])
})
it('compares relation endpoints through matches and reports evidence changes', () => {
  const old = [fn('a', 'Drive'), fn('b', 'Brake')], next = [fn('c', 'Drive'), fn('d', 'Brake')]
  const before = [{ source: feature('a'), target: feature('b'), evidenceSha256: 'evidence' }]
  const after = [{ source: feature('c'), target: feature('d'), evidenceSha256: 'evidence' }]
  expect(compareItemizations(old, next, [], before, after).relationsChanged).toBe(false)
  expect(compareItemizations(old, next, [], before, [{ ...after[0]!, evidenceSha256: 'changed' }]).affected).toEqual(['c', 'd'])
})

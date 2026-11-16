import { expect, it } from 'vitest'
import { entityRegistryValidationView, makeMapping, validateIfThen, type ModelSource, type Requirements } from '../src/host/modeling-validation.ts'

const requirements: Requirements = {
  schema_version: '1.0', run_id: 'run', feature_id: 'feature', source: { path: 'Source.md', sha256: 'verified' },
  requirements: [{ requirement_id: 'REQ-1', source_location: { section: '2', start_line: 4, end_line: 4 },
    source_text: 'On request, stop and show a warning.', requirement_type: 'behavior', responsibility_scope: 'current_system',
    expected_results: ['Stops', 'Shows warning'], testability: 'testable', reason: '' }],
}
const model: ModelSource = {
  kind: 'Statechart', path: 'Statecharts/Drive.dsl', text: [
    'Statechart Drive {',
    '  // requirement_ids: REQ-1',
    '  Transition Stop { from: Active to: Stopped };',
    '  Transition Restart { from: Stopped to: Active };',
    '}',
  ].join('\n'),
}
const row = { requirement_id: 'REQ-1', result: 'Stops', file: model.path, element: 'Stop', code: 'to: Stopped' }

it('retains uncovered results and refuses code taken from a different element', () => {
  const map = makeMapping(requirements, [model], { Statechart: [row] })
  expect(map.coverage[0]).toMatchObject({ status: 'partial', assertions: ['Stops'], uncovered_assertions: ['Shows warning'] })
  expect(() => makeMapping(requirements, [model], { Statechart: [{ ...row, code: 'to: Active' }] })).toThrow('Unverified DSL location')
})

it('validates the inline requirement annotation emitted by the context skill', () => {
  expect(() => validateIfThen('IF Request THEN Stop // [derivation: null] // [requirement_id: REQ-1]', requirements)).not.toThrow()
  expect(() => validateIfThen([
    '> 归属约定：每条 IF/THEN 行尾以 `// [requirement_id: <ID>]` 标记归属。',
    'IF Request THEN Stop // [derivation: null] [requirement_id: REQ-1] [trace_id: TR-1]',
  ].join('\n'), requirements)).not.toThrow()
  expect(() => validateIfThen('IF Request THEN Stop // [derivation: null] [requirement_id: UNKNOWN]', requirements)).toThrow('line 1: UNKNOWN')
  expect(() => validateIfThen('> IF Request THEN Stop // [requirement_id: REQ-1]', requirements)).toThrow('needs IF')
  expect(() => validateIfThen('IF Request THEN Stop // [derivation: null]', requirements)).toThrow('needs IF')
})

it('adapts documented entity registry fields for the legacy validator while preserving the model input', () => {
  const unrestricted = { entity_value: null, entity_value_description: null }
  const mismatched = { entity_value: ['0x1'], entity_value_description: null }
  const physical = { name: 'CAN bus', type: 'CAN', connected_devices: ['ECU'], signals_carried: ['Speed'], description: 'Vehicle bus' }
  const invalid = { ...physical, connected_devices: 'ECU' }
  const ui = { name: 'Home', type: 'page', parent_device: 'Screen', elements: [], transitions: [] }
  const registry = {
    functions: [{ entities: { signals: { Speed: { usages: [unrestricted, mismatched] } }, interfaces: [physical, invalid, ui] } }],
    cross_references: { signal_to_device: {}, page_transitions: [], state_transitions: [] },
  }
  expect(entityRegistryValidationView(registry)).toMatchObject({
    functions: [{ entities: {
      signals: { Speed: { usages: [{ entity_value: [], entity_value_description: [] }, mismatched] } }, interfaces: [invalid, ui],
    } }],
    cross_references: { interface_transitions: [] },
  })
  expect(registry.functions[0]!.entities.interfaces).toEqual([physical, invalid, ui])
  expect(unrestricted).toEqual({ entity_value: null, entity_value_description: null })
  expect(registry.cross_references).not.toHaveProperty('interface_transitions')
})

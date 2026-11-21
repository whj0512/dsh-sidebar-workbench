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

it('links annotated models and environment declarations independently of behavioral coverage', () => {
  const external = { ...requirements.requirements[0]!, requirement_id: 'REQ-10', testability: 'external_dependency' as const,
    expected_results: [], reason: 'The MCU provides the signal.' }
  const data = { ...external, requirement_id: 'REQ-2', testability: 'non_testable' as const }
  const input = { ...requirements, requirements: [...requirements.requirements, external, data] }
  const scenario: ModelSource = { kind: 'ExternalScenario', path: 'ExternalScenarios/停车.dsl',
    text: '// requirement_ids: REQ-1, REQ-unknown\n// source\n// scope\nScenario 停车 { Interaction Brake; }' }
  const env: ModelSource = { kind: 'Environment', path: 'Environment.dsl', text: [
    'Environment {', '  // [requirement_id: REQ-10]', '  // source', '  // scope', '  Device MCU;',
    '  Device Other; // unrelated [REQ-1]', '  Device Another;', '  Connect from MCU to Other {',
    '    // [REQ-2]', '    Interaction Brake { Signal B };', '  };', '}',
  ].join('\n') }
  const dialog: ModelSource = { kind: 'DialogMap', path: 'DialogMaps/提示.dsl',
    text: 'DialogMap 提示 {\n// [requirement_id: REQ-1]\nPage P { description: "// requirement_ids: REQ-2" }\n}' }
  const map = makeMapping(input, [scenario, model, env, dialog], { Environment: [], ExternalScenario: [] })
  expect(map.coverage).toMatchObject([
    { status: 'missing', artifacts: ['DialogMaps/提示.dsl#提示', 'ExternalScenarios/停车.dsl#停车', 'Statecharts/Drive.dsl#Drive'],
      assertions: [], uncovered_assertions: ['Stops', 'Shows warning'] },
    { status: 'external_dependency', artifacts: ['Environment.dsl#MCU'], assertions: [] },
    { status: 'non_testable', artifacts: ['Environment.dsl#Brake'], assertions: [] },
  ])
})

it('retains uncovered results and refuses code taken from a different element', () => {
  const map = makeMapping(requirements, [model], { Statechart: [row] })
  expect(map.coverage[0]).toMatchObject({ status: 'partial', assertions: ['Stops'], uncovered_assertions: ['Shows warning'] })
  expect(() => makeMapping(requirements, [model], { Statechart: [{ ...row, code: 'to: Active' }] })).toThrow('Unverified DSL location')
})

it('collects each bad evidence row once and retains only verified assertions in advisory mode', () => {
  const issues: unknown[] = []
  const map = makeMapping(requirements, [model], { Statechart: [
    { ...row, code: 'to: Active' }, row, { requirement_id: 'REQ-1' },
  ], DialogMap: {} }, (kind, error) => issues.push({ kind, error }))
  expect(issues).toHaveLength(3)
  expect(map.coverage[0]).toMatchObject({ status: 'partial', assertions: ['Stops'], uncovered_assertions: ['Shows warning'] })
  expect(() => makeMapping(requirements, [model], { DialogMap: {} })).toThrow('Invalid DialogMap evidence array')
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

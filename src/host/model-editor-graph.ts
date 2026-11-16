import { editorGraph, type EditorDraft, type EditorGraph } from '../shared/model-editor.ts'
import type { ModelKind } from '../shared/modeling-api.ts'

type Row = Record<string, unknown>
type Cell = EditorGraph['nodes'][number] | EditorGraph['edges'][number]
type Field = Cell['fields'][number]
const row = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid BAIC graph object')
  return value as Row
}
const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new Error('Invalid BAIC graph array')
  return value.map(row)
}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const pos = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 50_000 ? value : fallback

/** Expose only fields with a DSL representation. BAIC owns its internal IDs and payload. */
export function projectGraph(kind: ModelKind, payload: unknown) {
  const wire = row(payload)
  const graph: EditorGraph = { nodes: [], edges: [] }
  const writers = new Map<string, (value: string) => void>()
  const fields = (id: string, raw: Row, keys: Record<string, string>): Field[] =>
    Object.entries(keys).map(([key, property]) => {
      writers.set(`${id}/${key}`, value => { raw[property] = value })
      return { key, value: str(raw[property]) }
    })
  const node = (id: string, raw: Row, name: string, type: string, keys: Record<string, string>) => {
    const layout = raw.render_config ? row(raw.render_config) : raw
    const i = graph.nodes.length
    graph.nodes.push({ id, label: name, element: name, type, fields: fields(id, raw, keys),
      x: pos(layout.x, 20 + (i % 3) * 175), y: pos(layout.y, 35 + Math.floor(i / 3) * 100) })
  }
  const edge = (id: string, raw: Row, name: string, source: string | undefined, target: string | undefined,
    keys: Record<string, string>, type = 'transition') => {
    if (!source || !target) throw new Error(`Invalid BAIC endpoints for ${name}`)
    graph.edges.push({ id, label: name, element: name, type, source, target, fields: fields(id, raw, keys) })
  }
  const endpoints = (raw: Row, id: string, source: string, target: string, ids: Map<string, string>) => {
    const item = graph.edges.find(cell => cell.id === id)!
    const options = [...ids].map(([value, cellId]) => ({ value: cellId, label: graph.nodes.find(cell => cell.id === cellId)!.label }))
    for (const [key, prop] of [['source', source], ['target', target]] as const) {
      item.fields.push({ key, value: ids.get(str(raw[prop]))!, options })
      writers.set(`${id}/${key}`, value => {
        const wireId = [...ids].find(([, candidate]) => candidate === value)?.[0]
        if (!wireId) throw new Error(`Unknown endpoint: ${value}`)
        raw[prop] = wireId
      })
    }
  }
  if (kind === 'Environment' || kind === 'ExternalScenario') {
    const environment = kind === 'Environment'
    const components = rows(wire.components)
    const ids = new Map<string, string>()
    components.forEach((raw, i) => {
      const id = `component/${i}`
      ids.set(str(environment ? raw.id : raw.name), id)
      node(id, raw, str(raw.name), str(raw.type), environment ? { name: 'name' } : {})
    })
    if (environment) {
      rows(wire.connects).forEach((connection, i) => {
        const interactionIds = new Map(ids)
        // BAIC interactions may use either a component or one of its ports.
        for (const component of components) {
          for (const port of rows(component.ports ?? [])) interactionIds.set(str(port.id), ids.get(str(component.id))!)
        }
        rows(connection.interactions).forEach((raw, j) => {
          const id = `connection/${i}/${j}`
          edge(id, raw, str(raw.name), interactionIds.get(str(raw.sender)), interactionIds.get(str(raw.receiver)),
            { name: 'name', message: 'message' }, str(raw.type))
        })
      })
    } else {
      const visit = (children: unknown, prefix: string) => rows(children).forEach((raw, index) => {
        const id = `${prefix}/${index}`
        if (raw.type === 'atomic') {
          const item = row(raw.data)
          edge(id, item, str(item.name), ids.get(str(item.sender)), ids.get(str(item.receiver)), { name: 'name' }, 'interaction')
        } else {
          const scopes = Array.isArray(raw.scope) ? rows(raw.scope) : raw.scope && typeof raw.scope === 'object' ? [row(raw.scope)] : []
          scopes.forEach((scope, i) => {
            const scopeId = `${id}/scope/${i}`
            node(scopeId, scope, str(scope.condition) || str(raw.type), str(raw.type), typeof scope.condition === 'string' ? { condition: 'condition' } : {})
            if (scope.children) visit(scope.children, scopeId)
          })
          if (raw.children) visit(raw.children, id)
        }
      })
      visit(wire.children, 'scenario')
    }
  } else {
    const dialog = kind === 'DialogMap'
    const ids = new Map<string, string>()
    const name = dialog ? 'name' : 'desc'
    rows(wire.nodes).forEach((raw, i) => {
      const id = `node/${i}`
      ids.set(str(raw.id), id)
      node(id, raw, str(raw[name]), str(raw.type_name), { name,
        ...(typeof raw.condition === 'string' ? { condition: 'condition' } : {}) })
      if (dialog) rows(raw.widgets ?? []).forEach((widget, j) => {
        const widgetId = `${id}/widget/${j}`
        node(widgetId, widget, str(widget.name), 'widget', { name: 'name', action: 'action' })
        graph.nodes.at(-1)!.element = str(widget.widget_id)
        graph.edges.push({ id: `${widgetId}/page`, label: '', element: '', type: 'contains', source: id, target: widgetId, fields: [] })
      })
    })
    rows(wire.transitions).forEach((raw, i) => {
      const id = `transition/${i}`
      edge(id, raw, str(raw[name]), ids.get(str(raw.source_node)), ids.get(str(raw.target_node)),
        { name, condition: 'condition', ...(dialog ? { trigger: 'trigger' } : {}) })
      endpoints(raw, id, 'source_node', 'target_node', ids)
    })
  }
  return {
    graph: editorGraph.parse(graph),
    apply(changes: EditorDraft['changes']) {
      for (const change of changes) {
        const write = writers.get(`${change.cell}/${change.field}`)
        if (!write) throw new Error(`Unsupported graph field: ${change.cell}/${change.field}`)
        write(change.value)
      }
    },
  }
}

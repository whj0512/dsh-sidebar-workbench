import { Graph } from '@antv/x6'
import type { Cell, Node } from '@antv/x6'
import type {
  EditorLayout,
  EditorRender,
} from '../../../../shared/model-editor.ts'
import importEnvironment from './environment.ts'
import importScenario from './interaction.ts'
import importStatechart from './internalConstraints.ts'
import { importDialogMapGraph } from './dialogMap.ts'
import { registerFlowShapes } from './shapes.ts'
import { syncInitialEdgeLabels } from './edgeLabels.ts'

let registered = false

export function importFlow(render: EditorRender) {
  let result: unknown
  switch (render.kind) {
    case 'Environment':
      result = importEnvironment(render.data)
      break
    case 'ExternalScenario':
      result = importScenario(render.data)
      break
    case 'Statechart':
      result = importStatechart(render.data, { autoLayout: true })
      break
    case 'DialogMap':
      result = importDialogMapGraph(render.data)
      break
  }
  return result as {
    cells: NonNullable<ReturnType<Graph['toJSON']>['cells']>
    canvasData?: Record<string, unknown>
  }
}

function isLifeline(node: Node) {
  return node.shape === 'seq-actor-node' || node.shape === 'seq-object-node'
}

function attachMessages(graph: Graph, node: Node) {
  if (!isLifeline(node)) return
  for (const edge of graph.getEdges()) {
    const { sourceId, targetId } = edge.getData() ?? {}
    const loop = sourceId === node.id && targetId === node.id
    const x = node.getPosition().x + node.getSize().width / (loop ? 1 : 2)
    if (sourceId === node.id) {
      const source = edge.getSource()
      if ('x' in source) edge.setSource({ ...source, x })
    }
    if (targetId === node.id) {
      const target = edge.getTarget()
      if ('x' in target) edge.setTarget({ ...target, x })
    }
    if (loop) {
      const vertices = edge.getVertices()
      const delta = vertices.length ? x + 40 - vertices[0]!.x : 0
      edge.setVertices(
        vertices.map((point) => ({ x: point.x + delta, y: point.y })),
      )
    }
  }
}

export function renderFlow(
  element: HTMLDivElement,
  render: EditorRender,
  editable: () => boolean,
) {
  if (!registered) {
    registerFlowShapes()
    registered = true
  }
  const data = importFlow(render)
  const graph = new Graph({
    container: element,
    width: element.clientWidth,
    height: element.clientHeight,
    background: { color: '#f8f9fa' },
    grid: { size: 10, visible: true },
    panning: true,
    mousewheel: {
      enabled: true,
      modifiers: ['ctrl', 'meta'],
      minScale: 0.05,
      maxScale: 2.5,
    },
    interacting: {
      nodeMovable: editable,
      magnetConnectable: false,
      edgeMovable: false,
      arrowheadMovable: false,
      edgeLabelMovable: false,
      vertexMovable: false,
      vertexAddable: false,
      vertexDeletable: false,
    },
  })
  try {
    graph.fromJSON(data)
    syncInitialEdgeLabels(graph)
    graph.on('node:change:position', ({ node, previous }) => {
      if (isLifeline(node) && previous && previous.y !== node.getPosition().y) {
        node.setPosition(node.getPosition().x, previous.y, { silent: true })
      }
      attachMessages(graph, node)
    })
    return { graph, canvasData: data.canvasData }
  } catch (error) {
    graph.dispose()
    throw error
  }
}

export function layoutKey(node: Node) {
  const data = node.getData() ?? {}
  return JSON.stringify([
    node.shape,
    data.nodeName || data.objectName || data.actorName || node.id,
  ])
}

export function applyFlowLayout(
  graph: Graph,
  layout: EditorLayout,
  legacy: ReadonlyMap<string, string>,
) {
  const nodes = graph.getNodes()
  const keys = nodes.map(layoutKey)
  nodes.forEach((node, index) => {
    const key = keys[index]!
    const old = legacy.get(node.id)
    const position =
      (keys.indexOf(key) === keys.lastIndexOf(key) ? layout[key] : undefined) ??
      (old ? layout[old] : undefined)
    if (position) node.position(position.x, position.y)
  })
}

export function flowElementNames(cell: Cell): string[] {
  const data = cell.getData() ?? {}
  const strings: unknown[] = [
    data.nodeName,
    data.objectName,
    data.actorName,
    data.edgeName,
    data.name,
  ]
  if (Array.isArray(data.widgets))
    strings.push(
      ...data.widgets.map((widget: { widget_id?: string }) => widget.widget_id),
    )
  if (Array.isArray(data.connect?.interactions)) {
    strings.push(
      ...data.connect.interactions.map(
        (interaction: { name?: string }) => interaction.name,
      ),
    )
  }
  return [
    ...new Set(
      strings.filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      ),
    ),
  ]
}

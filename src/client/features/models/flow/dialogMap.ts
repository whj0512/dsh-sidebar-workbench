import type { ModelImportOptions } from './geometry.ts'

type DialogMapDisplayVariant = {
  variant_id: string
  display_text: string
  condition: string
}

type DialogMapWidget = {
  id?: string
  widget_id: string
  type: string
  name: string
  action: string
  action_type: string
  target: string | null
  condition: string
  display_variants: DialogMapDisplayVariant[]
}

type DialogMapNode = {
  id: string
  type?: string
  type_name?: string
  name: string
  desc?: string
  x?: number
  y?: number
  widgets?: DialogMapWidget[]
}

type DialogMapTransition = {
  id: string
  name?: string
  source_node?: unknown
  target_node?: unknown
  source?: unknown
  target?: unknown
  from?: unknown
  to?: unknown
  trigger?: string
  trigger_type?: string
  condition?: string
  data_carried?: string[]
}

type DialogMapGraph = {
  id?: string
  name?: string
  desc?: string
  graph_type?: string
  entry_node?: string
  nodes?: DialogMapNode[]
  entry?: DialogMapNode
  pages?: DialogMapNode[]
  transitions?: DialogMapTransition[]
}

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback

const normalizeDisplayVariants = (value: unknown): DialogMapDisplayVariant[] =>
  Array.isArray(value)
    ? value.filter(isRecord).map((variant) => ({
        variant_id: asString(variant.variant_id ?? variant.variantId),
        display_text: asString(variant.display_text ?? variant.displayText),
        condition: asString(variant.condition),
      }))
    : []

const normalizeWidgets = (value: unknown): DialogMapWidget[] =>
  Array.isArray(value)
    ? value.filter(isRecord).map((widget) => {
        const widgetId = asString(
          widget.widget_id ?? widget.widgetId ?? widget.id,
        )
        return {
          id: asString(widget.id, widgetId),
          widget_id: widgetId,
          type: asString(widget.type),
          name: asString(widget.name),
          action: asString(widget.action),
          action_type: asString(widget.action_type ?? widget.actionType),
          target: widget.target === null ? null : asString(widget.target),
          condition: asString(widget.condition),
          display_variants: normalizeDisplayVariants(
            widget.display_variants ?? widget.variants,
          ),
        }
      })
    : []

const resolveNodeReference = (
  value: unknown,
  nodesById: Map<string, DialogMapNode>,
  nodeIdsByName: Map<string, string>,
) => {
  if (isRecord(value)) {
    return resolveNodeReference(
      value.id ?? value.name,
      nodesById,
      nodeIdsByName,
    )
  }
  const reference = asString(value)
  if (nodesById.has(reference)) return reference
  return nodeIdsByName.get(reference) ?? reference
}

const getApiNodes = (graph: DialogMapGraph) => {
  if (Array.isArray(graph.nodes)) return graph.nodes
  const entry = graph.entry
    ? {
        ...graph.entry,
        type: graph.entry.type || graph.entry.type_name || 'entry',
      }
    : undefined
  const pages: DialogMapNode[] = Array.isArray(graph.pages)
    ? graph.pages.map((page) => ({
        ...page,
        type: page.type || page.type_name || 'page',
      }))
    : []
  return [entry, ...pages].filter(
    (node): node is DialogMapNode => node !== undefined,
  )
}

const getNodeKind = (node: DialogMapNode) =>
  asString(node.type_name || node.type).toLowerCase()

const portAttrs = { circle: { r: 4, magnet: true, stroke: '#2563eb', fill: '#fff', strokeWidth: 1 } }
const portGroups = {
  in: { position: 'top', attrs: portAttrs },
  out: { position: 'bottom', attrs: portAttrs },
}

const createNodeCell = (node: DialogMapNode) => {
  const kind = getNodeKind(node)
  const isEntry = kind === 'entry' || kind === 'start'
  if (!isEntry && kind !== 'page') {
    throw new Error(`DialogMap 包含不支持的节点类型：${kind || 'unknown'}`)
  }

  return {
    id: node.id,
    shape: isEntry ? 'start-node' : 'page-node',
    x: typeof node.x === 'number' ? node.x : 80,
    y: typeof node.y === 'number' ? node.y : 80,
    width: isEntry ? 30 : 120,
    height: isEntry ? 30 : 80,
    ports: { groups: portGroups, items: [] as { id: string; group: 'in' | 'out' }[] },
    data: isEntry
      ? {
          nodeName: node.name || 'Start',
          stroke: '#333',
          fill: '#686666',
        }
      : {
          nodeName: node.name,
          comment: asString(node.desc),
          stroke: '#333',
          fill: '#f3f4f6',
          widgets: normalizeWidgets(node.widgets),
        },
  }
}

export const importDialogMapGraph = (
  source: string | object,
  options: ModelImportOptions = {},
): object => {
  const parsed = typeof source === 'string' ? JSON.parse(source) : source
  if (!isRecord(parsed)) throw new Error('DialogMap 图数据必须是 JSON 对象')

  const graph = parsed as DialogMapGraph
  const apiNodes = getApiNodes(graph)
  const entryNodes = apiNodes.filter((node) =>
    ['entry', 'start'].includes(getNodeKind(node)),
  )
  if (entryNodes.length !== 1) {
    throw new Error(
      `DialogMap 必须且只能包含一个 Entry，当前为 ${entryNodes.length} 个`,
    )
  }

  const nodesById = new Map(apiNodes.map((node) => [node.id, node]))
  const nodeIdsByName = new Map(apiNodes.map((node) => [node.name, node.id]))
  const nodeCells = apiNodes.map(createNodeCell)
  const cellsById = new Map(nodeCells.map(cell => [cell.id, cell]))
  const port = (cell: string, group: 'in' | 'out') => {
    const { items } = cellsById.get(cell)!.ports
    const id = `${group}-${items.filter(item => item.group === group).length}`
    items.push({ id, group })
    return { cell, port: id }
  }
  const edgeCells = (
    Array.isArray(graph.transitions) ? graph.transitions : []
  ).map((transition, index) => {
    const source = resolveNodeReference(
      transition.source_node ?? transition.source ?? transition.from,
      nodesById,
      nodeIdsByName,
    )
    const target = resolveNodeReference(
      transition.target_node ?? transition.target ?? transition.to,
      nodesById,
      nodeIdsByName,
    )
    if (!nodesById.has(source) || !nodesById.has(target)) {
      throw new Error(
        `Transition ${transition.name || index + 1} 引用了不存在的节点`,
      )
    }

    return {
      id: transition.id || `transition-${index + 1}`,
      shape: 'edge',
      source: port(source, 'out'),
      target: port(target, 'in'),
      attrs: {
        line: {
          stroke: '#1890ff',
          strokeWidth: 2,
          targetMarker: { name: 'block', width: 12, height: 8 },
        },
      },
      router: { name: 'manhattan' },
      connector: { name: 'rounded', args: { radius: 8 } },
      data: {
        edgeName: transition.name || `Transition_${index + 1}`,
        trigger: asString(transition.trigger),
        trigger_type: asString(transition.trigger_type, 'click'),
        condition: asString(transition.condition),
        data_carried: Array.isArray(transition.data_carried)
          ? transition.data_carried.filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
      },
    }
  })

  return {
    cells: [...nodeCells, ...edgeCells],
    canvasData: {
      id: asString(graph.id),
      name: asString(graph.name) || options.modelName || 'DialogMap',
      desc: asString(graph.desc),
    },
  }
}

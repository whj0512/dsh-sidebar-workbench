export type ModelImportOptions = { autoLayout?: boolean; modelName?: string }

export function environmentPortGroups() {
  const rect = {
    width: 10,
    height: 10,
    x: -5,
    y: -5,
    magnet: true,
    stroke: '#333',
    fill: '#fff',
    strokeWidth: 1,
    rx: 0,
    ry: 0,
  }
  const port = (position: string) => ({
    position,
    markup: [{ tagName: 'rect', selector: 'rect' }],
    attrs: { rect },
  })
  return { in: port('left'), out: port('right') }
}

export const internalConstraintsCanvasLayout = {
  originX: 100,
  originY: 100,
  nodesPerBand: 5,
  nodeGap: 100,
  layerGap: 120,
  bandGap: 180,
  componentGap: 180,
} as const

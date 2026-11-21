import React from 'react'
import NodeWrapper from '../NodeWrapper/NodeWrapper.tsx'

const Graph = (props: any) => (
  <NodeWrapper {...props} defaultContent="G" nodeType="graph" />
)

export default Graph

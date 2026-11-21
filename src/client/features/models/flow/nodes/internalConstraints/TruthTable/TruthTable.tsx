import React from 'react'
import NodeWrapper from '../NodeWrapper/NodeWrapper.tsx'

const TruthTable = (props: any) => (
  <NodeWrapper {...props} defaultContent="tf" nodeType="truthTable" />
)

export default TruthTable

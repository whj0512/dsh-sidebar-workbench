import { register } from '@antv/x6-react-shape'
import Device from './nodes/environment/Device/Device.tsx'
import Controller from './nodes/environment/Controller/Controller.tsx'
import Human from './nodes/environment/Human/Human.tsx'
import FunctionalModule from './nodes/environment/FunctionalModule/FunctionalModule.tsx'
import Machine from './nodes/environment/Machine/Machine.tsx'
import ControlUnit from './nodes/environment/ControlUnit/ControlUnit.tsx'
import ObjectNode from './nodes/interaction/BaseObject/BaseObject.tsx'
import ActorNode from './nodes/interaction/Actor/Actor.tsx'
import CombinedFragmentNode from './nodes/interaction/CombinedFragment/CombinedFragment.tsx'
import Call from './nodes/internalConstraints/Call/Call.tsx'
import Comment from './nodes/internalConstraints/Comment/Comment.tsx'
import Condition from './nodes/internalConstraints/Condition/Condition.tsx'
import Goto from './nodes/internalConstraints/Goto/Goto.tsx'
import Graph from './nodes/internalConstraints/Graph/Graph.tsx'
import Start from './nodes/internalConstraints/Start/Start.tsx'
import Then from './nodes/internalConstraints/Then/Then.tsx'
import State from './nodes/internalConstraints/State/State.tsx'
import TruthTable from './nodes/internalConstraints/TruthTable/TruthTable.tsx'
import Page from './nodes/dialogMap/Page/Page.tsx'

export function registerFlowShapes() {
  register({
    shape: 'device-node',
    component: Device,
    effect: ['data', 'size'],
  })
  register({
    shape: 'controller-node',
    component: Controller,
    effect: ['data', 'size'],
  })
  register({ shape: 'human-node', component: Human, effect: ['data', 'size'] })
  register({
    shape: 'functional-module-node',
    component: FunctionalModule,
    effect: ['data', 'size'],
  })
  register({
    shape: 'machine-node',
    component: Machine,
    effect: ['data', 'size'],
  })
  register({
    shape: 'control-unit-node',
    component: ControlUnit,
    effect: ['data', 'size'],
  })
  register({
    shape: 'seq-object-node',
    component: ObjectNode,
    effect: ['data', 'size'],
  })
  register({
    shape: 'seq-actor-node',
    component: ActorNode,
    effect: ['data', 'size'],
  })
  register({
    shape: 'seq-fragment-node',
    component: CombinedFragmentNode,
    effect: ['data', 'size'],
  })
  register({ shape: 'call-node', component: Call, effect: ['data', 'size'] })
  register({
    shape: 'comment-node',
    component: Comment,
    effect: ['data', 'size'],
  })
  register({
    shape: 'condition-node',
    component: Condition,
    effect: ['data', 'size'],
  })
  register({ shape: 'goto-node', component: Goto, effect: ['data', 'size'] })
  register({ shape: 'graph-node', component: Graph, effect: ['data', 'size'] })
  register({ shape: 'start-node', component: Start, effect: ['data', 'size'] })
  register({ shape: 'then-node', component: Then, effect: ['data', 'size'] })
  register({ shape: 'state-node', component: State, effect: ['data', 'size'] })
  register({
    shape: 'truth-node',
    component: TruthTable,
    effect: ['data', 'size'],
  })
  register({ shape: 'page-node', component: Page, effect: ['data', 'size'] })
}

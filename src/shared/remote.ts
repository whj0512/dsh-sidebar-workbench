/** Schema-defined Remote contribution shared by Host and Client; no transport or registration side effects. */
import type { InvocationDescriptor, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { commandSchema, resultSchema, type ProjectCommand, type ProjectResult } from './project.ts'
import { itemizationCommandSchema, itemizationResultSchema, type ItemizationCommand, type ItemizationResult } from './itemization-api.ts'

const descriptor: InvocationDescriptor = {
  id: 'dsh-plugin-sidebar-workbench#workbench/command', service: 'workbenchProjects', namespace: 'workbench', method: 'command',
  invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'WorkbenchCommandV1', create: () => commandSchema } }],
  result: { mode: 'strict', typeSymbol: 'WorkbenchResultV1', create: () => resultSchema },
}
const itemization: InvocationDescriptor = {
  id: 'dsh-plugin-sidebar-workbench#workbench/itemization', service: 'workbenchProjects', namespace: 'workbench', method: 'itemization',
  invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'WorkbenchItemizationCommandV1', create: () => itemizationCommandSchema } }],
  result: { mode: 'strict', typeSymbol: 'WorkbenchItemizationResultV1', create: () => itemizationResultSchema },
}
export const remoteContribution: TypertRemoteContribution = { package: 'dsh-plugin-sidebar-workbench', descriptors: [descriptor, itemization] }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    workbench: { command(request: ProjectCommand): Promise<RemoteResult<ProjectResult>>; itemization(request: ItemizationCommand): Promise<RemoteResult<ItemizationResult>> }
  }
}

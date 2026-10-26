/** Schema-defined Remote contribution shared by Host and Client; no transport or registration side effects. */
import type { InvocationDescriptor, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { commandSchema, resultSchema, type ProjectCommand, type ProjectResult } from './project.ts'

const descriptor: InvocationDescriptor = {
  id: 'dsh-plugin-sidebar-workbench#workbench/command', service: 'workbenchProjects', namespace: 'workbench', method: 'command',
  invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'WorkbenchCommandV1', create: () => commandSchema } }],
  result: { mode: 'strict', typeSymbol: 'WorkbenchResultV1', create: () => resultSchema },
}
export const remoteContribution: TypertRemoteContribution = { package: 'dsh-plugin-sidebar-workbench', descriptors: [descriptor] }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    workbench: { command(request: ProjectCommand): Promise<RemoteResult<ProjectResult>> }
  }
}

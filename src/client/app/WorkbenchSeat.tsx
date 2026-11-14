/** Session-scoped adapter for the plugin-lifetime view store. */
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchSeatRuntime } from './workbench-types.ts'

export const workbenchChildren = { 'sidebar.right.pane.tab.workbench': { kind: 'single', scope: 'root' } } as const
export type WorkbenchSeatProps = WorkbenchSeatRuntime & PropsRenderSlots<'sidebar.right.pane.tab.workbench'>

/** @param props - Native Session facts and authorized content renderer. @returns Workbench content under its root-scoped store. */
export function WorkbenchSeat({ sessionId, useTabInfo, useWorkbench, renderSlot, draftChanged, start, act, project, listFiles, itemization }: WorkbenchSeatProps) {
  const { tab } = useTabInfo()
  const data = useWorkbench(snapshot => snapshot)
  return renderSlot('sidebar.right.pane.tab.workbench', { sessionId, tab, data, draftChanged, start, act, project, listFiles, itemization })
}

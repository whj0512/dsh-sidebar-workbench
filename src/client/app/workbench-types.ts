/** Slot-derived workbench props shared by the plugin registration and its view. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchData } from '../state/data.ts'
import type { ViewStore } from '../state/view-store.ts'
import type { Operation, Scenario } from '../../shared/workflow.ts'
import type { ProjectCommand } from '../../shared/project.ts'
import type {} from '../i18n/locales.ts'
import type { DataSnapshot } from '../state/data.ts'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
/** Bound once per Session by the Slot registration. */
export interface WorkbenchInjected {
  listFiles?: (query: string) => Promise<NonNullable<import('../../shared/project.ts').ProjectResult['files']>>
  sessionId: string
  draftChanged: (key: string, dirty: boolean, signal: AbortSignal) => void
  hooks: { workbench: ReturnType<WorkbenchData['source']> }
  start: (operation: Operation, scope: readonly string[], scenario: Scenario) => void
  act: WorkbenchData['act']
  project: (action: ProjectCommand['action'], fields?: Pick<ProjectCommand, 'materials' | 'expectedProjectId' | 'expectedRevision'>) => void
}
/** Session-owned values passed to the root-scoped workbench content. */
export interface WorkbenchOwner extends Omit<WorkbenchInjected, 'hooks'> {
  tab: SidebarRightTabInfo['tab']
  data: DataSnapshot
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab.workbench': { kind: 'single'; scope: 'root'; owner: WorkbenchOwner }
  }
}
/** Runtime, locale and plugin-lifetime view store supplied by the content Slot. */
export type WorkbenchProps = PropsRuntime<'sidebar.right.pane.tab.workbench'> & PropsStore<ViewStore>
  & PropsLocale<'sidebarWorkbench'>
/** Session-bound hooks and commands supplied by the native sidebar Slot. */
export type WorkbenchSeatRuntime = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<WorkbenchInjected>

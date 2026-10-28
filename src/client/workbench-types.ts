/** Slot-derived workbench props shared by the plugin registration and its view. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchData } from './state/data.ts'
import type { ViewStore } from './state/view-store.ts'
import type { Operation, Scenario } from '../shared/workflow.ts'
import type { ProjectCommand } from '../shared/project.ts'
import type {} from './i18n/locales.ts'
/** Bound once per Session by the Slot registration. */
export interface WorkbenchInjected {
  draftChanged: (key: string, dirty: boolean) => void
  hooks: { workbench: ReturnType<WorkbenchData['source']> }
  start: (operation: Operation, scope: readonly string[], scenario: Scenario) => void
  act: WorkbenchData['act']
  project: (action: ProjectCommand['action'], fields?: Pick<ProjectCommand, 'materials' | 'expectedProjectId'>) => void
}
/** Runtime, locale, store and injected commands supplied by the sidebar Slot. */
export type WorkbenchProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsStore<ViewStore>
  & PropsLocale<'sidebarWorkbench'> & InjectFace<WorkbenchInjected>

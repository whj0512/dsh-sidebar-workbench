/** Native right-sidebar page metadata. */
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

export const WORKBENCH_ID = 'dsh-plugin-sidebar-workbench'
export const WORKBENCH_KIND = 'sidebar-workbench'

/**
 * Define the page and its single guide entry.
 * @param t - Live namespace-bound translation function.
 * @returns The page metadata consumed by the sidebar registry.
 */
export function workbenchDefinition(t: TranslateNS<'sidebarWorkbench'>): SidebarRightTabDefinition {
  return {
    id: WORKBENCH_ID,
    kind: WORKBENCH_KIND,
    priority: 'extension',
    title: () => t('title'),
    guide: [{ id: 'workbench', order: 50, title: () => t('title'), description: () => t('description'), icon: IconCodeOutlineRegular }],
  }
}

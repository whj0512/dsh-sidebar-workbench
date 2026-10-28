/** Tab and floating-pane title, sharing the guide's existing product icon. */
import type { ReactNode } from 'react'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render a title that follows locale changes while the tab remains open.
 * @param props - Framework-provided locale seat.
 * @returns The tab label and decorative icon.
 */
export function WorkbenchTitle({ t }: PropsLocale<'sidebarWorkbench'>): ReactNode {
  return <><IconCodeOutlineRegular size={16} />{t('title')}</>
}

/** Client entry: reversible locale, page, stylesheet and Slot registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WORKBENCH_ID, workbenchDefinition } from './shell/definition.ts'
import { en, zh } from './i18n/locales.ts'
import { Workbench } from './Workbench.tsx'
import { WorkbenchTitle } from './shell/WorkbenchTitle.tsx'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkbenchData } from './state/data.ts'
import { DraftGuard } from './state/draft-guard.ts'
import { createViewStore } from './state/view-store.ts'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { remoteContribution } from '../shared/remote.ts'
import stylesheet from './styles/Workbench.module.css?inline'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'workspaces', 'remote']

/**
 * Mount a workbench page for each session's right sidebar.
 * @param ctx - Client context providing locale, Slots and tab registration.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remoteContribution)
  ctx.inject(['remote.workbench'], install)
}

/** @param ctx - Child fiber with the mounted Remote namespace in its declared dependencies. */
function install(ctx: Context): void {
  const data = new WorkbenchData(ctx.workspaces, async request => {
    const result = await ctx.remote.workbench.command(request)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  })
  const store = createViewStore()
  const drafts = new DraftGuard(window)
  ctx.effect(() => () => drafts.dispose(), 'workbench: draft unload guard')
  ctx.effect(() => () => data.dispose(), 'workbench: domain lifetime')
  const namespace = 'sidebarWorkbench'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'workbench: dictionaries')
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = WORKBENCH_ID
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'workbench: stylesheet')
  ctx.effect(() => ctx.sidebarRightTabs.register(workbenchDefinition(t)), 'workbench: page')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: WORKBENCH_ID, locale: namespace, store,
      inject: (sessionId) => ({ draftChanged: (key, dirty) => drafts.update(`${sessionId}:${key}`, dirty), hooks: { workbench: data.source(sessionId) },
        start: (operation, scope, scenario) => { data.start(sessionId, operation, scope, scenario) },
        act: (id, action) => data.act(id, action),
        project: (action, fields) => { void data.project(sessionId, action, fields) },
      } satisfies import('./Workbench.tsx').WorkbenchInjected),
    }, Workbench,
  )), 'workbench: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: WORKBENCH_ID, locale: namespace }, WorkbenchTitle,
  )), 'workbench: title')
}

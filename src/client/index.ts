/** Client entry: reversible locale, page, stylesheet and Slot registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WORKBENCH_ID, workbenchDefinition } from './components/definition.ts'
import { en, zh } from './i18n/locales.ts'
import { Workbench } from './app/Workbench.tsx'
import { WorkbenchSeat, workbenchChildren } from './app/WorkbenchSeat.tsx'
import { WorkbenchTitle } from './components/WorkbenchTitle.tsx'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkbenchData } from './state/data.ts'
import { DraftGuard } from './state/draft-guard.ts'
import { createViewStore } from './state/view-store.ts'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { remoteContribution } from '../shared/remote.ts'
import { materialFiles } from './features/project/file-lookup.ts'
import stylesheet from './styles/Workbench.module.css?inline'
import itemizationStylesheet from './features/project/ItemizationPanel.module.css?inline'
import modelingStylesheet from './features/models/ModelingPanel.module.css?inline'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'workspaces', 'remote', 'uiWorkspace']

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
  const navigation = ctx.get('uiWorkspace') as { openSession(id: string): void } | undefined
  const data = new WorkbenchData(ctx.workspaces, async request => {
    const result = await ctx.remote.workbench.command(request)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  })
  const store = createViewStore()
  const drafts = new DraftGuard(window) // Create a draft guard to manage unsaved changes in the workbench
  ctx.effect(() => () => drafts.dispose(), 'workbench: draft unload guard')
  ctx.effect(() => () => data.dispose(), 'workbench: domain lifetime')
  const namespace = 'sidebarWorkbench'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'workbench: dictionaries') // Register locale dictionaries for the workbench namespace
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = WORKBENCH_ID
    style.textContent = `${stylesheet}\n${itemizationStylesheet}\n${modelingStylesheet}`
    document.head.append(style)
    return () => style.remove()
  }, 'workbench: stylesheet') // Register the stylesheet for the workbench
  ctx.effect(() => ctx.sidebarRightTabs.register(workbenchDefinition(t)), 'workbench: page') // Register the workbench page in the right sidebar
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: WORKBENCH_ID, children: workbenchChildren,
        inject: (sessionId) => ({ sessionId, draftChanged: (key, dirty, signal) => drafts.update(key, dirty, signal), hooks: { workbench: data.source(sessionId) },
          start: (operation, scope, scenario) => { data.start(sessionId, operation, scope, scenario) },
          act: (id, action) => data.act(id, action),
          itemization: async request => {
            const snapshot = data.source(sessionId).getSnapshot()
            if (snapshot.phase !== 'ready' || !snapshot.workspace) return { ok: false, problem: 'unbound' }
            const response = await ctx.remote.workbench.itemization({ ...request, sessionId, workspaceId: snapshot.workspace.workspaceId })
            if (!response.ok) throw new Error(response.error.code)
            if (request.action === 'adopt' && response.value.ok) void data.project(sessionId, 'inspect')
            return response.value
          },
          openModelSession: navigation ? id => navigation.openSession(id) : undefined,
          modeling: async request => {
            const snapshot = data.source(sessionId).getSnapshot()
            if (snapshot.phase !== 'ready' || !snapshot.workspace) return { ok: false, problem: 'unbound' }
            const response = await ctx.remote.workbench.modeling({ ...request, sessionId, workspaceId: snapshot.workspace.workspaceId })
            if (!response.ok) throw new Error(response.error.code)
            return response.value
          },
          listFiles: async query => {
            const snapshot = data.source(sessionId).getSnapshot()
            if (snapshot.phase !== 'ready' || !snapshot.workspace) throw new Error('unbound')
            const response = await ctx.remote.workbench.command({ action: 'files', sessionId, workspaceId: snapshot.workspace.workspaceId, query })
            return materialFiles(response)
          },
          project: (action, fields) => { void data.project(sessionId, action, fields) },
        } satisfies import('./app/Workbench.tsx').WorkbenchInjected),
      }, WorkbenchSeat,
    )
    yield ctx.slots.register({ name: 'sidebar.right.pane.tab.workbench', locale: namespace, store }, Workbench)
  }), 'workbench: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: WORKBENCH_ID, locale: namespace }, WorkbenchTitle,
  )), 'workbench: title')
}

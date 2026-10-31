/** Real Cordis and sidebar registry with recording Slot and locale providers. */
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { WORKBENCH_ID, WORKBENCH_KIND } from '../src/client/components/definition.ts'
import type { WorkbenchInjected } from '../src/client/app/workbench-types.ts'

it('releases all contributions on unload and registers once on reactivation', async () => {
  const ctx = new Context()
  const registry = new SidebarRightTabRegistry(ctx)
  const seats = new Set<string>()
  const dictionaries = new Set<string>()
  const subscriptions = new Set<() => void>()
  let bodyInject!: (sessionId: string) => WorkbenchInjected
  // Record only provider methods used by this plugin; the real Cordis fiber owns disposal.
  ctx.provide('sidebarRightTabs', registry as never)
  ctx.provide('workspaces', { list: { subscribe: (fn: () => void) => { subscriptions.add(fn); return () => subscriptions.delete(fn) }, getSnapshot: () => ({ items: [], state: 'idle', phase: 'ready' }) } } as never)
  ctx.provide('remote', { $mount: async () => () => {}, workbench: { command: async () => ({ ok: true }) } } as never)
  ctx.provide('remote.workbench', {} as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: (namespace: string) => {
      dictionaries.add(namespace)
      return () => dictionaries.delete(namespace)
    },
  } as never)
  ctx.provide('slots', {
    inject: (_slot: string, register: () => (() => void) | Generator<() => void>) => {
      const registered = register()
      const disposers = typeof registered === 'function' ? [registered] : [...registered]
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
    register: ({ name, key, inject: bind }: { name: string; key?: string; inject?: (sessionId: string) => WorkbenchInjected }) => {
      if (name === 'sidebar.right.pane.tab') bodyInject = bind!
      const seat = `${name}:${key ?? ''}`
      if (seats.has(seat)) throw new Error(`Duplicate seat ${seat}`)
      seats.add(seat)
      return () => seats.delete(seat)
    },
  } as never)
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const definition = registry.get(WORKBENCH_KIND)
      expect(definition?.id).toBe(WORKBENCH_ID)
      expect(definition?.guide?.[0]?.title()).toBe('title')
      expect(definition?.guide).toHaveLength(1)
      expect(seats.size).toBe(3)
      expect(dictionaries.size).toBe(1)
      expect(subscriptions.size).toBe(1)
      expect(document.querySelectorAll(`style[data-plugin="${WORKBENCH_ID}"]`)).toHaveLength(1)
      const lifetime = new AbortController()
      bodyInject('session-fixture').draftChanged('tab-fixture', true, lifetime.signal)
      const dirty = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(dirty)
      expect(dirty.defaultPrevented).toBe(true)
      await fiber.dispose()
      const clean = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(clean)
      expect(clean.defaultPrevented).toBe(false)
      expect(subscriptions.size).toBe(0)
      expect(registry.get(WORKBENCH_KIND)).toBeUndefined()
      expect(seats.size).toBe(0)
      expect(dictionaries.size).toBe(0)
      expect(document.querySelectorAll(`style[data-plugin="${WORKBENCH_ID}"]`)).toHaveLength(0)
    }
  } finally { await ctx.fiber.dispose() }
})

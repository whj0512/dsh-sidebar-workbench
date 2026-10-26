// @vitest-environment node
/** Workspace membership and delayed responses are tested without UI scheduling. */
import { expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkbenchData, workspaceFor } from '../src/client/data.ts'
import type { ProjectResult } from '../src/shared/project.ts'
function workspace(id: string, session: string): WorkspaceView {
  return { workspaceId: id as WorkspaceView['workspaceId'], path: `/project/${id}`, title: id,
    sessionIds: [session as WorkspaceView['sessionIds'][number]], createdAt: '', updatedAt: '' }
}
it('A21/A23 ignores cwd prefixes and keeps delayed project results with the initiating workspace', async () => {
  const list = createSnapshotStore<WorkspaceSnapshot>({ phase: 'ready', state: 'idle', error: null, items: [workspace('a', 's1'), workspace('b', 's2')], pinnedSessionIds: [], archivedSessionIds: [] })
  let resolve!: (value: ProjectResult) => void
  const data = new WorkbenchData({ list }, () => new Promise(done => { resolve = done }))
  const pending = data.project('s1', 'inspect')
  expect(data.source('s2').getSnapshot().workspace?.workspaceId).toBe('b')
  resolve({ ok: false, problem: 'identity' }); await pending
  expect(data.source('s2').getSnapshot().projectResult).toBeUndefined()
  expect(data.source('s1').getSnapshot().projectResult?.problem).toBe('identity')
  expect(workspaceFor(list.getSnapshot(), '/project/a/child')).toBeUndefined()
  list.set({ ...list.getSnapshot(), items: [{ ...workspace('a', 's1'), title: 'Renamed' }, workspace('b', 's2')] })
  expect(data.source('s1').getSnapshot().workspace?.title).toBe('Renamed')
  const r = data.start('s1', 'model', ['OnePedal'], 'success')[0]!
  list.set({ ...list.getSnapshot(), items: [workspace('b', 's2')] })
  expect(data.source('s1').getSnapshot().phase).toBe('removed')
  expect(data.executor.get(r.id).request.binding.root).toBe('demo:/a')
  data.dispose()
})

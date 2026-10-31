/** Project preparation output uses Host facts; no business executor or file reader is mocked as successful. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectResult } from '../src/shared/project.ts'
import { ProjectSummary } from '../src/client/features/project/ProjectSummary.tsx'
import { ProjectPanel } from '../src/client/features/project/ProjectPanel.tsx'
import { en } from '../src/client/i18n/locales.ts'

afterEach(cleanup)
const t: TranslateNS<'sidebarWorkbench'> = key => en[key as keyof typeof en]
const result: ProjectResult = { ok: true, project: { schema: 1, projectId: '11111111-1111-4111-8111-111111111111', baseline: null,
  materials: { original: 'source.pdf', markdown: 'source.md', version: 'V2', sameVersion: true }, artifacts: [], createdAt: '2026-10-31', validation: 'not-checked', resources: [] },
  resources: [{ path: 'source.pdf', kind: 'original', status: 'valid', bytes: 100, sha256: 'a'.repeat(64), checkedAt: '2026-10-31' },
    { path: 'source.md', kind: 'markdown', status: 'missing', checkedAt: '2026-10-31' }] }

it('shows the registered version separately from adoption, and only readable resources offer preview', () => {
  const openFile = vi.fn()
  render(<ProjectSummary t={t} result={result} openFile={openFile} unavailable={false} />)
  expect(screen.getByText('Registered material version: V2')).toBeTruthy()
  expect(screen.getByText('Adopted baseline: Not adopted')).toBeTruthy()
  expect(screen.getByText(en.resource_missing)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'source.md' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'source.pdf' }))
  expect(openFile).toHaveBeenCalledWith('source.pdf')
  expect(screen.getAllByRole('button').map(button => button.textContent)).toMatchInlineSnapshot(`
    [
      "source.pdf",
    ]
  `)
})

it('requires explicit review of the current relink summary and sends its revision', () => {
  const project = vi.fn()
  const relink: ProjectResult = { ...result, ok: false, problem: 'relink', relink: { previousWorkspaceId: 'old', previousRoot: '/old', nextWorkspaceId: 'new', nextRoot: '/new', revision: 2, unsettled: false } }
  const body = render(<ProjectPanel t={t} result={relink} project={project} go={vi.fn()} phase="ready" loading={false} />)
  expect(screen.getByRole('button', { name: en.relink }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: en.confirmRelink }))
  fireEvent.click(screen.getByRole('button', { name: en.relink }))
  expect(project).toHaveBeenCalledWith('relink', { expectedProjectId: result.project?.projectId, expectedRevision: 2 })
  body.rerender(<ProjectPanel t={t} result={{ ...relink, relink: { ...relink.relink!, revision: 3 } }} project={project} go={vi.fn()} phase="ready" loading={false} />)
  expect(screen.getByRole('button', { name: en.relink }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText(/Discover|Adopt discovery/)).toBeNull()
})

it('offers binding recovery for a published manifest without creating another project', () => {
  const project = vi.fn()
  render(<ProjectPanel t={t} result={result} project={project} go={vi.fn()} phase="ready" loading={false} />)
  fireEvent.click(screen.getByRole('button', { name: en.recoverBinding }))
  expect(project).toHaveBeenCalledWith('initialize', { materials: result.project?.materials })
})

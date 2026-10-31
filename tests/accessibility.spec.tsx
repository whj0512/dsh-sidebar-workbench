/** Isolated UI fixtures; no workspace registry, project files or remote mutations are used. */
import { useState } from 'react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MaterialsForm } from '../src/client/project/MaterialsForm.tsx'
import { DraftGuard } from '../src/client/state/draft-guard.ts'
import { en } from '../src/client/i18n/locales.ts'
import { FileLookupVersionError, materialFiles } from '../src/client/project/file-lookup.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(cleanup)
const t: TranslateNS<'sidebarWorkbench'> = key => en[key as keyof typeof en]
const empty = { original: '', markdown: '', version: '', sameVersion: false }

it('distinguishes an incompatible running Host from an empty directory and displays restart instructions', async () => {
  expect(materialFiles({ ok: true, value: { ok: true, files: [] } })).toEqual([])
  expect(() => materialFiles({ ok: true, value: { ok: true } })).toThrow(FileLookupVersionError)
  const listFiles = async () => materialFiles({ ok: false, error: new RemoteError('gateway/input-invalid', 'Invalid request', { endpoint: 'workbench/command', field: 'request' }) })
  render(<MaterialsForm t={t} fields={{ ...empty, original: '@' }} change={vi.fn()} initialize={vi.fn()} unavailable={false} loading={false} problem={undefined} listFiles={listFiles} />)
  expect(await screen.findByRole('menuitem', { name: en.fileLookupVersion })).toBeTruthy()
  expect(screen.queryByText(en.fileEmpty)).toBeNull()
  expect(() => materialFiles({ ok: true, value: { ok: false, problem: 'permission' } })).toThrow('permission')
})

it('selects workspace material paths with @ while keeping version as text and Enter out of submission', async () => {
  const initialize = vi.fn()
  const listFiles = vi.fn(async (query: string) => query === 'docs/'
    ? [{ path: 'docs/原文.pdf', directory: false }, { path: 'docs/原文.md', directory: false }]
    : [{ path: 'docs', directory: true }])
  function Form() {
    const [fields, setFields] = useState(empty)
    return <MaterialsForm t={t} fields={fields} change={patch => setFields(current => ({ ...current, ...patch }))} initialize={initialize} unavailable={false} loading={false} problem={undefined} listFiles={listFiles} />
  }
  render(<Form />)
  const fields = screen.getAllByRole('textbox')
  fields[0]!.focus()
  fireEvent.change(fields[0]!, { target: { value: '@' } })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'docs/' }))
  expect(await screen.findByRole('menuitem', { name: 'docs/原文.pdf' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'docs/原文.md' })).toBeNull()
  fireEvent.keyDown(fields[0]!, { key: 'Enter' })
  expect(fields[0]?.getAttribute('value')).toBe('docs/原文.pdf')
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.change(fields[1]!, { target: { value: '@docs/' } })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'docs/原文.md' }))
  fireEvent.change(fields[2]!, { target: { value: 'V2' } })
  expect(fields[2]?.getAttribute('value')).toBe('V2')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: en.initialize }))
  expect(initialize).toHaveBeenCalledTimes(1)
})

it('allows invalid submission, identifies each field, and focuses the first error without sending a command', () => {
  const initialize = vi.fn()
  function Form() {
    const [fields, setFields] = useState(empty)
    return <MaterialsForm t={t} fields={fields} change={patch => setFields(current => ({ ...current, ...patch }))} initialize={initialize} unavailable={false} loading={false} problem={undefined} />
  }
  render(<Form />)
  const submit = screen.getByRole('button', { name: en.initialize })
  expect(submit.hasAttribute('disabled')).toBe(false)
  fireEvent.click(submit)
  const fields = screen.getAllByRole('textbox')
  expect(document.activeElement).toBe(fields[0])
  expect(fields[0]?.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(fields[0]?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(en.originalRequired)
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.change(fields[0]!, { target: { value: '../outside.pdf' } })
  fireEvent.click(submit)
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.change(fields[0]!, { target: { value: 'source.pdf' } })
  fireEvent.change(fields[1]!, { target: { value: 'source.md' } })
  fireEvent.change(fields[2]!, { target: { value: 'V1' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(submit)
  expect(initialize).toHaveBeenCalledTimes(1)
  expect(fields[0]?.getAttribute('aria-invalid')).toBe('false')
})

it('keeps unavailable and pending commands disabled, and identifies Host material failures without clearing inputs', () => {
  const props = { t, fields: { original: 'source.pdf', markdown: 'source.md', version: 'V1', sameVersion: true }, change: vi.fn(), initialize: vi.fn(), unavailable: true, loading: false, problem: undefined }
  const body = render(<MaterialsForm {...props} />)
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  body.rerender(<MaterialsForm {...props} unavailable={false} />)
  fireEvent.click(screen.getByRole('button'))
  body.rerender(<MaterialsForm {...props} unavailable={false} loading />)
  expect(screen.getByRole('button', { name: en.initializing }).hasAttribute('disabled')).toBe(true)
  body.rerender(<MaterialsForm {...props} unavailable={false} problem="materials" />)
  expect(document.activeElement).toBe(screen.getAllByRole('textbox')[0])
  expect(screen.getAllByText(en.materialAccess)).toHaveLength(2)
  expect(screen.getAllByRole('textbox')[0]?.getAttribute('value')).toBe('source.pdf')
  expect(props.change).not.toHaveBeenCalled()
})

it('protects drafts from multiple panes until each is cleared and releases its listener on plugin disposal', () => {
  const guard = new DraftGuard(window)
  const first = new AbortController()
  const second = new AbortController()
  const release = vi.spyOn(second.signal, 'removeEventListener')
  const leave = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
  try {
    expect(leave()).toBe(false)
    guard.update('session-a:pane-a', true, first.signal)
    guard.update('session-b:pane-b', true, second.signal)
    expect(leave()).toBe(true)
    first.abort()
    expect(leave()).toBe(true)
    guard.update('session-b:pane-b', false, second.signal)
    expect(leave()).toBe(false)
    guard.update('session-a:pane-a', true, first.signal)
    expect(leave()).toBe(false)
    guard.update('session-b:pane-b', true, second.signal)
    guard.dispose()
    expect(leave()).toBe(false)
    expect(release.mock.calls.some(([type]) => type === 'abort')).toBe(true)
  } finally { guard.dispose(); release.mockRestore() }
})

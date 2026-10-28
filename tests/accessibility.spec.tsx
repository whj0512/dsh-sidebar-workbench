/** Isolated UI fixtures; no workspace registry, project files or remote mutations are used. */
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MaterialsForm } from '../src/client/project/MaterialsForm.tsx'
import { DraftGuard } from '../src/client/state/draft-guard.ts'
import { en } from '../src/client/i18n/locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(cleanup)
const t: TranslateNS<'sidebarWorkbench'> = key => en[key as keyof typeof en]
const empty = { original: '', markdown: '', version: '', sameVersion: false }

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
  const leave = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
  try {
    expect(leave()).toBe(false)
    guard.update('session-a:pane-a', true)
    guard.update('session-b:pane-b', true)
    expect(leave()).toBe(true)
    guard.update('session-a:pane-a', false)
    expect(leave()).toBe(true)
    guard.update('session-b:pane-b', false)
    expect(leave()).toBe(false)
    guard.update('session-a:pane-a', true)
    guard.dispose()
    expect(leave()).toBe(false)
  } finally { guard.dispose() }
})

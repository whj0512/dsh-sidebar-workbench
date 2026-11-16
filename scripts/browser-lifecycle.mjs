/** Keyless UI lifetime regression; mutates only a dedicated acceptance profile. */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dismissStartup, launchBrowser, rpc, setLanguage } from './browser-harness.mjs'

const target = process.env.DSH_TEST_URL
assert.ok(target, 'Set DSH_TEST_URL to the isolated test profile URL')
const output = resolve(process.env.DSH_TEST_OUTPUT_DIR ?? 'artifacts')
await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'lifecycle-'))
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
context.setDefaultTimeout(7000)
const page = await context.newPage()
const report = { origin: new URL(target).origin, browser: browser.version(), fixtureRoot: root, checks: [], errors: [], hostAccountDiagnostics: [] }
page.on('pageerror', error => report.errors.push(error.message))
page.on('console', message => {
  if (message.type() !== 'error' && message.type() !== 'warning') return
  const diagnostic = message.text()
  if (diagnostic === '[deepseek-account] account read failed {field: profile}') report.hostAccountDiagnostics.push(diagnostic)
  else report.errors.push(diagnostic)
})
const check = (name, details) => report.checks.push({ name, result: 'passed', ...details })
const regions = () => page.getByRole('region', { name: 'Requirements workbench', exact: true })
const protect = () => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
})
const enter = async () => {
  const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true }).first()
  const entry = page.getByRole('button', { name: /^Requirements workbench Materials/ }).first()
  const body = regions().first()
  await body.or(entry).or(expand).first().waitFor({ state: 'visible' })
  if (!await body.isVisible() && await expand.isVisible()) await expand.click()
  await body.or(entry).first().waitFor({ state: 'visible' })
  if (!await body.isVisible() && await entry.isVisible()) await entry.click()
  await body.waitFor()
}
const workspace = async suffix => {
  const dir = await mkdtemp(resolve(root, suffix + '-'))
  return (await rpc(page, 'workspace/create', { path: dir })).workspace
}
const selectWorkspace = async ws => {
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200),
    page.getByRole('menuitem', { name: ws.title, exact: true }).click(),
  ])
  const reply = await created.json()
  assert.equal(reply.result.ok, true)
  return reply.result.value.sessionId
}
try {
  await page.goto(target)
  await dismissStartup(page)
  await setLanguage(page, 'English')
  assert.match(await page.title(), /DSH/)
  assert.equal(new URL(page.url()).origin, report.origin)
  const a = await workspace('Workspace A')
  const b = await workspace('Workspace B')
  const sessionA = await selectWorkspace(a)
  await enter()
  let body = regions().first()
  await body.getByText(a.title, { exact: true }).waitFor()
  await body.getByText('Workspace directory (read only)', { exact: true }).click()
  assert.equal(await body.locator('input').count(), 0)
  await body.getByText(a.path, { exact: true }).waitFor()
  await body.getByText('Workspace directory (read only)', { exact: true }).click()
  for (const label of ['Materials and settings', 'Items and revision review', 'Run history', 'Artifacts']) {
    await body.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await body.getByRole('heading', { name: label, exact: true }).waitFor()
    if (label === 'Run history' || label === 'Artifacts') {
      assert.equal(await body.getByRole('button', { name: 'Advance one demo stage', exact: true }).count(), 0)
      await body.screenshot({ path: resolve(output, label === 'Run history' ? 'empty-runs.png' : 'empty-artifacts.png'), animations: 'disabled' })
    }
    await body.getByRole('button', { name: 'Back to flow', exact: true }).click()
  }
  check('all More destinations open and production history/artifacts remain empty')
  await body.getByRole('tab', { name: 'Flow', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await body.getByRole('tab', { name: 'Models', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await body.getByRole('tab', { name: 'Models', exact: true }).evaluate(el => el === document.activeElement), true)
  assert.equal(await body.getByRole('button', { name: 'Align and revalidate', exact: true }).count(), 0)
  await body.getByRole('button', { name: 'Demo mode', exact: true }).click()
  await body.getByRole('tab', { name: 'Models', exact: true }).click()
  await body.getByRole('button', { name: 'Statechart', exact: true }).click()
  await body.getByRole('textbox').fill('Session A / first pane')
  await body.getByRole('textbox').focus()
  await page.setViewportSize({ width: 1100, height: 1000 })
  assert.equal(await body.getByRole('textbox').evaluate(el => el === document.activeElement), true)
  check('keyboard navigation, production disabled, read-only root and resize focus')
  const more = body.getByRole('button', { name: 'More', exact: true })
  await more.click()
  const menu = page.getByRole('menu')
  const box = await menu.boundingBox()
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1100 && box.y + box.height <= 1000)
  await page.keyboard.press('Escape')
  assert.equal(await menu.count(), 0)
  assert.equal(await more.evaluate(el => el === document.activeElement), true)
  await more.click()
  await body.getByRole('heading', { name: 'Requirements workbench', exact: true }).click()
  assert.equal(await menu.count(), 0)
  check('menu fits viewport, Escape restores trigger focus and outside click dismisses')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await page.getByRole('button', { name: /^Requirements workbench Materials/ }).click()
  assert.equal(await regions().count(), 2)
  const second = regions().nth(1)
  await second.getByRole('button', { name: 'Demo mode', exact: true }).click()
  await second.getByRole('tab', { name: 'Models', exact: true }).click()
  assert.equal(await second.getByRole('textbox').inputValue(), '')
  await second.getByRole('textbox').fill('Session A / second pane')
  await second.getByRole('button', { name: 'DialogMap', exact: true }).click()
  const widths = await regions().evaluateAll(els => els.map(el => {
    const panel = el.querySelector('[role=tabpanel]')
    return { width: el.clientWidth, overflow: el.scrollWidth > el.clientWidth || panel.scrollWidth > panel.clientWidth }
  }))
  assert.ok(widths.every(item => item.width < 390 && !item.overflow))
  await page.screenshot({ path: resolve(output, 'split-english.png'), animations: 'disabled' })
  check('native split isolates drafts and selections below 390px per pane', { widths })
  await setLanguage(page, '中文')
  const chinese = page.getByRole('region', { name: '需求建模工作台', exact: true })
  assert.deepEqual(await chinese.locator('textarea').evaluateAll(els => els.map(el => el.value)), ['Session A / first pane', 'Session A / second pane'])
  assert.deepEqual(await chinese.getByRole('button', { pressed: true }).allTextContents(), ['Statechart', 'DialogMap'])
  await page.screenshot({ path: resolve(output, 'split-chinese.png'), animations: 'disabled' })
  await setLanguage(page, 'English')
  await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
  assert.equal(await protect(), true)
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  assert.equal(await regions().first().getByRole('textbox').inputValue(), 'Session A / first pane')
  check('language changes and sidebar collapse preserve both panes')
  await page.getByRole('tab', { name: 'Requirements workbench Close', exact: true }).nth(1).getByRole('button', { name: 'Close', exact: true }).click()
  await regions().first().getByRole('textbox').fill('')
  assert.equal(await protect(), false)
  check('closed tab stops protecting its discarded draft')
  await regions().first().getByRole('textbox').fill('Session A preserved across navigation')
  const sessionB = await selectWorkspace(b)
  assert.notEqual(sessionA, sessionB)
  await enter()
  body = regions().first()
  await body.getByText(b.title, { exact: true }).waitFor()
  await body.getByRole('button', { name: 'Demo mode', exact: true }).click()
  await body.getByRole('tab', { name: 'Models', exact: true }).click()
  assert.equal(await body.getByRole('textbox').inputValue(), '')
  await body.getByRole('textbox').fill('Session B isolated')
  const returned = await selectWorkspace(a)
  assert.equal(returned, sessionA)
  await enter()
  body = regions().first()
  await body.getByText(a.title, { exact: true }).waitFor()
  assert.equal(await body.getByRole('textbox').inputValue(), 'Session A preserved across navigation')
  assert.equal(await body.getByRole('button', { name: 'Statechart', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.screenshot({ path: resolve(output, 'session-return.png'), animations: 'disabled' })
  check('cross-workspace Session navigation restores only its own draft and selection', { sessionA, sessionB })
  assert.equal(await page.locator('style[data-plugin="dsh-plugin-sidebar-workbench"]').count(), 1)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(report.errors, [])
  check('single stylesheet, meaningful page, no framework overlay or console errors')
} catch (error) {
  report.failure = String(error)
  await page.screenshot({ path: resolve(output, 'failure.png'), animations: 'disabled' })
  throw error
} finally {
  await context.close()
  await browser.close()
  await writeFile(resolve(output, 'lifecycle-results.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))

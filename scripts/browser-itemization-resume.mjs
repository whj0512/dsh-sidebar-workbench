/** Observe the distinct adjustment from an explicit real-run report; never adopts a business candidate. */
import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { dismissStartup, launchBrowser, rpc, setLanguage } from './browser-harness.mjs'

const target = process.env.DSH_TEST_URL, sourceReport = process.env.DSH_REAL_RESUME_REPORT, directory = process.env.DSH_TEST_OUTPUT_DIR
if (!target || !sourceReport || !directory) throw new Error('Explicit isolated Host URL, prior report and output directory required')
const output = resolve(directory), previous = JSON.parse(await readFile(sourceReport, 'utf8'))
const initial = previous.runs[0]
assert.equal(initial.state, 'succeeded')
await mkdir(output, { recursive: true })
const browser = await launchBrowser(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
const report = { ...previous, evidence: 'real configured model; distinct adjustment identity verified; no automatic adoption', runs: [initial], result: 'pending', errors: [] }
page.on('pageerror', error => report.errors.push(error.message))
try {
  await page.goto(target); await dismissStartup(page); await setLanguage(page, '中文')
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const [created] = await Promise.all([page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200), page.getByRole('menuitem', { name: basename(previous.root), exact: true }).click()])
  const sessionId = (await created.json()).result.value.sessionId
  report.observationSessionId = sessionId
  const inspect = () => rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: previous.workspaceId })
  const open = page.getByRole('button', { name: '打开右侧边栏', exact: true }); if (await open.isVisible()) await open.click()
  await page.getByRole('button', { name: /^需求建模工作台 材料/ }).click()
  const panel = page.getByRole('region', { name: '真实文档条目化', exact: true }); await panel.waitFor()
  if (process.env.DSH_REAL_ITEMIZATION_FEEDBACK) {
    const state = await inspect()
    assert.ok(state.runs.every(run => !['queued', 'running', 'cancelling', 'unknown', 'interrupted'].includes(run.state)))
    await panel.getByLabel('选择', { exact: true }).selectOption(initial.candidateId)
    await panel.getByLabel('调整意见', { exact: true }).fill(process.env.DSH_REAL_ITEMIZATION_FEEDBACK)
    await panel.getByRole('button', { name: '按调整意见重新划分', exact: true }).click()
    report.feedback = process.env.DSH_REAL_ITEMIZATION_FEEDBACK
    report.preexistingRunIds = state.runs.map(run => run.id)
  }
  const deadline = Date.now() + 1200000
  let state, adjusted
  do {
    state = await inspect(); assert.equal(state.ok, true)
    adjusted = state.runs.findLast(run => run.id !== initial.id && run.parentCandidateId === initial.candidateId && !report.preexistingRunIds?.includes(run.id))
    if (adjusted && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(adjusted.state)) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  } while (Date.now() < deadline)
  report.runs.push({ phase: 'adjustment', ...adjusted })
  assert.equal(adjusted?.state, 'succeeded', `Adjustment did not succeed: ${adjusted?.problem ?? 'no terminal state'}`)
  assert.notEqual(adjusted.id, initial.id)
  assert.equal(state.state.baseline, null)
  await panel.getByLabel('选择', { exact: true }).selectOption(adjusted.candidateId)
  await panel.getByRole('button', { name: '查看候选内容', exact: true }).click()
  const reviewed = await rpc(page, 'workbench/itemization', { action: 'candidate', sessionId, workspaceId: previous.workspaceId, candidateId: adjusted.candidateId })
  assert.equal(reviewed.ok, true)
  const validation = JSON.parse(reviewed.content).validation
  report.reviewBlocked = validation.reviewBlocked
  report.sourceConflicts = validation.sourceConflicts
  if (process.env.DSH_EXPECT_SOURCE_CONFLICT === '1') {
    assert.equal(validation.reviewBlocked, true)
    assert.ok(validation.sourceConflicts.length > 0)
    assert.equal(await panel.getByRole('button', { name: '采用划分', exact: true }).isDisabled(), true)
  }
  await panel.getByRole('tab', { name: '功能条目', exact: true }).click()
  await page.screenshot({ path: resolve(output, 'adjustment-features.png'), animations: 'disabled' })
  await panel.getByRole('tab', { name: '关系', exact: true }).click()
  await page.screenshot({ path: resolve(output, 'adjustment-seed.png'), animations: 'disabled' })
  await panel.getByRole('tab', { name: '校验', exact: true }).click()
  await page.screenshot({ path: resolve(output, 'adjustment-issues.png'), animations: 'disabled' })
  report.result = validation.reviewBlocked ? 'adjustment-generated-source-conflict-blocks-adoption' : 'distinct-initial-and-adjustment-awaiting-human-review'
} catch (error) {
  report.result = 'failed'; report.failure = error.message
  await page.screenshot({ path: resolve(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
  throw error
} finally {
  await writeFile(resolve(output, 'real-itemization-verified.json'), JSON.stringify(report, null, 2) + '\n')
  await context.close(); await browser.close()
}
console.log(JSON.stringify({ result: report.result, runs: report.runs.map(run => ({ id: run.id, state: run.state })) }))

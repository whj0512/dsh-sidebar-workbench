/** Real-model acceptance against an explicitly isolated DSH Host and workspace copies. */
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dismissStartup, launchBrowser, rpc, setLanguage } from './browser-harness.mjs'

const { DSH_TEST_URL, DSH_TEST_OUTPUT_DIR, DSH_MODEL_SAMPLE, DSH_MODEL_SOURCE } = process.env
assert.ok(DSH_TEST_URL && DSH_TEST_OUTPUT_DIR && DSH_MODEL_SOURCE)
assert.match(DSH_MODEL_SAMPLE ?? '', /^(vehicle|radio)$/)
let name = DSH_MODEL_SAMPLE === 'vehicle' ? '转毂模式' : '收音机'
const output = resolve(DSH_TEST_OUTPUT_DIR)
await mkdir(output, { recursive: true })
const root = resolve(output, DSH_MODEL_SAMPLE + '-workspace-' + randomUUID())
await mkdir(root)
const evidence = { sample: DSH_MODEL_SAMPLE, workspace: root, origin: new URL(DSH_TEST_URL).origin, errors: [] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = new Map()
let materials
if (DSH_MODEL_SAMPLE === 'vehicle') {
  const src = resolve(DSH_MODEL_SOURCE)
  const manifest = JSON.parse(await readFile(resolve(src, '.workbench/project.json'), 'utf8'))
  materials = manifest.materials
  const dir = resolve(src, '.workbench/itemization')
  const latest = (await readdir(dir)).filter(name => /^\d{12}\.json$/.test(name)).sort().at(-1)
  const state = JSON.parse(await readFile(resolve(dir, latest), 'utf8'))
  const candidate = state.candidates.find(item => item.id === state.baseline)
  assert.ok(candidate && state.adoption?.candidateId === state.baseline)
  await cp(resolve(src, '.workbench'), resolve(root, '.workbench'), { recursive: true })
  await cp(resolve(src, 'workbench-runs', candidate.runId), resolve(root, 'workbench-runs', candidate.runId), { recursive: true })
  // A copied workspace gets its own project identity so it can coexist with earlier acceptance copies.
  const projectId = randomUUID()
  await writeFile(resolve(root, '.workbench/project.json'), JSON.stringify({ ...manifest, projectId }))
  for (const version of (await readdir(dir)).filter(name => /^\d{12}\.json$/.test(name))) {
    const snapshot = JSON.parse(await readFile(resolve(dir, version), 'utf8'))
    await writeFile(resolve(root, '.workbench/itemization', version), JSON.stringify({ ...snapshot, projectId }))
  }
  evidence.copiedBaseline = { sourceProjectId: manifest.projectId, projectId, revision: state.revision, candidateId: state.baseline }
  for (const ref of candidate.artifacts) assert.equal(hash(await readFile(resolve(root, ref.path))), ref.sha256)
  for (const file of [materials.original, materials.markdown]) {
    const source = resolve(src, file)
    const dest = resolve(root, file)
    await mkdir(resolve(dest, '..'), { recursive: true })
    await cp(source, dest)
    sourceFiles.set(source, hash(await readFile(source)))
  }
} else {
  const pdf = '多媒体中心功能规范V1.0-20250722.pdf'
  const md = 'MinerU_markdown_多媒体中心功能规范V1.0-20250722_2081303193935974400.md'
  materials = { original: pdf, markdown: md, version: 'V1.0-20250722', sameVersion: true }
  for (const file of [pdf, md]) {
    const source = resolve(DSH_MODEL_SOURCE, file)
    await cp(source, resolve(root, file))
    sourceFiles.set(source, hash(await readFile(source)))
  }
}
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('pageerror', error => evidence.errors.push(error.message))
const save = () => writeFile(resolve(output, 'real-modeling.json'), JSON.stringify(evidence, null, 2) + '\n')
const until = async (read, timeoutMs = 3600000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await read()
    if (data) return data
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('Run did not reach the required state in time')
}
try {
  await page.goto(DSH_TEST_URL)
  await dismissStartup(page)
  await setLanguage(page, '中文')
  const { workspace } = await rpc(page, 'workspace/create', { path: root })
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200),
    page.getByRole('menuitem', { name: workspace.title, exact: true }).click(),
  ])
  const scope = { workspaceId: workspace.workspaceId, sessionId: (await created.json()).result.value.sessionId }
  evidence.scope = scope
  const initialized = await rpc(page, 'workbench/command', { ...scope, action: 'initialize', materials })
  assert.equal(initialized.ok, true, initialized.problem)
  const itemization = request => rpc(page, 'workbench/itemization', { ...scope, ...request })
  const modeling = request => rpc(page, 'workbench/modeling', { ...scope, ...request })
  if (name === '收音机') {
    const started = await itemization({ action: 'start', requestKey: randomUUID() })
    assert.equal(started.ok, true, started.problem)
    const runId = started.runs.at(-1).id
    evidence.itemization = await until(async () => {
      const inspected = await itemization({ action: 'inspect' })
      const run = inspected.runs?.find(item => item.id === runId)
      if (run && run.sequence !== evidence.itemization?.sequence) { evidence.itemization = run; await save() }
      return run && ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(run.state) && run
    })
    await save()
    assert.equal(evidence.itemization.state, 'succeeded', evidence.itemization.problem)
    const comparison = await itemization({ action: 'compare', candidateId: evidence.itemization.candidateId })
    evidence.adoption = { intendedCandidate: evidence.itemization.candidateId, review: JSON.parse(comparison.comparison).adoptionReview }
    // Isolated acceptance only. The production candidate remains under the user's review.
    const adopted = await itemization({ action: 'adopt', candidateId: evidence.itemization.candidateId,
      expectedRevision: comparison.state.revision, impactFingerprint: comparison.impactFingerprint })
    assert.equal(adopted.state?.baseline, evidence.itemization.candidateId, adopted.problem)
    evidence.adoption.adopted = adopted.state.baseline
  }
  const inspection = await modeling({ action: 'inspect' })
  assert.equal(inspection.ok, true, inspection.detail)
  let feature = inspection.features.find(item => item.name === name)
  if (DSH_MODEL_SAMPLE === 'radio') {
    // The itemizer can split the section into separate functions. Select the
    // specific UI function when the overview no longer contains page behavior.
    const uiFeature = inspection.features.find(item => item.section === '6.2.2' && /收音机/.test(item.name))
      ?? inspection.features.find(item => /打开.*收音机/.test(item.name))
    if (uiFeature) { feature = uiFeature; name = uiFeature.name }
  }
  assert.ok(feature, 'Expected function is in the baseline')
  evidence.feature = feature
  evidence.baseline = inspection.baseline
  const open = page.getByRole('button', { name: '打开右侧边栏', exact: true })
  if (await open.isVisible()) await open.click()
  await page.getByRole('button', { name: /^需求建模工作台 材料/ }).click()
  const workbench = page.getByRole('region', { name: '需求建模工作台' })
  await workbench.getByRole('button', { name: /功能.*批量|功能列表/ }).click()
  const panel = workbench.getByRole('region', { name: '建模至 DSL' })
  await panel.getByRole('button', { name, exact: true }).click()
  await panel.getByRole('button', { name: '建模至 DSL', exact: true }).click()
  evidence.run = await until(async () => {
    const inspected = await modeling({ action: 'inspect' })
    const run = inspected.runs?.find(item => item.feature.id === feature.id)
    if (run && run.sequence !== evidence.run?.sequence) { evidence.run = run; await save() }
    return run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state) && run
  })
  await page.screenshot({ path: resolve(output, 'run.png'), animations: 'disabled' })
  assert.equal(evidence.run.state, 'succeeded', evidence.run.detail)
  assert.ok(evidence.run.executionSessionId)
  await page.getByRole('tab', { name: '模型', exact: true }).click()
  await panel.getByRole('button', { name: DSH_MODEL_SAMPLE === 'radio' ? 'DialogMap' : 'Environment', exact: true }).click()
  await panel.getByLabel('需求 ID', { exact: true }).selectOption({ index: 1 })
  await page.screenshot({ path: resolve(output, 'trace.png'), animations: 'disabled' })
  evidence.validation = JSON.parse(await readFile(resolve(root, 'workbench-runs', evidence.run.id, 'validation.json'), 'utf8'))
  assert.ok(evidence.validation.passed)
  if (DSH_MODEL_SAMPLE === 'radio') assert.ok(evidence.validation.files.some(item => item.kind === 'DialogMap'))
  await page.reload()
  assert.equal((await modeling({ action: 'inspect' })).runs.find(run => run.id === evidence.run.id)?.state, 'succeeded')
  evidence.result = 'modeling-through-dsl-generated'
} catch (error) {
  evidence.result = 'failed'
  evidence.problem = error.message.replace(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local URL]')
  await page.screenshot({ path: resolve(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
  process.exitCode = 1
} finally {
  for (const [source, expected] of sourceFiles) assert.equal(hash(await readFile(source)), expected)
  evidence.originalFingerprints = [...sourceFiles.values()]
  await save()
  await context.close()
  await browser.close()
}
console.log(JSON.stringify({ result: evidence.result, problem: evidence.problem, runId: evidence.run?.id, executionSessionId: evidence.run?.executionSessionId }))

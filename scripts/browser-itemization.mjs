/** Real-Host UI checks, with an explicitly enabled controlled model provider for execution coverage. */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { dismissStartup, launchBrowser, rpc, setLanguage } from './browser-harness.mjs'
import { itemizationSessionSnapshot } from './itemization-session-snapshot.mjs'

const target = process.env.DSH_TEST_URL
if (!target) throw new Error('Set DSH_TEST_URL for the isolated profile')
const output = resolve(process.env.DSH_TEST_OUTPUT_DIR ?? 'artifacts/itemization-browser')
await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'workspace-'))
await writeFile(resolve(root, 'source.docx'), zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>System includes Drive. Drive shall stop.</w:t></w:r></w:p></w:body></w:document>'),
}))
await writeFile(resolve(root, 'source.md'), '# 1 Overview\nSystem includes Drive.\n# 2 Drive\nDrive shall stop.\n')
const browser = await launchBrowser()
const report = { origin: new URL(target).origin, browser: await browser.version(), classification: 'Browser plugin not available',
  evidence: process.env.DSH_TEST_ITEMIZATION_EXECUTE === 'fixture' ? 'real Host with a controlled model provider; not real-model business evidence' : 'keyless Host UI; no model task', checks: [] }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(target); await dismissStartup(page); await setLanguage(page, '中文')
  const workspace = (await rpc(page, 'workspace/create', { path: root })).workspace
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200),
    page.getByRole('menuitem', { name: workspace.title, exact: true }).click(),
  ])
  const sessionId = (await created.json()).result.value.sessionId
  const initialized = await rpc(page, 'workbench/command', { action: 'initialize', sessionId, workspaceId: workspace.workspaceId,
    materials: { original: 'source.docx', markdown: 'source.md', version: 'V1', sameVersion: true } })
  assert.equal(initialized.ok, true)
  const inspected = await rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: workspace.workspaceId })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.runs.length, 0)
  const open = page.getByRole('button', { name: '打开右侧边栏', exact: true })
  if (await open.isVisible()) await open.click()
  await page.getByRole('button', { name: /^需求建模工作台 材料/ }).click()
  const panel = page.getByRole('region', { name: '真实文档条目化', exact: true })
  await panel.waitFor()
  await panel.getByText('正式基线: 尚未审核采用', { exact: true }).waitFor()
  await panel.getByRole('checkbox', { name: '处理新材料版本', exact: true }).check()
  await panel.getByLabel('原始 PDF / DOCX（项目内相对路径）').fill('source.docx')
  await panel.getByLabel('同版 MinerU Markdown（项目内相对路径）').fill('source.md')
  await panel.getByRole('textbox', { name: '待处理材料版本', exact: true }).fill('V2')
  await panel.getByRole('checkbox', { name: '原文与 Markdown 同版', exact: false }).check()
  assert.equal(await panel.getByRole('button', { name: '开始条目化', exact: true }).isEnabled(), inspected.available)
  if (process.env.DSH_TEST_ITEMIZATION_EXECUTE === 'fixture') {
    await panel.getByRole('checkbox', { name: '处理新材料版本', exact: true }).uncheck()
    await panel.getByRole('button', { name: '开始条目化', exact: true }).click()
    await panel.getByText(/生成完成，等待审核/).waitFor({ timeout: 60000 })
    const generated = await rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: workspace.workspaceId })
    assert.equal(generated.state.candidates.length, 1)
    const candidateId = generated.state.candidates[0].id
    await panel.getByLabel('选择', { exact: true }).selectOption(candidateId)
    await panel.getByRole('button', { name: '查看候选内容', exact: true }).click()
    await panel.getByRole('button', { name: '比较并核对影响', exact: true }).click()
    await panel.getByRole('checkbox', { name: '我已核对差异和受影响范围，采用整个候选版本', exact: true }).check()
    await panel.getByRole('button', { name: '采用划分', exact: true }).click()
    await panel.getByText('此候选为当前正式基线', { exact: true }).waitFor()
    const adopted = await rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: workspace.workspaceId })
    assert.equal(adopted.state.baseline, candidateId)
    if (process.env.DSH_TEST_HOME) {
      const snapshot = await itemizationSessionSnapshot(process.env.DSH_TEST_HOME, adopted.runs[0].sessionId, adopted.runs[0].id)
      await writeFile(resolve(output, 'itemization-session-original-skills.json'), JSON.stringify(snapshot, null, 2) + '\n')
      const expected = process.env.DSH_EXPECTED_ITEMIZATION_SESSION
      if (expected) {
        if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(resolve(expected), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
        else assert.deepEqual(snapshot, JSON.parse(await readFile(resolve(expected), 'utf8')))
      }
      report.checks.push({ result: 'passed', evidence: expected ? 'explicit original-skill Session comparison' : 'captured original-skill Session; no snapshot replay claimed' })
    }
    report.checks.push({ result: 'passed', evidence: 'controlled fixture provider through real DSH Agent, native file aliases, Session and adoption; original script semantics not exercised', runId: adopted.runs[0].id, executionSessionId: adopted.runs[0].sessionId, root })
  }
  await page.screenshot({ path: resolve(output, 'itemization-desktop.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: resolve(output, 'itemization-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: resolve(output, 'itemization-narrow.png'), animations: 'disabled' })
  const overflow = await panel.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow))
  assert.deepEqual(errors.filter(error => !error.startsWith('[deepseek-account] account read failed')), [])
  report.checks.push({ title: await page.title(), panel: 'itemization', available: inspected.available, result: 'passed', overflow, errors })
  await context.close()
} finally { await browser.close(); await writeFile(resolve(output, 'itemization-browser.json'), JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify(report))

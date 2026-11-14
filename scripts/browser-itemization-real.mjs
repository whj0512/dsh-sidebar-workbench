/** Real-model V1 generation and adjustment against explicit user-selected materials. Never auto-adopts business output. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { dismissStartup, launchBrowser, rpc, setLanguage } from './browser-harness.mjs'

const target = process.env.DSH_TEST_URL, sourceRoot = process.env.DSH_REAL_MATERIAL_ROOT
if (!target || !sourceRoot || !process.env.DSH_TEST_OUTPUT_DIR) throw new Error('Explicit isolated Host URL, material root and output directory are required')
const output = resolve(process.env.DSH_TEST_OUTPUT_DIR)
await mkdir(output, { recursive: true })
const materials = z.object({ original: z.string(), markdown: z.string(), version: z.string(), sameVersion: z.literal(true) }).parse(JSON.parse(await readFile(resolve(sourceRoot, '.workbench/project.json'), 'utf8')).materials)
const inside = path => { const absolute = resolve(sourceRoot, path), rel = relative(resolve(sourceRoot), absolute); if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Source escapes explicit material root'); return absolute }
const original = await readFile(inside(materials.original)), markdown = await readFile(inside(materials.markdown))
const hash = value => createHash('sha256').update(value).digest('hex')
const root = await mkdtemp(resolve(output, 'V1-workspace-'))
const originalName = /\.pdf$/i.test(materials.original) ? 'source.pdf' : 'source.docx'
await writeFile(resolve(root, originalName), original); await writeFile(resolve(root, 'source.md'), markdown)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
const report = { evidence: 'real Host and configured model; human review pending; no automatic adoption', origin: new URL(target).origin,
  sourceRoot, root, input: { version: materials.version, originalSha256: hash(original), markdownSha256: hash(markdown) }, runs: [], errors }
try {
  await page.goto(target); await dismissStartup(page); await setLanguage(page, '中文')
  const workspace = (await rpc(page, 'workspace/create', { path: root })).workspace
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const [created] = await Promise.all([page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200), page.getByRole('menuitem', { name: workspace.title, exact: true }).click()])
  const sessionId = (await created.json()).result.value.sessionId
  report.sessionId = sessionId; report.workspaceId = workspace.workspaceId
  const initialized = await rpc(page, 'workbench/command', { action: 'initialize', sessionId, workspaceId: workspace.workspaceId,
    materials: { original: originalName, markdown: 'source.md', version: materials.version, sameVersion: true } })
  assert.equal(initialized.ok, true)
  const open = page.getByRole('button', { name: '打开右侧边栏', exact: true }); if (await open.isVisible()) await open.click()
  await page.getByRole('button', { name: /^需求建模工作台 材料/ }).click()
  const panel = page.getByRole('region', { name: '真实文档条目化', exact: true }); await panel.waitFor()
  for (const phase of ['initial', 'adjustment']) {
    if (phase === 'initial') await panel.getByRole('button', { name: '开始条目化', exact: true }).click()
    else {
      await panel.getByLabel('选择', { exact: true }).selectOption(report.runs[0].candidateId)
      await panel.getByLabel('调整意见', { exact: true }).fill(process.env.DSH_REAL_ITEMIZATION_FEEDBACK ?? '请复核首次划分：保留原文中的独立功能与系统概述，重点检查跨章节描述是否归入对应功能、正文片段是否遗漏或重复、includes 是否有准确引句。只依据原文调整，不新增或删减业务规则；无法唯一确定的事项明确列入问题。')
      await panel.getByRole('button', { name: '按调整意见重新划分', exact: true }).click()
    }
    const deadline = Date.now() + 1200000
    let current
    do {
      const inspection = await rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: workspace.workspaceId })
      if (!inspection.ok) throw new Error(`Inspection failed: ${inspection.problem}`)
      current = phase === 'adjustment' ? inspection.runs.findLast(run => run.id !== report.runs[0].id && run.parentCandidateId === report.runs[0].candidateId) : inspection.runs.at(-1)
      if (!current) {
        const text = await panel.innerText()
        if (/执行能力不可用|保存结果需核对|模型未提交|材料或候选校验失败/.test(text)) throw new Error('Run admission failed; inspect real-browser evidence')
      } else if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(current.state)) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    } while (Date.now() < deadline)
    report.runs.push({ phase, ...current })
    await writeFile(resolve(output, 'real-itemization.json'), JSON.stringify(report, null, 2) + '\n')
    assert.equal(current?.state, 'succeeded', `Real ${phase} run did not pass: ${current?.problem ?? 'no terminal state'}`)
    await panel.getByLabel('选择', { exact: true }).selectOption(current.candidateId)
    await panel.getByRole('button', { name: '查看候选内容', exact: true }).click()
    await page.screenshot({ path: resolve(output, `${phase}-real.png`), animations: 'disabled' })
  }
  const inspection = await rpc(page, 'workbench/itemization', { action: 'inspect', sessionId, workspaceId: workspace.workspaceId })
  assert.equal(inspection.state.baseline, null)
  assert.equal(hash(await readFile(inside(materials.original))), report.input.originalSha256)
  assert.equal(hash(await readFile(inside(materials.markdown))), report.input.markdownSha256)
  report.result = 'generated-and-adjusted-awaiting-human-review'
} catch (error) {
  report.result = 'failed'; report.failure = error.message
  await page.screenshot({ path: resolve(output, 'real-failure.png'), animations: 'disabled' }).catch(() => {})
  throw error
} finally {
  await writeFile(resolve(output, 'real-itemization.json'), JSON.stringify(report, null, 2) + '\n')
  await context.close(); await browser.close()
}
console.log(JSON.stringify({ result: report.result, root: report.root, runs: report.runs.map(run => ({ id: run.id, state: run.state, sessionId: run.sessionId })) }))

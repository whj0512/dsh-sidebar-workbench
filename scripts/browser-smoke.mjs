/** Keyless UI smoke against a real DSH profile with the plugin installed. */
import { strict as assert } from 'node:assert'
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { PDFDocument } from 'pdf-lib'

import { dismissStartup, launchBrowser, setLanguage } from './browser-harness.mjs'
const target = process.env.DSH_TEST_URL
const uninstalled = process.argv.includes('--uninstalled')
if (!target) throw new Error('Set DSH_TEST_URL to the URL printed by the test profile')
const output = resolve(process.env.DSH_TEST_OUTPUT_DIR ?? 'artifacts')
await mkdir(output, { recursive: true })

const copies = [
  { locale: 'zh-CN', title: '需求建模工作台', entry: /^需求建模工作台 材料/, click: '点击试试', reset: '重置',
    count: value => `已点击 ${value} 次`, open: '打开右侧边栏', close: '关闭', next: '继续',
    choose: '选择工作区', defaultWorkspace: '默认工作区', newTab: '新标签页', guide: '开始', fullscreen: '全屏' },
  { locale: 'en-US', title: 'Requirements workbench', entry: /^Requirements workbench Materials/, click: 'Try clicking', reset: 'Reset',
    count: value => `Click count: ${value}`, open: 'Open right sidebar', close: 'Close', next: 'Continue',
    choose: 'Choose workspace', defaultWorkspace: 'Default workspace', newTab: 'New tab', guide: 'Start', fullscreen: 'Fullscreen' },
]
const browser = await launchBrowser()
const report = { origin: new URL(target).origin, browser: await browser.version(), mode: uninstalled ? 'uninstalled' : 'installed', checks: [] }
try {
  for (const copy of copies) {
    const fixtureRoot = await mkdtemp(resolve(output, 'workbench-ui-'));
    const fixtureName = basename(fixtureRoot);
    const document = await PDFDocument.create(); document.addPage();
    await writeFile(resolve(fixtureRoot, 'source.pdf'), await document.save());
    await writeFile(resolve(fixtureRoot, 'source.md'), '# Fixture');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: copy.locale })
    const page = await context.newPage()
    page.setDefaultTimeout(7000)
    const errors = []
    page.on('response',async response=>{if(response.url().includes('/api/workbench/command')) console.log('Workbench RPC',JSON.stringify(await response.json()));});
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if(message.type() === 'warning') console.log(message.text()) })
    try {
      await page.goto(target)
      await dismissStartup(page)
      await setLanguage(page, copy.locale === 'zh-CN' ? '中文' : 'English')
      const workspaceReply = await page.evaluate(async path => {
        const response = await fetch('api/workspace/create', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'workspace/create',payload:{args:{request:{path}}}})});
        return response.json();
      }, fixtureRoot);
      assert.equal(workspaceReply.result.ok,true,JSON.stringify(workspaceReply));
      if (await page.getByRole('button', { name: copy.choose, exact: true }).isVisible()) {
        await page.getByRole('button', { name: copy.choose, exact: true }).click()
        await Promise.all([
          page.waitForResponse(response => response.url().includes('/api/session/create') && response.status() === 200),
          page.getByRole('menuitem', { name: fixtureName, exact: true }).click(),
        ])
      }
      if (uninstalled) {
        await page.getByRole('button', { name: copy.open, exact: true }).click()
        await page.getByRole('tablist').waitFor()
        assert.equal(await page.getByRole('button', { name: copy.entry }).count(), 0)
        assert.equal(await page.locator('style[data-plugin="dsh-plugin-sidebar-workbench"]').count(), 0)
        assert.deepEqual(errors.filter(error => !error.startsWith('[deepseek-account] account read failed')), [])
        await page.screenshot({ animations: 'disabled',  path: resolve(output, `${copy.locale}-uninstalled.png`) })
        report.checks.push({ locale: copy.locale, result: 'passed', scenarios: ['entry removed', 'stylesheet removed'], errors })
        continue
      }
      const openWorkbench = async () => {
        const open = page.getByRole('button', { name: copy.open, exact: true })
        if (await open.isVisible()) await open.click()
        await page.getByRole('button', { name: copy.entry }).click()
        await page.getByRole('region', { name: copy.title, exact: true }).waitFor()
      }
      await openWorkbench()
      const body = page.getByRole('region', { name: copy.title, exact: true })
      const zh = copy.locale === 'zh-CN';
      await body.getByText(fixtureName,{exact:true}).waitFor();
      await body.screenshot({animations:'disabled',path:resolve(output,copy.locale+'-flow.png')});
      const init = zh ? '在当前工作区初始化' : 'Initialize in this workspace';
      await body.getByRole('button',{name:init,exact:true}).click();
      await body.getByLabel(zh ? '原始 PDF / DOCX（项目内相对路径）' : 'Original PDF / DOCX (project-relative path)').fill('source.pdf');
      await body.getByLabel(zh ? '同版 MinerU Markdown（项目内相对路径）' : 'Matching MinerU Markdown (project-relative path)').fill('source.md');
      await body.getByLabel(zh ? '当前基线' : 'Current baseline',{exact:true}).fill('V1');
      await body.getByRole('checkbox').check();
      await body.screenshot({animations:'disabled',path:resolve(output,copy.locale+'-settings.png')});
      await body.getByRole('button',{name:init,exact:true}).last().click();
      await body.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/).waitFor();

      const labels = zh ? {demo:'演示模式',features:'功能与批量运行',model:'完整建模',advance:'推进一个演示阶段',cancel:'取消此运行',confirm:'模拟停止确认',models:'模型',tests:'测试',graph:'图谱'} : {demo:'Demo mode',features:'Features and batches',model:'Full modeling',advance:'Advance one demo stage',cancel:'Cancel this run',confirm:'Simulate stop acknowledgment',models:'Models',tests:'Tests',graph:'Graph'};
      await body.getByRole('button',{name:labels.demo,exact:true}).click();
      await body.getByRole('button',{name:labels.features,exact:true}).click();
      await body.getByRole('button',{name:labels.model,exact:true}).click();
      await body.getByRole('button',{name:labels.advance,exact:true}).click();
      await body.getByRole('button',{name:labels.cancel,exact:true}).click();
      await body.getByRole('button',{name:labels.confirm,exact:true}).click();
      await body.screenshot({ animations: 'disabled', path:resolve(output,copy.locale+'-light.png')});
      for (const label of [labels.models,labels.tests,labels.graph]) await body.getByRole('tab',{name:label,exact:true}).click();
      await page.emulateMedia({colorScheme:'dark'});
      await body.screenshot({ animations: 'disabled', path:resolve(output,copy.locale+'-dark.png')});
      const fullscreen=page.getByRole('button',{name:copy.fullscreen,exact:true});
      if (await fullscreen.isVisible()) await fullscreen.click();
      await page.setViewportSize({width:390,height:844});
      await body.getByRole('tab',{name:labels.models,exact:true}).click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await body.getByRole('button', { name: zh ? '更多' : 'More', exact: true }).click();
      const mobileMenu = page.getByRole('menu');
      const mobileMenuBox = await mobileMenu.boundingBox();
      assert.ok(mobileMenuBox.x >= 0 && mobileMenuBox.y >= 0 && mobileMenuBox.x + mobileMenuBox.width <= 390 && mobileMenuBox.y + mobileMenuBox.height <= 844);
      await page.screenshot({ animations: 'disabled', path:resolve(output,copy.locale+'-mobile-menu.png')});
      await page.keyboard.press('Escape');
      assert.equal(await mobileMenu.count(), 0);
      await page.screenshot({ animations: 'disabled', path:resolve(output,copy.locale+'-mobile-dark.png')});
      await page.emulateMedia({colorScheme:'light'});
      await page.screenshot({ animations: 'disabled', path:resolve(output,copy.locale+'-mobile-light.png')});
      await body.getByRole('tab',{name:zh ? '流程' : 'Flow',exact:true}).click();
      await page.screenshot({animations:'disabled',path:resolve(output,copy.locale+'-mobile-flow.png')});
      assert.equal(await page.locator('style[data-plugin="dsh-plugin-sidebar-workbench"]').count(), 1)
      assert.equal(await page.locator('vite-error-overlay').count(), 0)
      assert.deepEqual(errors.filter(error => !error.startsWith('[deepseek-account] account read failed')), [])
      report.checks.push({ locale: copy.locale, result: 'passed', viewports: ['1440x1000', '390x844'],
        scenarios: ['native entry', 'real Host initialization', 'explicit demo', 'stage advance', 'cancel acknowledgment', 'four views', 'light/dark', '390px', '390px menu fits and closes'], errors })
    } catch (error) {
      await page.screenshot({ animations: 'disabled',  path: resolve(output, `${copy.locale}-failure.png`) })
      report.checks.push({ locale: copy.locale, result: 'failed', error: String(error), errors })
      throw error
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  await writeFile(resolve(output, uninstalled ? 'uninstalled-results.json' : 'browser-results.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))

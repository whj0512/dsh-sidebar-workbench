/** Shared helpers for keyless tests against an isolated, mutable DSH profile. */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** @returns A headless browser using the project's installed Playwright and local browser. */
export async function launchBrowser() {
  const { chromium } = createRequire(import.meta.url)('playwright')
  const executablePath = process.env.DSH_BROWSER_PATH ?? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
  ].find(existsSync)
  assert.ok(executablePath, 'Set DSH_BROWSER_PATH to an installed Chromium browser')
  return chromium.launch({ executablePath, headless: true })
}

/** @param page - Fresh Host page. Dismiss only the two known first-use prompts. */
export async function dismissStartup(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const dialog = page.getByRole('dialog')
    try { await dialog.waitFor({ state: 'visible', timeout: 2000 }) }
    catch (error) { if (error.name === 'TimeoutError') break; throw error }
    const name = await dialog.getAttribute('aria-label')
    assert.match(name ?? '', /^(预览版说明|Preview Notice|开始使用|Get started)$/)
    const next = dialog.getByRole('button', { name: /^(继续|Continue)$/ })
    if (await next.isVisible()) await next.click()
    else await dialog.getByRole('button', { name: /^(关闭|Close)$/ }).click()
    await page.getByRole('dialog', { name, exact: true }).waitFor({ state: 'hidden' })
  }
}

/** @param page - Host page. @param language - Persisted Host display language to select. */
export async function setLanguage(page, language) {
  await page.getByRole('button', { name: /^(账号菜单|Account menu)$/ }).click()
  await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^(设置|Settings)$/ })
  await dialog.getByRole('button', { name: /^(中文|English)$/ }).click()
  await page.getByRole('menuitem', { name: language, exact: true }).click()
  await dialog.getByRole('button', { name: /^(关闭|Close)$/ }).click()
}

/** @param page - Owner-authenticated test page. @param method - Public Remote method. @param request - Test-only request fields. @returns Validated success value. */
export async function rpc(page, method, request) {
  const reply = await page.evaluate(async ({ method, request }) => {
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })
    return response.json()
  }, { method, request })
  assert.equal(reply.result?.ok, true, JSON.stringify(reply))
  return reply.result.value
}

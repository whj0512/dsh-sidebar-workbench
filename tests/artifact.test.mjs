/** Evaluate the shipped factory protocol with the declared host-shared modules. */
import { readFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import * as zod from 'zod'
import * as React from 'react'

test('the client artifact registers a factory and requests only host-shared modules', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /["'`][A-Za-z]:[\\/]|\.\.\/deepseek-harness|node_modules/)
  const requests = []
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value } } } })
  assert.equal(registration.id, 'dsh-plugin-sidebar-workbench')
  const exports = registration.factory(name => {
    requests.push(name)
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button() {}, IconCodeOutlineRegular() {} }
    if (name === '@deepseek-ai/dsh-client-store') return { defineStore() {} }
    if (name === 'zod') return zod
    throw new Error(`Unexpected bundled runtime import: ${name}`)
  })
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject'])
  assert.ok(exports.inject.includes('uiWorkspace'), 'The model run view uses Host Session navigation')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(new Set(requests), new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', 'zod']))
  assert.doesNotMatch(source, /react\.production\.min|react\.development\.js|__SECRET_INTERNALS/, 'React must remain host-shared')
})

test('the host artifact is loadable ESM and declares its real data dependencies', async () => {
  const entry = await import('../lib/index.js')
  assert.deepEqual(Object.keys(entry).sort(), ['apply', 'inject'])
  assert.deepEqual(entry.inject, ['workspaceRegistry', 'storageDomain', 'typert', 'remoteAccess'])
  assert.equal(typeof entry.apply, 'function')
})

test('Flow and DSL ship as separately registered lazy client chunks', async () => {
  const entry = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const { files } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, symbol] of [['client.flow.js', 'renderFlow'], ['client.dsl.js', 'mountDslEditor']]) {
    assert.ok(files.includes('lib/' + name))
    assert.ok(entry.includes('./' + name))
    const code = await readFile(new URL('../lib/' + name, import.meta.url), 'utf8')
    let registration
    runInNewContext(code, { window: { __ModuleLoader__: { load: value => { registration = value } } } })
    assert.equal(registration.id, 'dsh-plugin-sidebar-workbench')
    assert.equal(registration.chunk, name)
    assert.equal(typeof registration.factory, 'function')
    assert.ok(code.includes(symbol))
  }
})

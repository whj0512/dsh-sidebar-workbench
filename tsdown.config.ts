/** Standalone compiler for the DSH 0.2.1-rc.3 module-factory protocol. */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const id = 'dsh-plugin-sidebar-workbench'
const cssPrefix = '\0workbench-css:'
const cssModules: TsdownPlugin = {
  name: 'workbench-css-modules',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css') && !source.endsWith('.module.css?inline')) return null
    if (!importer) throw new Error('A stylesheet must have an importing module')
    const file = resolve(dirname(importer), source.replace('?inline', ''))
    return cssPrefix + file + (source.endsWith('?inline') ? '?inline' : '') + '.mjs'
  },
  async load(source) {
    if (!source.startsWith(cssPrefix)) return null
    const request = source.slice(cssPrefix.length, -4)
    const file = request.replace('?inline', '')
    this.addWatchFile(file)
    const result = transform({ filename: basename(file), code: await readFile(file), minify: true, cssModules: true })
    const value = request.endsWith('?inline')
      ? result.code.toString()
      : Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, entry]) => [key, entry.name]))
    return `export default ${JSON.stringify(value)};`
  },
}

export default defineConfig([
  { entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2022', clean: false, dts: false, sourcemap: false,
    plugins: [{ name: 'host-standard-decorators', transform: { order: 'pre', handler(code, file) {
      if (!file.replaceAll('\\', '/').endsWith('/src/index.ts')) return null
      return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    } } }],
    deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools/pipeline', 'zod'] }, outputOptions: { entryFileNames: 'index.js' } },
  {
    entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser', clean: false,
    dts: false, sourcemap: false, minify: true, target: 'es2022', plugins: [cssModules],
    deps: { alwaysBundle: ['@antv/x6'], neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', 'zod'] },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])

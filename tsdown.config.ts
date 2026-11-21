/** Standalone compiler for the DSH 0.2.1-rc.3 module-factory protocol. */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { build, defineConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const id = 'dsh-plugin-sidebar-workbench'
const cssPrefix = '\0workbench-css:'
const cssModules: TsdownPlugin = {
  name: 'workbench-css-modules',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css') && !source.endsWith('.css?inline')) return null
    if (!importer) throw new Error('A stylesheet must have an importing module')
    const file = resolve(dirname(importer), source.replace('?inline', ''))
    return cssPrefix + file + (source.endsWith('?inline') ? '?inline' : '') + '.mjs'
  },
  async load(source) {
    if (!source.startsWith(cssPrefix)) return null
    const request = source.slice(cssPrefix.length, -4)
    const file = request.replace('?inline', '')
    this.addWatchFile(file)
    const result = transform({ filename: basename(file), code: await readFile(file), minify: true, cssModules: file.endsWith('.module.css') })
    const value = request.endsWith('?inline')
      ? result.code.toString()
      : Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, entry]) => [key, entry.name]))
    return `export default ${JSON.stringify(value)};`
  },
}

const sharedClientModules = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', 'zod',
]

const workbenchLazyChunks: TsdownPlugin = {
  name: 'workbench-lazy-chunks',
  transform(code, file) {
    if (!file.endsWith('ModelFileEditor.tsx') && !file.endsWith('ModelFlow.tsx')) return null
    return code
      .replace("import('./dsl/editor.ts')", 'require.async("./client.dsl.js")')
      .replace("import('./flow/render.ts')", 'require.async("./client.flow.js")')
  },
}

const monacoResources: TsdownPlugin = {
  name: 'workbench-monaco-resources',
  async resolveId(source, importer) {
    if (source === 'workbench:monaco-worker') return '\0workbench-monaco-worker'
    if (source === 'vscode-jsonrpc' || source === 'vscode-jsonrpc/browser') {
      return this.resolve('vscode-jsonrpc/browser.js', undefined, { skipSelf: true })
    }
    if (source === 'vscode-languageserver-protocol') {
      return this.resolve('vscode-languageserver-protocol/browser.js', undefined, { skipSelf: true })
    }
    if (source === 'monaco-editor') {
      return this.resolve('monaco-editor/esm/vs/editor/edcore.main.js', importer, { skipSelf: true })
    }
    if (importer && source.endsWith('.css')) return '\0workbench-monaco-css:' + resolve(dirname(importer), source) + '.mjs'
    return null
  },
  async load(source) {
    if (source === '\0workbench-monaco-worker') {
      const bundles = await build({
        entry: { worker: 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
        config: false, write: false, format: 'iife', platform: 'browser',
        minify: true, dts: false, report: false, logLevel: 'warn',
        deps: { alwaysBundle: [/.*/] }, outputOptions: { codeSplitting: false, name: 'WorkbenchMonacoWorker' },
      })
      try {
        const chunk = bundles.flatMap(bundle => bundle.chunks).find(item => item.type === 'chunk')
        if (!chunk || chunk.type !== 'chunk') throw new Error('Monaco worker output is missing')
        return `export default ${JSON.stringify(chunk.code)}`
      } finally {
        await Promise.all(bundles.map(bundle => bundle[Symbol.asyncDispose]()))
      }
    }
    const cssId = '\0workbench-monaco-css:'
    if (!source.startsWith(cssId)) return null
    const file = source.slice(cssId.length, -4)
    let css = await readFile(file, 'utf8')
    if (css.includes('url(./codicon.ttf)')) {
      const font = await readFile(resolve(dirname(file), 'codicon.ttf'))
      css = css.replace('url(./codicon.ttf)', `url(data:font/ttf;base64,${font.toString('base64')})`)
    }
    const registry = resolve('src/client/features/models/dsl/styles.ts').replaceAll('\\', '/')
    return `import { registerMonacoStyle } from ${JSON.stringify(registry)}; registerMonacoStyle(${JSON.stringify(css)})`
  },
}

function clientChunk(name: string, entry: string, plugins: TsdownPlugin[] = []) {
  return {
    entry: { [name]: entry }, outDir: 'lib', format: 'cjs' as const, platform: 'browser' as const,
    clean: false, dts: false, sourcemap: false, minify: true, target: 'es2022', plugins,
    deps: { alwaysBundle: [/.*/], neverBundle: sharedClientModules },
    outputOptions: {
      entryFileNames: name, codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, chunk: ${JSON.stringify(name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }
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
    dts: false, sourcemap: false, minify: true, target: 'es2022', plugins: [cssModules, workbenchLazyChunks],
    deps: { alwaysBundle: ['@antv/x6'], neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', 'zod'] },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
  clientChunk('client.flow.js', 'src/client/features/models/flow/render.ts'),
  clientChunk('client.dsl.js', 'src/client/features/models/dsl/editor.ts', [monacoResources]),
])

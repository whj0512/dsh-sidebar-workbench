import * as monaco from 'monaco-editor'
import type { EditorRender } from '../../../../shared/model-editor.ts'
import {
  bindLspSession,
  createCompositeCompletionProvider,
  createLspHoverProvider,
  unbindLspSession,
} from './languageFeatures.ts'
import { connectLsp } from './lspClient.ts'
import environment from './strategies/environment.ts'
import interaction from './strategies/interaction.ts'
import internalConstraints from './strategies/internalConstraints.ts'
import dialogMap from './strategies/dialogMap.ts'
import { mountMonacoStyles } from './styles.ts'
import workerSource from 'workbench:monaco-worker'

const strategies = {
  Environment: environment,
  ExternalScenario: interaction,
  Statechart: internalConstraints,
  DialogMap: dialogMap,
}
const registered = new Set<string>()
let nextDocument = 0

interface Options {
  kind: EditorRender['kind']
  endpoint?: string
  value: string
  readOnly: boolean
  label: string
  change: (text: string) => void
  connection: (connected: boolean) => void
}

export function mountDslEditor(container: HTMLElement, options: Options) {
  const strategy = strategies[options.kind]
  const { languageId } = strategy
  if (!registered.has(languageId)) {
    monaco.languages.register({ id: languageId })
    if (strategy.monarchTokensProviders)
      monaco.languages.setMonarchTokensProvider(
        languageId,
        strategy.monarchTokensProviders,
      )
    monaco.languages.registerCompletionItemProvider(
      languageId,
      createCompositeCompletionProvider(strategy),
    )
    monaco.languages.registerHoverProvider(languageId, createLspHoverProvider())
    registered.add(languageId)
  }

  const globals = globalThis as typeof globalThis & {
    MonacoEnvironment?: monaco.Environment
  }
  if (!globals.MonacoEnvironment?.getWorker) {
    globals.MonacoEnvironment = {
      ...globals.MonacoEnvironment,
      getWorker() {
        const url = URL.createObjectURL(
          new Blob([workerSource], { type: 'text/javascript' }),
        )
        try {
          return new Worker(url)
        } finally {
          URL.revokeObjectURL(url)
        }
      },
    }
  }

  const unmountStyles = mountMonacoStyles()
  const uri = monaco.Uri.parse(
    `file:///workbench/${languageId}/${++nextDocument}.dsl`,
  )
  const model = monaco.editor.createModel(options.value, languageId, uri)
  const editor = monaco.editor.create(container, {
    model,
    readOnly: options.readOnly,
    ariaLabel: options.label,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    theme: 'vs',
  })
  const session = options.endpoint
    ? connectLsp(
        options.endpoint,
        editor,
        monaco,
        languageId,
        uri.toString(),
        options.connection,
      )
    : undefined
  if (session) bindLspSession(model, session)
  let settingValue = false
  let accepted = options.value
  const content = model.onDidChangeContent(() => {
    if (settingValue) return
    const value = model.getValue()
    if (value.length > 1_000_000) {
      setValue(accepted)
      return
    }
    accepted = value
    options.change(value)
  })

  function setValue(value: string) {
    accepted = value
    if (model.getValue() === value) return
    settingValue = true
    try {
      model.setValue(value)
    } finally {
      settingValue = false
    }
  }

  return {
    setValue,
    setReadOnly: (readOnly: boolean) => editor.updateOptions({ readOnly }),
    reveal(index: number, length: number) {
      const start = model.getPositionAt(index)
      const end = model.getPositionAt(index + length)
      editor.setSelection(
        new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
      )
      editor.revealPositionInCenter(start)
      editor.focus()
    },
    dispose() {
      if (session) {
        unbindLspSession(model, session)
        session.dispose()
      }
      content.dispose()
      editor.dispose()
      model.dispose()
      unmountStyles()
    },
  }
}

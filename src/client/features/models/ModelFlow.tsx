import { useEffect, useRef, useState } from 'react'
import type { Cell, Graph } from '@antv/x6'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorGraph, EditorLayout, EditorRender } from '../../../shared/model-editor.ts'
import css from './ModelingPanel.module.css'

type Props = {
  t: TranslateNS<'sidebarWorkbench'>
  file: string
  data: EditorRender
  legacy?: EditorGraph
  layout: EditorLayout
  element: string
  editable: boolean
  select: (name: string) => void
  move: (key: string, position: EditorLayout[string]) => void
}

export function ModelFlow(props: Props) {
  const { t, file, data, legacy, element } = props
  const viewport = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  const canvas = useRef<{ graph: Graph; canvasData?: object; names: Map<Cell, string[]> }>()
  const [elements, setElements] = useState<string[]>([])
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState('')
  useEffect(() => { latest.current = props }, [props])

  useEffect(() => {
    let alive = true
    let observer: ResizeObserver | undefined
    let graph: Graph | undefined
    setFailed(false)
    void import('./flow/render.ts').then(runtime => {
      const target = container.current
      const frame = viewport.current
      if (!alive || !target || !frame) return
      const rendered = runtime.renderFlow(target, data, () => latest.current.editable)
      graph = rendered.graph
      const names = new Map(graph.getCells().map(cell => [cell, runtime.flowElementNames(cell)]))
      const legacyNames = new Map<string, string[]>()
      for (const node of legacy?.nodes ?? []) {
        legacyNames.set(node.element, [...legacyNames.get(node.element) ?? [], node.id])
      }
      const legacyKeys = new Map<string, string>()
      for (const [cell, labels] of names) {
        const id = labels.length === 1 ? legacyNames.get(labels[0]!) : undefined
        if (id?.length === 1) legacyKeys.set(cell.id, id[0]!)
      }
      runtime.applyFlowLayout(graph, latest.current.layout, legacyKeys)
      canvas.current = { ...rendered, names }
      const counts = new Map<string, number>()
      for (const labels of names.values()) {
        for (const name of labels) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      setElements([...counts].filter(([, count]) => count === 1).map(([name]) => name))
      graph.on('cell:click', ({ cell, e }) => {
        setSelected(cell.id)
        const labels = names.get(cell) ?? []
        const widget = e.target instanceof Element ? e.target.closest('[data-widget-id]')?.getAttribute('data-widget-id') : undefined
        latest.current.select(widget && counts.get(widget) === 1 ? widget : labels.find(label => counts.get(label) === 1) ?? '')
      })
      graph.on('blank:click', () => {
        setSelected('')
        latest.current.select('')
      })
      graph.on('node:moved', ({ node }) => {
        if (!latest.current.editable) return
        const key = runtime.layoutKey(node)
        if (key.length > 400 || rendered.graph.getNodes().filter(other => runtime.layoutKey(other) === key).length !== 1) return
        const position = node.position()
        const clamp = (n: number) => Math.max(-50_000, Math.min(50_000, n))
        const bounded = { x: clamp(position.x), y: clamp(position.y) }
        if (bounded.x !== position.x || bounded.y !== position.y) node.position(bounded.x, bounded.y)
        latest.current.move(key, bounded)
      })
      observer = new ResizeObserver(() => graph?.resize(frame.clientWidth, frame.clientHeight))
      observer.observe(frame)
      graph.zoomToFit({ padding: 24, maxScale: 1 })
    }).catch(() => {
      if (alive) {
        graph?.dispose()
        graph = undefined
        canvas.current = undefined
        setFailed(true)
      }
    })
    return () => {
      alive = false
      observer?.disconnect()
      graph?.dispose()
      canvas.current = undefined
    }
  }, [data, legacy])

  useEffect(() => {
    const current = canvas.current
    if (!current) return
    const matches = element ? [...current.names].filter(([, names]) => names.includes(element)) : []
    const cell = matches.length === 1 ? matches[0]?.[0] : undefined
    if (element) setSelected(cell?.id ?? '')
    if (cell && cell.id !== selected) current.graph.centerCell(cell)
  }, [elements, element, selected])

  useEffect(() => {
    const cell = canvas.current?.graph.getCellById(selected)
    const view = cell ? canvas.current?.graph.findViewByCell(cell) : undefined
    view?.container.classList.add('workbench-flow-selected')
    const widget = [...view?.container.querySelectorAll('[data-widget-id]') ?? []]
      .find(row => row.getAttribute('data-widget-id') === element)
    widget?.classList.add('workbench-flow-widget-selected')
    return () => {
      view?.container.classList.remove('workbench-flow-selected')
      widget?.classList.remove('workbench-flow-widget-selected')
    }
  }, [elements, selected, element])

  const download = () => {
    const current = canvas.current
    if (!current) return
    const { cells } = current.graph.toJSON()
    const blob = new Blob([JSON.stringify({
      nodes: cells.filter(cell => !('source' in cell)),
      edges: cells.filter(cell => 'source' in cell),
      canvasData: current.canvasData,
    }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${file.split('/').at(-1)?.replace(/\.dsl$/i, '') ?? 'model'}.flow.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const ready = !!canvas.current
  return (
    <div className={css.flowPane}>
      <div className={css.flowToolbar}>
        <Button
          variant="outline"
          disabled={!ready}
          aria-label={t('modelEditorZoomOut')}
          onClick={() => canvas.current?.graph.zoom(-0.2)}
        >
          −
        </Button>
        <Button
          variant="outline"
          disabled={!ready}
          aria-label={t('modelEditorZoomIn')}
          onClick={() => canvas.current?.graph.zoom(0.2)}
        >
          +
        </Button>
        <Button
          variant="outline"
          disabled={!ready}
          onClick={() => canvas.current?.graph.zoomToFit({ padding: 24, maxScale: 1 })}
        >
          {t('modelEditorFit')}
        </Button>
        <Button
          variant="outline"
          disabled={!ready}
          onClick={download}
        >
          {t('modelEditorExport')}
        </Button>
        <select
          aria-label={t('modelEditorSelectElement')}
          value={elements.includes(element) ? element : ''}
          onChange={event => {
            setSelected('')
            props.select(event.target.value)
          }}
        >
          <option value="">
            {t('modelEditorSelectElement')}
          </option>
          {elements.map(name => (
            <option
              key={name}
              value={name}
            >
              {name}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p
          role="alert"
          className={css.error}
        >
          {t('modelingError_converter-response')}
        </p>
      )}
      <div
        className={`${css.flowCanvas} workbench-baic-flow`}
        aria-label={t('modelEditorFlow')}
        ref={viewport}
      >
        <div
          className={css.flowSurface}
          ref={container}
        />
      </div>
    </div>
  )
}

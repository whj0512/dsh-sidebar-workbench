import { useEffect, useRef, useState } from 'react'
import type { Graph } from '@antv/x6'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorGraph, EditorLayout } from '../../../shared/model-editor.ts'
import css from './ModelingPanel.module.css'

type Props = {
  t: TranslateNS<'sidebarWorkbench'>
  data: EditorGraph
  layout: EditorLayout
  selected: string
  select: (id: string) => void
  move: (id: string, position: EditorLayout[string]) => void
}

export function ModelFlow({ t, data, layout, selected, select, move }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<Graph | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const latest = useRef({ move, select, layout })
  useEffect(() => { latest.current = { move, select, layout } }, [move, select, layout])
  useEffect(() => {
    let alive = true
    let observer: ResizeObserver | undefined
    setReady(false)
    setFailed(false)
    void import('@antv/x6').then(({ Graph }) => {
      if (!alive || !container.current) return
      const element = container.current
      const graph = new Graph({
        container: element, width: element.clientWidth, height: element.clientHeight, panning: true,
        mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: 0.15, maxScale: 2.5 },
        interacting: { edgeMovable: false, arrowheadMovable: false, vertexMovable: false, vertexAddable: false, vertexDeletable: false },
      })
      canvas.current = graph
      const styles = getComputedStyle(element)
      const accent = styles.getPropertyValue('--workbench-accent').trim() || '#1d65bd'
      const surface = styles.getPropertyValue('--dsw-alias-bg-base').trim() || '#fff'
      for (const item of data.nodes) {
        const position = latest.current.layout[item.id] ?? item
        graph.addNode({ id: item.id, x: position.x, y: position.y, shape: 'rect', width: 148, height: 54, label: item.label,
          attrs: { body: { fill: surface, stroke: accent, rx: 8, ry: 8 }, label: { fill: accent, fontSize: 12, textWrap: { width: -16, height: -8, ellipsis: true } } },
        })
      }
      for (const item of data.edges) {
        graph.addEdge({ id: item.id, source: item.source, target: item.target, label: item.label,
          router: { name: 'orth' }, connector: { name: 'rounded' }, attrs: { line: {
            stroke: accent, strokeWidth: 1.5, ...(item.type === 'contains' ? { strokeDasharray: '4 4', targetMarker: null } : {}),
          } },
        })
      }
      graph.on('cell:click', ({ cell }) => latest.current.select(cell.id))
      graph.on('blank:click', () => latest.current.select(''))
      graph.on('node:moved', ({ node }) => latest.current.move(node.id, node.position()))
      observer = new ResizeObserver(() => graph.resize(element.clientWidth, element.clientHeight))
      observer.observe(element)
      graph.zoomToFit({ padding: 24, maxScale: 1 })
      setReady(true)
    }).catch(() => { if (alive) setFailed(true) })
    return () => {
      alive = false
      observer?.disconnect()
      canvas.current?.dispose()
      canvas.current = null
    }
  }, [data])
  useEffect(() => {
    const graph = canvas.current
    if (!ready || !graph) return
    for (const node of graph.getNodes()) node.attr('body/strokeWidth', node.id === selected ? 3 : 1)
    for (const edge of graph.getEdges()) edge.attr('line/strokeWidth', edge.id === selected ? 3 : 1.5)
    const cell = graph.getCellById(selected)
    if (cell) graph.centerCell(cell)
  }, [ready, selected, data])
  return (
    <div className={css.flowPane}>
      <div className={css.actions}>
        <Button
          className={css.secondary}
          variant="outline"
          disabled={!ready}
          onClick={() => canvas.current?.zoom(-0.2)}
        >
          −
        </Button>
        <Button
          className={css.secondary}
          variant="outline"
          disabled={!ready}
          onClick={() => canvas.current?.zoom(0.2)}
        >
          +
        </Button>
        <Button
          className={css.secondary}
          variant="outline"
          disabled={!ready}
          onClick={() => canvas.current?.zoomToFit({ padding: 24, maxScale: 1 })}
        >
          {t('modelEditorFit')}
        </Button>
        <select
          aria-label={t('modelEditorFields')}
          value={selected}
          onChange={event => select(event.target.value)}
        >
          <option value="">
            {t('modelEditorSelectElement')}
          </option>
          {[...data.nodes, ...data.edges].filter(cell => cell.element).map(cell => (
            <option
              key={cell.id}
              value={cell.id}
            >
              {cell.label}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p
          role="alert"
          className={css.error}
        >
          {t('modelingError_unavailable')}
        </p>
      )}
      <div
        className={css.flowCanvas}
        aria-label={t('modelEditorFlow')}
        ref={container}
      />
    </div>
  )
}

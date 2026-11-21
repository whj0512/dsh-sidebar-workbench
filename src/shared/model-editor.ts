import { z } from 'zod'

export const editorId = z.string().uuid()
export const editorHash = z.string().regex(/^[a-f0-9]{64}$/)
export const editorFile = z.string().min(1).max(800)
export const editorText = z.string().max(1_000_000)
const coordinate = z.number().finite().min(-50_000).max(50_000)
export const editorLayout = z.record(z.string().max(400), z.object({ x: coordinate, y: coordinate }).strict())
const field = z.object({ key: z.string(), value: z.string(), options: z.array(z.object({ value: z.string(), label: z.string() })).optional() }).strict()
const cell = z.object({
  id: z.string(), label: z.string(), element: z.string(), type: z.string(), fields: z.array(field),
}).strict()
export const editorGraph = z.object({
  nodes: z.array(cell.extend({ x: coordinate, y: coordinate })).max(1000),
  edges: z.array(cell.extend({ source: z.string(), target: z.string() })).max(2000),
}).strict()
export type EditorGraph = z.infer<typeof editorGraph>
export type EditorLayout = z.infer<typeof editorLayout>
export const editorChange = z.object({ cell: z.string().max(400), field: z.string().max(80), value: z.string().max(4000) }).strict()
export const editorDraft = z.object({ text: editorText, changes: z.array(editorChange).max(1000) }).strict()
export type EditorDraft = z.infer<typeof editorDraft>
const revision = z.object({ id: editorId, path: z.string(), createdAt: z.string() }).strict()
const renderKind = z.enum(['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'])
export const languageServiceUrlsSchema = z.partialRecord(renderKind, z.string().max(2048).transform((value, ctx) => {
  try {
    const url = new URL(value)
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.hash) return url.href
  } catch { /* Report invalid WebSocket addresses through the schema. */ }
  ctx.addIssue({ code: 'custom', message: 'Expected a ws:// or wss:// URL without credentials or a fragment' })
  return z.NEVER
}))
export type LanguageServiceUrls = z.infer<typeof languageServiceUrlsSchema>
const editorRender = z.object({ kind: renderKind, data: z.string().max(8_000_000) }).strict()
export type EditorRender = z.infer<typeof editorRender>
export const editorResult = z.object({
  file: editorFile.optional(), text: editorText.optional(), hash: editorHash.optional(),
  graph: editorGraph.optional(), render: editorRender.optional(), languageServiceUrl: z.string().optional(), layout: editorLayout.optional(),
  revisions: z.array(revision).optional(), latest: editorId.nullable().optional(),
  adopted: editorId.nullable().optional(), publication: z.number().int().nonnegative().optional(),
  revision: revision.optional(), map: z.string().optional(), review: z.array(z.string()).optional(),
}).strict()
export type EditorResult = z.infer<typeof editorResult>

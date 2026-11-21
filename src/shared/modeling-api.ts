import { z } from 'zod'
import { problemSchema } from './project.ts'
import { editorDraft, editorFile, editorHash, editorId, editorLayout, editorResult } from './model-editor.ts'

export const modelingStages = ['snapshot', 'parse', 'Environment', 'ExternalScenario', 'Statechart', 'DialogMap', 'validate', 'publish', 'finished'] as const
export const modelKinds = ['Environment', 'ExternalScenario', 'Statechart', 'DialogMap'] as const
export type ModelKind = typeof modelKinds[number]
const scope = z.object({ sessionId: z.string().min(1), workspaceId: z.string().min(1) })
const runId = z.string().uuid()
const editorScope = scope.extend({ runId, revisionId: editorId.nullable() })
const editorEdit = editorScope.extend({ file: editorFile, hash: editorHash, draft: editorDraft })
export const modelingCommandSchema = z.discriminatedUnion('action', [
  scope.extend({ action: z.literal('inspect') }).strict(),
  scope.extend({ action: z.literal('start'), baselineId: runId, featureId: runId, requestKey: runId }).strict(),
  scope.extend({ action: z.enum(['cancel', 'reconcile', 'delete-run']), runId }).strict(),
  scope.extend({ action: z.literal('artifact'), runId, path: z.string().min(1) }).strict(),
  editorScope.extend({ action: z.literal('editor-open'), file: editorFile }).strict(),
  editorEdit.extend({ action: z.literal('editor-convert') }).strict(),
  editorEdit.extend({ action: z.literal('editor-save'), layout: editorLayout, expectedLatest: editorId.nullable() }).strict(),
  editorScope.extend({ action: z.literal('editor-adopt'), revisionId: editorId, publication: z.number().int().nonnegative() }).strict(),
])
export type ModelingCommand = z.infer<typeof modelingCommandSchema>
export type ModelingAction = ModelingCommand extends infer Command
  ? Command extends ModelingCommand ? Omit<Command, 'sessionId' | 'workspaceId'> : never : never
export const modelArtifactSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const state = z.enum(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'])
export const modelProblemSchema = problemSchema.or(z.enum(['unreviewed', 'changed', 'validation', 'executor', 'skill-unavailable', 'model', 'credentials', 'timeout',
  'converter-unavailable', 'converter-response', 'converter-dialect', 'converter-loss', 'run-not-deletable', 'host-upgrade-required']))
export type ModelProblem = z.infer<typeof modelProblemSchema>
const feature = z.object({ id: runId, name: z.string(), requirementId: z.string().nullable(), section: z.string().optional() }).strict()
const summary = z.object({
  id: runId, baselineId: runId, materialLabel: z.string(), feature, executionSessionId: z.string().optional(),
  state, stage: z.enum(modelingStages), sequence: z.number().int().positive(), updatedAt: z.string(),
  problem: modelProblemSchema.optional(), detail: z.string().optional(), artifacts: z.array(modelArtifactSchema),
  dialogApplicable: z.boolean().optional(), completed: z.array(z.enum(modelingStages)),
  gaps: z.number().int().nonnegative().optional(), relationIssues: z.number().int().nonnegative().optional(),
  validationIssues: z.number().int().nonnegative().optional(),
})
export const modelingRunSchema = summary.extend({
  schema: z.literal(1), projectId: runId, bindingRevision: z.number().int().positive(), root: z.string(),
  deletedAt: z.string().optional(),
  expectedRelationRevision: z.number().int().nonnegative(), seedSha256: z.string(), sourceSha256: z.string(),
  request: z.object({ sessionId: z.string(), workspaceId: z.string(), requestKey: runId }).strict(),
}).strict()
export type ModelingRun = z.infer<typeof modelingRunSchema>
export const modelingResultSchema = z.object({
  ok: z.boolean(), problem: modelProblemSchema.optional(), detail: z.string().optional(),
  available: z.boolean().optional(), baseline: z.object({ id: runId, label: z.string() }).strict().nullable().optional(),
  features: z.array(feature).optional(), pollIntervalMs: z.number().optional(), acceptedRunId: runId.optional(),
  deletedRunId: runId.optional(),
  runs: z.array(summary.extend({ stale: z.boolean(), currentEditorRevision: editorId.optional() }).strict()).optional(), content: z.string().optional(),
  editor: editorResult.optional(),
}).strict()
export type ModelingResult = z.infer<typeof modelingResultSchema>
export type ModelingRunView = NonNullable<ModelingResult['runs']>[number]
export function modelRunActive(state: ModelingRun['state']): boolean {
  return state === 'queued' || state === 'running' || state === 'cancelling'
}

export function modelRunDeletable(state: ModelingRun['state']): boolean {
  return state === 'succeeded' || state === 'failed'
}

export function modelRunUnsettled(state: ModelingRun['state']): boolean {
  return modelRunActive(state) || state === 'interrupted'
}

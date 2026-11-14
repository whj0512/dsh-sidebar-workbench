/** Immutable itemization references. Material versions and generated candidates have separate identities. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RunId } from './workflow.ts'

export type MaterialVersionId = Branded<'WorkbenchMaterialVersionId'>
export type CandidateId = Branded<'WorkbenchCandidateId'>
const materialId = z.string().uuid().transform(value => value as MaterialVersionId)
const candidateId = z.string().uuid().transform(value => value as CandidateId)
const runId = z.string().uuid().transform(value => value as RunId)

export const materialVersionSchema = z.object({
  id: materialId, label: z.string().trim().min(1),
  original: z.string().min(1), markdown: z.string().min(1),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/), markdownSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assets: z.array(z.object({ reference: z.string(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).optional(),
}).strict()
export type MaterialVersion = z.infer<typeof materialVersionSchema>

export const candidateReferenceSchema = z.object({
  id: candidateId, materialId, runId,
  parentCandidateId: candidateId.optional(),
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
}).strict()
export type CandidateReference = z.infer<typeof candidateReferenceSchema>

export const itemizationStateSchema = z.object({
  schema: z.literal(1), projectId: z.string().uuid(), revision: z.number().int().positive(),
  materials: z.array(materialVersionSchema), candidates: z.array(candidateReferenceSchema),
  baseline: candidateId.nullable(),
  adoption: z.object({ candidateId, previousCandidateId: candidateId.nullable(),
    impact: z.array(z.string()), acceptedAt: z.string(), matches: z.array(z.object({ previous: z.string(), candidate: z.string() }).strict()).optional(),
    confirmedUnmatched: z.boolean().optional(), approvalReason: z.string().optional() }).strict().optional(),
}).strict()
export type ItemizationState = z.infer<typeof itemizationStateSchema>

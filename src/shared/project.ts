/** Versioned wire and disk schemas. Unknown versions fail closed; no Session format is changed. */
import { z } from 'zod'

export const materialSchema = z.object({ original: z.string().min(1), markdown: z.string().min(1), version: z.string().min(1), sameVersion: z.literal(true) }).strict()
export const manifestSchema = z.object({ schema: z.literal(1), projectId: z.string().uuid(), baseline: z.string().nullable(),
  materials: materialSchema.nullable(), artifacts: z.array(z.string()), createdAt: z.string(), validation: z.literal('not-checked') }).strict()
export type ProjectManifest = z.infer<typeof manifestSchema>
export const bindingSchema = z.object({ workspaceId: z.string(), projectId: z.string().uuid(), revision: z.number().int().positive(), root: z.string(),
  status: z.enum(['active', 'removed']), unsettledRuns: z.array(z.string()) }).strict()
export type ProjectBinding = z.infer<typeof bindingSchema>
export const commandSchema = z.object({
  action: z.enum(['inspect', 'initialize', 'discover', 'adopt', 'relink']),
  sessionId: z.string().min(1), workspaceId: z.string().min(1),
  materials: materialSchema.optional(), expectedProjectId: z.string().uuid().optional(),
}).strict()
export type ProjectCommand = z.infer<typeof commandSchema>
export const problemSchema = z.enum(['unbound', 'directory', 'permission', 'escape', 'identity', 'conflict', 'relink', 'unsettled', 'materials', 'storage', 'unavailable', 'invalid'])
export type ProjectProblem = z.infer<typeof problemSchema>
export const resultSchema = z.object({
  ok: z.boolean(), problem: problemSchema.optional(), project: manifestSchema.optional(), binding: bindingSchema.optional(),
  discovered: z.array(z.object({ path: z.string(), status: z.enum(['recognized', 'missing', 'unsupported']), validation: z.literal('not-checked') })).optional(),
}).strict()
export type ProjectResult = z.infer<typeof resultSchema>

/** Owner-only itemization commands and durable execution facts shared by Host and Client. */
import { z } from 'zod'
import { materialSchema, problemSchema } from './project.ts'
import { itemizationStateSchema } from './itemization.ts'

export const itemizationConfigSchema = z.object({
  pythonExecutable: z.string().min(1).default('python'), executionPreset: z.string().min(1).optional(),
  // Accept previously deployed profiles. The Host registry now owns skill discovery.
  originalSkillsDirectory: z.string().min(1).optional(),
  shellToolName: z.string().min(1).default('bash'),
  subagentProvider: z.string().min(1).default('spawn'),
  maxSubagentDepth: z.number().int().positive().default(4),
  agentSkillAliases: z.record(z.string(), z.string()).default({ requirement_index_parser: 'requirement-chunk-segment', requirement_document_extractor: 'requirement-chunk-extract' }),
  reviewHolds: z.array(z.object({ markdownSha256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1) }).strict()).default([]),
  candidateApprovals: z.array(z.object({
    projectId: z.string().uuid(), candidateId: z.string().uuid(), reason: z.string().trim().min(1),
  }).strict()).default([]),
  operationTimeoutMs: z.number().int().positive().max(2147483647).default(1200000),
  modelingStageTimeoutMs: z.number().int().positive().max(2147483647).default(3600000),
  terminationGraceMs: z.number().int().positive().max(2147483647).default(5000),
  // Compatibility with profiles that set an output limit for the former Python runner.
  maxOutputBytes: z.number().int().positive().optional(),
  maxSourceReadChars: z.number().int().positive().default(24000),
  maxConcurrentItemizations: z.number().int().positive().default(1),
  // Accepted for existing profile files; original-skill execution has no submission counter.
  maxCandidateSubmissions: z.number().int().positive().optional(),
  maxModelOutputTokens: z.number().int().positive().default(65536),
  pollIntervalMs: z.number().int().positive().default(2000),
}).strict().transform(({ originalSkillsDirectory: _legacyDirectory, maxOutputBytes: _legacyOutputLimit, ...config }) => config)
export type ItemizationConfig = z.infer<typeof itemizationConfigSchema>
export const itemizationCommandSchema = z.object({
  action: z.enum(['inspect', 'start', 'cancel', 'reconcile', 'delete-run', 'candidate', 'compare', 'adopt']),
  sessionId: z.string().min(1), workspaceId: z.string().min(1),
  requestKey: z.string().uuid().optional(), materials: materialSchema.optional(),
  runId: z.string().uuid().optional(), candidateId: z.string().uuid().optional(),
  parentCandidateId: z.string().uuid().optional(), feedback: z.string().max(20000).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  matches: z.array(z.object({ previous: z.string().uuid(), candidate: z.string().uuid() }).strict()).optional(),
  confirmUnmatched: z.boolean().optional(), impactFingerprint: z.string().optional(),
}).strict()
export type ItemizationCommand = z.infer<typeof itemizationCommandSchema>
export const itemizationRunSchema = z.object({
  schema: z.literal(1), id: z.string().uuid(), workspaceId: z.string(), projectId: z.string().uuid(),
  bindingRevision: z.number().int().positive(), root: z.string(), requestKey: z.string().uuid(), fingerprint: z.string(),
  materialId: z.string().uuid(), candidateId: z.string().uuid(), parentCandidateId: z.string().uuid().optional(),
  comparisonBaseCandidateId: z.string().uuid().optional(),
  operation: z.enum(['initial', 'adjustment', 'new-version']).optional(),
  feedback: z.string(), sessionId: z.string().optional(),
  state: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']),
  stage: z.enum(['snapshot', 'original', 'segment', 'validate', 'extract', 'relations', 'publish', 'finished']),
  sequence: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  problem: z.string().optional(), artifacts: z.array(z.string()), deletedAt: z.string().optional(),
}).strict()
export type ItemizationRun = z.infer<typeof itemizationRunSchema>

/** @param state - Persisted run state. @returns Whether the run reached a final execution state. */
export function isTerminalItemizationState(state: ItemizationRun['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export const itemizationResultSchema = z.object({
  ok: z.boolean(), problem: problemSchema.or(z.enum(['changed', 'validation', 'executor', 'skill-unavailable', 'model', 'output-limit', 'credentials', 'timeout', 'conflict', 'unreviewed', 'source-conflict', 'run-not-settled'])).optional(),
  available: z.boolean().optional(), pollIntervalMs: z.number().optional(),
  state: itemizationStateSchema.optional(), runs: z.array(itemizationRunSchema).optional(),
  content: z.string().optional(), comparison: z.string().optional(), impactFingerprint: z.string().optional(),
}).strict()
export type ItemizationResult = z.infer<typeof itemizationResultSchema>

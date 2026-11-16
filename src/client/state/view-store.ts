/** Plugin-lifetime navigation, selections and drafts keyed by Session, tab and workspace. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EditorDraft, EditorLayout } from '../../shared/model-editor.ts'

export type ModelFileDraft = { draft: EditorDraft; layout: EditorLayout; hash: string; expectedLatest: string | null }

export type Page = 'flow' | 'review' | 'features' | 'run' | 'modeling-run' | 'models' | 'tests' | 'graph' | 'confirm' | 'settings' | 'artifacts'
export interface View {
  page: Page
  demo: boolean
  feature: string
  selected: string[]
  draft: string
  itemizationFeedback: string
  search: string
  scenario: 'success' | 'alignment' | 'missing' | 'unknown' | 'submitted' | 'empty' | 'failure'
  operation: 'upload' | 'infer'
  model: string
  original: string
  markdown: string
  version: string
  sameVersion: boolean
  modelingSelection?: { baselineId: string; featureIds: string[] }
  modelingRun?: string
  modelingSearch?: string
  modelingFilter?: 'all' | 'current' | 'attention'
  modelingDrafts?: Record<string, ModelFileDraft>
  modelingEditors?: Record<string, { file: string; revisionId: string | null; mode: 'dsl' | 'flow' }>
}
export const initialView: View = { page: 'flow', demo: false, feature: 'OnePedal', selected: ['OnePedal'], draft: '', itemizationFeedback: '', search: '', scenario: 'success', operation: 'upload', model: 'Environment', original: '', markdown: '', version: '', sameVersion: false }

/** @returns Root-scoped state with a separate bucket for each Session/tab/workspace tuple. */
export function createViewStore() {
  return defineStore({
    init: (): { views: Record<string, View> } => ({ views: {} }),
    actions: {
      change(draft: { views: Record<string, View> }, key: string, patch: Partial<View>, fallback = initialView) {
        draft.views[key] = { ...(draft.views[key] ?? fallback), ...patch }
      },
    },
  })
}
export type ViewStore = ReturnType<typeof createViewStore>

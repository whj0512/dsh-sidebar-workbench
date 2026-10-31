/** Plugin-lifetime navigation, selections and drafts keyed by Session, tab and workspace. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

export type Page = 'flow' | 'review' | 'features' | 'run' | 'models' | 'tests' | 'graph' | 'confirm' | 'settings' | 'artifacts'
export interface View {
  page: Page
  demo: boolean
  feature: string
  selected: string[]
  draft: string
  search: string
  scenario: 'success' | 'alignment' | 'missing' | 'unknown' | 'submitted' | 'empty' | 'failure'
  operation: 'upload' | 'infer'
  model: string
  original: string
  markdown: string
  version: string
  sameVersion: boolean
}
export const initialView: View = { page: 'flow', demo: false, feature: 'OnePedal', selected: ['OnePedal'], draft: '', search: '', scenario: 'success', operation: 'upload', model: 'Environment', original: '', markdown: '', version: '', sameVersion: false }

/** @returns Root-scoped state with a separate bucket for each Session/tab/workspace tuple. */
export function createViewStore() {
  return defineStore({
    init: (): { views: Record<string, View> } => ({ views: {} }),
    actions: {
      change(draft: { views: Record<string, View> }, key: string, patch: Partial<View>) {
        draft.views[key] = { ...(draft.views[key] ?? initialView), ...patch }
      },
    },
  })
}
export type ViewStore = ReturnType<typeof createViewStore>

/** Read-only selection over chronological run snapshots. */
import type { Run } from '../../shared/workflow.ts'

/** @param runs - Oldest-first runs. @param matches - Selection predicate. @returns Latest match without copying or reordering runs. */
export function latestRun(runs: readonly Run[], matches: (run: Run) => boolean): Run | undefined {
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    if (matches(run)) return run
  }
  return undefined
}

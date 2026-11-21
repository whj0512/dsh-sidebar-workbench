import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelingAction, ModelingResult } from '../../../shared/modeling-api.ts'

/** Keep deletion protocol failures visible when a rebuilt Client reaches an older Host. */
export function modelingResponse(action: ModelingAction, response: RemoteResult<ModelingResult>): ModelingResult {
  if (response.ok) {
    const result = response.value
    if (action.action === 'delete-run' && result.ok && result.deletedRunId !== action.runId
      && (!result.runs || result.runs.some(run => run.id === action.runId))) {
      return { ok: false, problem: 'host-upgrade-required' }
    }
    return result
  }
  const { code } = response.error
  if (action.action === 'delete-run' && (code === 'gateway/input-invalid' || code === 'gateway/method-unavailable')) {
    return { ok: false, problem: 'host-upgrade-required', detail: code }
  }
  throw new Error(code)
}

/** Interpret workspace file responses without treating an incompatible Host as an empty directory. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectResult } from '../../../shared/project.ts'

/** The running Host does not accept or return the file lookup protocol. */
export class FileLookupVersionError extends Error {}

/** @param response - Validated Remote response. @returns File candidates, including a genuinely empty directory. */
export function materialFiles(response: RemoteResult<ProjectResult>): NonNullable<ProjectResult['files']> {
  if (!response.ok) {
    if (response.error.code === 'gateway/input-invalid') throw new FileLookupVersionError('File lookup protocol mismatch')
    throw new Error(response.error.code)
  }
  if (!response.value.ok) throw new Error(response.value.problem)
  if (!response.value.files) throw new FileLookupVersionError('Missing file lookup result')
  return response.value.files
}

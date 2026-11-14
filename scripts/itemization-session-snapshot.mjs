/** Capture exact original-skill model inputs and tool exchange from a recorded Session. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** @param home - Explicit isolated Harness home. @param sessionId - Recorded execution identity. @param runId - Expected owning run. @returns Exact model-visible exchange with paths retained for audit. */
export async function itemizationSessionSnapshot(home, sessionId, runId) {
  let events
  for (const parent of await readdir(join(home, 'sessions'))) {
    const directory = join(home, 'sessions', parent, sessionId)
    let files
    try { files = await readdir(directory) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const file = files.filter(name => /^session\.v\d+\.jsonl\.zstd$/.test(name))
      .sort((a, b) => Number(a.match(/v(\d+)/)[1]) - Number(b.match(/v(\d+)/)[1])).at(-1)
    if (file) events = zstdDecompressSync(await readFile(join(directory, file))).toString('utf8').trim().split('\n').map(JSON.parse)
  }
  if (!events) throw new Error('Recorded itemization Session not found')
  const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'workbench-itemization')
  if (!user) throw new Error('Missing logged itemization input')
  if (user.data.source.runId !== runId) throw new Error('Recorded itemization run does not match')
  const original = events.find(event => event.type === 'user/message' && event.data.source.kind === 'workbench-original-skill')
  if (!original) throw new Error('Session uses the legacy adapted workflow; original-skill context is missing')
  return {
    schema: 2,
    workflow: 'original-skills',
    producer: user.data.source.kind,
    input: user.data.content,
    originalContext: original.data.content,
    feedback: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'workbench-itemization-feedback').map(event => event.data.content),
    headers: events.filter(event => event.type === 'request/header').map(event => event.data.header),
    calls: events.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: JSON.parse(event.data.arguments) })),
    results: events.filter(event => event.type === 'tool/result').map(event => ({ isError: event.data.message.isError,
      content: event.data.message.content })),
    finish: events.filter(event => event.type === 'turn/end').at(-1)?.data.reason,
  }
}

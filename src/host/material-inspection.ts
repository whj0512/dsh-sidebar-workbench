/** Bounded, read-only format inspection. Format validity does not establish document version equivalence. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { unzipSync } from 'fflate'
import { XMLValidator, XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import type { ProjectResource } from '../shared/project.ts'

const configSchema = z.object({ maxMaterialBytes: z.number().int().positive().default(64 * 1024 * 1024),
  maxDocumentXmlBytes: z.number().int().positive().default(16 * 1024 * 1024),
  maxProjectScanEntries: z.number().int().positive().default(100000) }).strict()
export type ProjectConfig = z.infer<typeof configSchema>
/** @param input - Plugin config from cordis.yml. @returns Validated resource limits. */
export function resolveProjectConfig(input: unknown): ProjectConfig { return configSchema.parse(input ?? {}) }

/** @param bytes - Bounded file bytes. @param path - Relative filename. @param limits - Validated limits. @returns Basic file structure validity, not semantic validation. */
async function validFormat(bytes: Uint8Array, path: string, limits: ProjectConfig): Promise<boolean> {
  if (/\.pdf$/i.test(path)) {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
    return !document.isEncrypted && document.getPageCount() > 0
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  if (/\.docx$/i.test(path)) {
    const names = ['[Content_Types].xml', 'word/document.xml']
    const entries = unzipSync(bytes, { filter: entry => names.includes(entry.name) && entry.originalSize <= limits.maxDocumentXmlBytes })
    if (names.some(name => !entries[name])) return false
    const types = decoder.decode(entries['[Content_Types].xml'])
    const document = decoder.decode(entries['word/document.xml'])
    if (XMLValidator.validate(types) !== true || XMLValidator.validate(document) !== true || /<!DOCTYPE/i.test(types + document)) return false
    const parsed: object = new XMLParser({ removeNSPrefix: true, processEntities: false }).parse(document)
    return typeof parsed === 'object' && parsed !== null && 'document' in parsed
      && types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
  }
  if (/\.md$/i.test(path)) { const text = decoder.decode(bytes); return text.trim().length > 0 && !text.includes('\0') }
  return false
}

/** @param absolute - Confined path. @param path - Relative display path. @param kind - Registered resource role. @param limits - Validated limits. @returns Current fingerprint and structural status; never writes source bytes. */
export async function inspectMaterial(absolute: string, path: string, kind: ProjectResource['kind'], limits: ProjectConfig): Promise<ProjectResource> {
  const result: ProjectResource = { path, kind, status: 'unreadable', checkedAt: new Date().toISOString() }
  const handle = await open(absolute, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) return result
    result.bytes = before.size
    if (before.size > limits.maxMaterialBytes) return { ...result, status: 'too-large' }
    const bytes = new Uint8Array(before.size + 1)
    let count = 0
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead }
    const after = await handle.stat()
    if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) return { ...result, status: 'changed' }
    const content = bytes.subarray(0, count)
    result.sha256 = createHash('sha256').update(content).digest('hex')
    if (kind === 'artifact') return { ...result, status: 'unverified' }
    try { return { ...result, status: await validFormat(content, path, limits) ? 'valid' : 'invalid-format' } }
    catch (error) { return { ...result, status: 'invalid-format' } }
  } finally { await handle.close() }
}

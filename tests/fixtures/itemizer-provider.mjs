/** Explicitly keyless fixture provider. Never included in the published plugin. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const chunks = {
  document_info: { name: 'Controlled Session fixture' }, chunking_summary: {}, chunks: [
    { chunk_id: 'chunk_001', title: 'Overview', chunk_type: 'overview', source_relative_path: '1Overview.md', source_sections: [{ section_id: '1', title: 'Overview', dsl_dimension: [] }], physical_segments: [{ section_id: '1' }] },
    { chunk_id: 'chunk_002', title: 'Drive', chunk_type: 'functional_requirement', canonical_function_name: 'Drive', req_id: 'REQ-1', parent_requirement: null, source_relative_path: '2Drive/2Drive.md',
      requirement_path: [{ section_id: '2', name: 'Drive' }], hierarchy_evidence: [{ section_id: '2', text: 'Drive shall stop.' }],
      source_sections: [{ section_id: '2', title: 'Drive', dsl_dimension: [] }], physical_segments: [{ section_id: '2' }] },
  ], project_relation_seed: { requirements: [{ name: 'System', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }],
    relation_delta: [{ from: 'System', to: 'Drive', rel_type: 'includes', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }], consistency_issues: [] },
}
class FixtureAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Controlled itemization fixture' }] }
  async *stream(options) {
    options.signal?.throwIfAborted()
    const calls = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-call')
    const text = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    const markdown = text.match(/^MinerU input: (.+)$/m)?.[1]?.trim()
    if (!markdown) throw new Error('Controlled fixture requires logged original-skill context')
    const operations = [
      { name: 'read_file', args: { file_path: markdown } },
      { name: 'write_file', args: { file_path: 'chunks.json', content: JSON.stringify(chunks) } },
      { name: 'write_file', args: { file_path: '1Overview.md', content: '# 1 Overview\nSystem includes Drive.\n' } },
      { name: 'write_file', args: { file_path: '2Drive/2Drive.md', content: '# 2 Drive\nDrive shall stop.\n' } },
      { name: 'write_file', args: { file_path: 'requirement_relations.json', content: JSON.stringify({
        requirements: [{ name: 'System' }, { name: 'Drive' }],
        relations: [{ source: 'System', target: 'Drive', evidence: [{ section_id: '1', text: 'System includes Drive.' }] }], consistency_issues: [],
      }) } },
    ]
    const count = calls.length
    if (count >= operations.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Controlled original-format files written; no original script execution claimed.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Controlled original-format files written; no original script execution claimed.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const { name, args } = operations[count]
    const id = ToolCallId(`fixture-${count + 1}`), argumentsText = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
export const inject = ['llm']
/** @param ctx - Isolated test profile; no model credentials or external requests. */
export function apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['workbench-itemization-fixture'], new FixtureAdapter()), 'fixture provider') }

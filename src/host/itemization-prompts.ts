/** User-task templates transcribed from 使用手册.pdf, pages 2–4. */
export interface ItemizationPromptInput {
  readonly operation: 'initial' | 'adjustment' | 'new-version'
  readonly original: string
  readonly markdown: string
  readonly output: string
  readonly previous?: string
}

/** @param input - Paths bound to one run. @returns The manual's template with path placeholders substituted. */
export function itemizationPrompt(input: ItemizationPromptInput): string {
  if (input.operation === 'new-version') return `请重新条目化该项目的新版本文档，并与现有项目结果比较。
原始文档：${input.original}
MinerU Markdown：${input.markdown}
项目根目录：${input.previous ?? input.output}
请列出新增、删除、改名和需要重新建模的功能；重新校验 includes 关系及其原文证据。
不要覆盖旧版本产物，先输出差异报告。`
  if (input.operation === 'adjustment') return `请使用 requirement_itemizer 处理：
输入：${input.previous ?? input.original}
项目根目录：${input.output}
目标：根据本次提供的划分意见，重新进行划分
要求输出：chunks.json、每个功能条目、关系种子和校验结果，
限制：不改原文，不覆盖旧版本产物`
  return `请使用 requirement_itemizer 对系统需求文档进行条目化。
原始文档：${input.original}
MinerU Markdown：${input.markdown}
项目根目录：${input.output}
要求：按系统功能拆分为独立 Markdown，保留功能概述和系统概述；
从功能概述、功能列表或正文的明确描述中提取项目级 includes 关系；
不要根据目录层级推断包含关系。
请输出 chunks.json、每个功能条目、关系种子和校验结果。`
}

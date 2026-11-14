/** Human-readable summaries retain the complete Host report in a disclosure. */
import { z } from 'zod'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import ui from './ItemizationPanel.module.css'

const evidenceSchema = z.object({ section_id: z.string().optional(), title: z.string().optional(), text: z.string(), position: z.number().optional() }).passthrough()
const issueSchema = z.object({ id: z.string().optional(), description: z.string(), evidence: z.array(evidenceSchema).optional() }).passthrough()
const seedSchema = z.object({ relation_delta: z.array(z.object({ from: z.string(), to: z.string(), rel_type: z.string(), evidence: z.array(evidenceSchema).optional() }).passthrough()) }).passthrough()
const validationSchema = z.object({ passed: z.boolean(), workflow: z.string().optional(), reviewBlocked: z.boolean().optional(), approvalReason: z.string().optional(), issues: z.array(z.object({ code: z.string(), location: z.string(), message: z.string() }).passthrough()),
  sourceConflicts: z.array(z.object({ report: z.string(), issues: z.array(issueSchema) }).passthrough()).optional() }).passthrough()

/** @param props - Unmodified report data and locale. @returns Readable known fields with a full JSON fallback. */
export function ItemizationReport({ t, kind, value }: { t: TranslateNS<'sidebarWorkbench'>; kind: 'seed' | 'validation'; value: unknown }) {
  const seed = kind === 'seed' ? seedSchema.safeParse(value) : undefined
  const validation = kind === 'validation' ? validationSchema.safeParse(value) : undefined
  const approvalReason = validation?.success ? validation.data.approvalReason : undefined
  const recognized = seed?.success || validation?.success
  return (
    <div className={ui.report}>
      {seed?.success && (
        <>
          <div className={ui.contentHeading}>
            <h4>
              {t('seed')}
            </h4>
            <span className={ui.count}>
              {seed.data.relation_delta.length}
            </span>
          </div>
          {seed.data.relation_delta.length === 0 && (
            <p className={ui.empty}>
              {t('itNoRelations')}
            </p>
          )}
          {seed.data.relation_delta.map((relation, index) => (
            <article
              className={ui.relation}
              key={index}
            >
              <div className={ui.relationHeading}>
                <h4>
                  {relation.from}
                </h4>
                <span
                  className={ui.badge}
                  data-tone="active"
                >
                  {relation.rel_type}
                </span>
                <h4>
                  {relation.to}
                </h4>
              </div>
              <Evidence
                items={relation.evidence ?? []}
                t={t}
              />
            </article>
          ))}
        </>
      )}
      {validation?.success && (
        <>
          <div
            className={ui.notice}
            data-tone={approvalReason || validation.data.reviewBlocked ? 'warning' : validation.data.passed ? 'success' : 'error'}
          >
            <h4>
              {t(approvalReason ? 'itCandidateApprovalTitle' : validation.data.reviewBlocked ? 'itConflictTitle' : validation.data.passed ? validation.data.workflow === 'original-skills' ? 'itOriginalImported' : 'itStructurePassed' : 'itStructureFailed')}
            </h4>
            <p>
              {approvalReason ?? t(validation.data.reviewBlocked ? 'itConflictHint' : validation.data.passed ? validation.data.workflow === 'original-skills' ? 'itOriginalImportedHint' : 'itStructureHint' : 'itProblem_validation')}
            </p>
          </div>
          {validation.data.sourceConflicts?.map((group, groupIndex) => (
            <div
              className={ui.issueGroup}
              key={groupIndex}
            >
              <p className={ui.reportPath}>
                {group.report}
              </p>
              {group.issues.map((issue, index) => (
                <article
                  className={ui.issue}
                  key={index}
                >
                  {issue.id && (
                    <span
                      className={ui.badge}
                      data-tone="warning"
                    >
                      {issue.id}
                    </span>
                  )}
                  <p>
                    {issue.description}
                  </p>
                  <Evidence
                    items={issue.evidence ?? []}
                    t={t}
                  />
                </article>
              ))}
            </div>
          ))}
          {validation.data.issues.map((issue, index) => (
            <article
              className={ui.issue}
              key={index}
            >
              <div className={ui.contentHeading}>
                <span
                  className={ui.badge}
                  data-tone="error"
                >
                  {issue.code}
                </span>
                <code>
                  {issue.location}
                </code>
              </div>
              <p>
                {issue.message}
              </p>
            </article>
          ))}
        </>
      )}
      <details
        className={ui.disclosure}
        open={recognized ? undefined : true}
      >
        <summary>
          {t('itRawReport')}
        </summary>
        <pre>
          {JSON.stringify(value, null, 2) ?? t('itNotProvided')}
        </pre>
      </details>
    </div>
  )
}

/** @param props - Source quotations kept verbatim. @returns Readable citations without dropping their indexed positions. */
function Evidence({ items, t }: { items: z.infer<typeof evidenceSchema>[]; t: TranslateNS<'sidebarWorkbench'> }) {
  return (
    <div className={ui.evidence}>
      {items.map((item, index) => (
        <blockquote key={index}>
          <p>
            {item.text}
          </p>
          <footer>
            {t('itSourceSections')}
            {': '}
            {[item.section_id, item.title].filter(Boolean).join(' · ') || t('itNotProvided')}
            {item.position !== undefined && (
              <>
                {' · '}
                {t('itSourcePosition')}
                {': '}
                {item.position}
              </>
            )}
          </footer>
        </blockquote>
      ))}
    </div>
  )
}

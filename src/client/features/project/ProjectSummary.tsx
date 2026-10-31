/** Persisted project metadata and current Host resource inspection, shared by P00 and P01. */
import { memo, useState } from 'react'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectResult } from '../../../shared/project.ts'
import css from '../../styles/Workbench.module.css'

/** @param props - Real project response and Session-scoped preview action. @returns Materials, fingerprints and current validation status. */
export const ProjectSummary = memo(function ProjectSummary({ t, result, openFile, unavailable }: {
  t: TranslateNS<'sidebarWorkbench'>; result: ProjectResult; openFile: (path: string) => void; unavailable: boolean
}) {
  const [previewFailed, setPreviewFailed] = useState(false)
  const project = result.project
  return <section className={css.card} aria-label={t('projectSummary')}>
    <h2>{t('projectSummary')}</h2>
    {project && <>
      <p>{t('projectIdentity')}: {project.projectId}</p>
      <p>{t('materialVersion')}: {project.materials?.version ?? t('materialNotRegistered')}</p>
      <p>{t('formalBaseline')}: {project.baseline ?? t('baselineNotAdopted')}</p>
      <p>{t('sameVersionDeclaration')}</p>
      {!project.materials && <p role="alert">{t('legacyMaterials')}</p>}
      {project.materials && !project.resources && <p>{t('legacyFingerprint')}</p>}
    </>}
    {result.resources?.map(resource => <div className={css.resourceEntry} key={`${resource.kind}:${resource.path}`}>
      <ReferenceChip appearance="file" label={resource.path} title={resource.path}
        {...!unavailable && ['valid', 'unverified', 'changed'].includes(resource.status) ? { onActivate: () => {
          try { openFile(resource.path); setPreviewFailed(false) }
          catch (error) { setPreviewFailed(true) }
        } } : {}} />
      <p>{t(`resource_${resource.status}`)}{resource.bytes !== undefined ? ` · ${resource.bytes} B` : ''}</p>
      {resource.sha256 && <p className={css.path}>SHA-256: {resource.sha256}</p>}
      <p>{t('checkedAt')}: {resource.checkedAt}</p>
    </div>)}
    {project && <p>{t('registeredArtifacts')}: {project.artifacts.length}</p>}
    {previewFailed && <p role="alert">{t('filePreviewFailed')}</p>}
    <p>{t('inspectionScope')}</p>
  </section>
})

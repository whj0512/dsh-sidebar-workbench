/** Workbench header and navigation; menu visibility is local to this component. */
import { memo, useState } from 'react'
import { Button, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DataSnapshot } from '../state/data.ts'
import type { Page } from '../state/view-store.ts'
import css from '../styles/Workbench.module.css'

/** @param props - Navigation and workspace display facts. @returns Header and primary tabs. */
export const WorkbenchChrome = memo(function WorkbenchChrome({ t, workspace, phase, baseline, demo, primary, uid, go, toggleDemo }: {
  t: TranslateNS<'sidebarWorkbench'>; workspace: DataSnapshot['workspace']; phase: DataSnapshot['phase']; baseline: string; demo: boolean
  primary: Page; uid: string; go: (page: Page) => void; toggleDemo: () => void
}) {
  const [menu, setMenu] = useState(false)
  return (
    <>
      <div className={css.chrome}>
        <header className={css.header}>
          <div className={css.heading}>
            <h1>{t('title')}</h1>
            <p>{workspace?.title ?? t(phase === 'ready' ? 'unbound' : phase)}</p>
          </div>
          <Menu
            anchor={
              <Button
                className={css.secondaryButton}
                variant="outline"
                onClick={() => setMenu(!menu)}
                aria-expanded={menu}
              >
                {t('more')}
              </Button>
            }
            open={menu}
            onClose={() => setMenu(false)}
            portal
            items={(['settings', 'review', 'run', 'artifacts'] as const).map(
              id => ({ id, label: t(id) }),
            )}
            onSelect={id => {
              go(id as Page)
              setMenu(false)
            }}
          />
        </header>
        {workspace && (
          <details className={css.workspace}>
            <summary>{t('root')}</summary>
            <p className={css.path}>{workspace.path}</p>
          </details>
        )}
        <div className={css.mode}>
          <Button
            className={css.secondaryButton}
            variant="outline"
            onClick={toggleDemo}
          >
            {t(demo ? 'production' : 'demo')}
          </Button>
          {demo && (
            <span>{t('version')}: {baseline}</span>
          )}
        </div>
        <p className={css.notice} role="status">
          {t(demo ? 'demoNotice' : 'unavailable')}
        </p>
      </div>
      <div className={css.navigationBar}>
        <SegmentedTabs
          className={css.navigation}
          label={t('title')}
          value={primary}
          onChange={page => go(page as Page)}
          items={[
            {
              value: 'flow',
              label: t('flow'),
              id: `${uid}-flow`,
              panelId: `${uid}-body`,
            },
            {
              value: 'models',
              label: t('models'),
              id: `${uid}-models`,
              panelId: `${uid}-body`,
            },
            {
              value: 'tests',
              label: t('tests'),
              id: `${uid}-tests`,
              panelId: `${uid}-body`,
            },
            {
              value: 'graph',
              label: t('graph'),
              id: `${uid}-graph`,
              panelId: `${uid}-body`,
            },
          ]}
        />
      </div>
    </>
  )
})

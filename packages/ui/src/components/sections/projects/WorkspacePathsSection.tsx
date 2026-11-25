import React from 'react';
import { Button } from '@/components/ui/button';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { getWorkspacePaths } from '@/lib/workspacePaths';
import { useProjectsStore } from '@/stores/useProjectsStore';

export function WorkspacePathsSection({ project, readOnly = false }: { project: ProjectEntry; readOnly?: boolean }) {
  const { t } = useI18n();
  const liveProject = useProjectsStore((state) => state.projects.find((entry) => entry.id === project.id) ?? project);
  const paths = getWorkspacePaths(liveProject);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          itemId="projects.workspace-paths"
          label={t('workspace.paths.sectionTitle')}
          description={paths.length === 0 ? t('workspace.paths.empty') : undefined}
          footer={paths.length > 0 ? (
            <ul className="min-w-0 typography-meta text-muted-foreground">
              {paths.map((path) => <li key={path} className="break-all">{path}</li>)}
            </ul>
          ) : null}
        >
          {!readOnly ? (
            <Button size="xs" onClick={() => setOpen(true)}>
              {t('sessions.sidebar.project.actions.edit')}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
      {open && !readOnly ? <DirectoryExplorerDialog open={open} onOpenChange={setOpen} editProject={liveProject} /> : null}
    </>
  );
}

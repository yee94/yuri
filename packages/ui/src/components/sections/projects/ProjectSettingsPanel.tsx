import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from '@/components/ui';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { WorkspacePathsSection } from '@/components/sections/projects/WorkspacePathsSection';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import type { ProjectEntry } from '@/lib/api/types';
import { getWorkspaceDisplayLabel } from '@/lib/workspacePaths';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  storedIconPreview?: React.ReactNode;
  readOnly?: boolean;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  storedIconPreview,
  readOnly = false,
}) => {
  const { t } = useI18n();
  const form = useProjectIdentityForm(project);

  useProjectIdentityAutoSave(form, onIdentitySave, !readOnly);

  const selectIcon = useEvent(async (icon: string | null) => {
    if (!project || readOnly || form.isUploadingIcon || form.isRemovingCustomIcon || form.isDiscoveringIcon) return;
    form.clearPendingUploadIcon();
    form.setPendingRemoveImageIcon(false);
    try {
      await onIdentitySave({ icon, ...(project.iconImage ? { iconImage: null } : {}) });
    } catch {
      toast.error(t('settings.projects.page.toast.saveFailed'));
    }
  });

  if (!project) {
    return null;
  }

  const headerLabel = getWorkspaceDisplayLabel(project) || t('settings.projects.page.title.default');
  return (
    <div className="yuri-settings-section-stack">
      <div className="min-w-0 pr-6">
        <h2 className="typography-ui-header font-semibold text-foreground truncate">
          {headerLabel}
        </h2>
        {project.hostId ? <p className="typography-meta text-muted-foreground truncate" title={project.path}>{project.path}</p> : null}
      </div>

      <ProjectIdentityFields form={form} onSelectIcon={selectIcon} showDefaultModel={!project.hostId} storedIconPreview={storedIconPreview} readOnly={readOnly} />
      {/* A remote workspace edits its directories on its own Host; remote single-path projects have none to edit. */}
      {(!project.hostId || Array.isArray(project.paths)) && !isVSCodeRuntime() ? <WorkspacePathsSection key={project.id} project={project} readOnly={readOnly} /> : null}
    </div>
  );
};

import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectEntry | null;
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>;
}

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  project,
  onSave,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={project?.label || project?.path.split(/[\\/]/).filter(Boolean).at(-1)}
        className="yuri-settings-workspace w-full max-w-xl gap-0 overflow-hidden p-0"
      >
        <ScrollableOverlay outerClassName="max-h-[min(85dvh,44rem)]" disableHorizontal>
          <div className="w-full p-4 sm:p-6">
            {open && project ? (
              <ProjectSettingsPanel project={project} onIdentitySave={onSave} compact />
            ) : null}
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
};

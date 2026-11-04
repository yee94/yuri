import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export const SettingsProjectSelector: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const sortedProjects = React.useMemo(() => {
    return [...projects].sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path));
  }, [projects]);

  const activeProject = React.useMemo(() => {
    if (sortedProjects.length === 0) {
      return null;
    }
    return sortedProjects.find((p) => p.id === activeProjectId) ?? sortedProjects[0];
  }, [activeProjectId, sortedProjects]);

  if (isVSCode || sortedProjects.length === 0) {
    return null;
  }

  const label = activeProject?.path.split('/').filter(Boolean).pop()
    || activeProject?.path
    || t('settings.shared.projectSelector.fallbackProject');

  return (
    <div className={cn(className)}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('settings.shared.projectSelector.switchProjectAria')}
              title={t('settings.shared.projectSelector.switchProjectTitle')}
              className={cn(
                // Mirror Input sizing so headers align visually.
                'yuri-settings-sidebar-picker text-foreground appearance-none flex h-8 w-full min-w-0 rounded-lg px-3 py-1',
                'flex items-center gap-1.5 text-left'
              )}
            >
              <Icon name="folder" className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{label}</span>
              <Icon name="arrow-down-s" className="size-4 opacity-50" />
            </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto">
          <DropdownMenuRadioGroup
            value={activeProject?.id ?? ''}
            onValueChange={(value) => {
              if (!value) return;
              setActiveProject(value);
            }}
          >
            {sortedProjects.map((project) => {
              const itemLabel = project.path.split('/').filter(Boolean).pop() || project.path;
              return (
                <DropdownMenuRadioItem key={project.id} value={project.id}>
                  <span className="min-w-0 truncate typography-ui">{itemLabel}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

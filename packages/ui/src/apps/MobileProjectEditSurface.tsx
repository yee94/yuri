import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLORS, PROJECT_COLOR_MAP, PROJECT_ICONS, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { WorkspacePathsSection } from '@/components/sections/projects/WorkspacePathsSection';
import { isMultiPathWorkspace } from '@/lib/workspacePaths';

import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';

type MobileEditableProject = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type MobileProjectEditSurfaceProps = {
  open: boolean;
  project: MobileEditableProject | null;
  onClose: () => void;
};

export const MobileProjectEditSurface: React.FC<MobileProjectEditSurfaceProps> = ({
  open,
  project,
  onClose,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  // Read the live project entry from the store so icon/path mutations reflect instantly.
  const liveProjectEntry = useProjectsStore((state) =>
    project ? state.projects.find((entry) => entry.id === project.id) ?? null : null,
  );
  const currentIconImage = liveProjectEntry?.iconImage ?? null;
  const isMultiPath = isMultiPathWorkspace(liveProjectEntry);

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = React.useState(false);

  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
    setIcon(project.icon ?? null);
    setColor(project.color ?? null);
    // Re-seed only when the edited project or sheet visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const handleSave = () => {
    if (!project) return;
    const trimmed = name.trim();
    updateProjectMeta(project.id, {
      label: trimmed || project.label,
      icon,
      color,
    });
    onClose();
  };

  const handleDiscoverIcon = () => {
    if (!project || isDiscovering) return;
    setIsDiscovering(true);
    void discoverProjectIcon(project.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || t('projectEditDialog.toast.failedToDiscoverIcon'));
          return;
        }
        if (result.skipped) {
          toast.success(t('projectEditDialog.toast.customIconAlreadySet'));
          return;
        }
        toast.success(t('projectEditDialog.toast.iconDiscovered'));
      })
      .finally(() => setIsDiscovering(false));
  };

  const handleRemoveDiscoveredIcon = () => {
    if (!project) return;
    void removeProjectIcon(project.id).then((result) => {
      if (!result.ok) {
        toast.error(result.error || t('projectEditDialog.toast.failedToRemoveIcon'));
        return;
      }
      toast.success(t('projectEditDialog.toast.iconRemoved'));
    });
  };

  const currentColorVar = color ? PROJECT_COLOR_MAP[color] ?? null : null;
  const previewIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const hasImageIcon = Boolean(currentIconImage);

  return (
    <>
      <MobileResizableSheet
        id="mobile-project-edit"
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        title={
          <h2 className="truncate typography-ui-label font-semibold text-foreground">
            {t('projectEditDialog.title')}
          </h2>
        }
        trailing={
          <Button
            type="button"
            variant="default"
            size="sm"
            aria-label={t('projectEditDialog.actions.save')}
            onClick={handleSave}
            disabled={!name.trim()}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="check" className="size-4" />
            {t('projectEditDialog.actions.save')}
          </Button>
        }
        ariaLabel={t('projectEditDialog.title')}
        closeAriaLabel={t('mobile.surface.closeAria')}
        resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
        initiallyExpanded
      >
        {project ? (
          <div className="overlay-scrollbar-container h-full space-y-6 overflow-y-auto px-4 pb-8 pt-2">
            {/* Icon preview */}
            <div className="flex justify-center pt-2">
              <span
                className="flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-muted)] text-muted-foreground"
                style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
              >
                {hasImageIcon ? (
                  <ProjectIconImage
                    project={{ id: project.id, iconImage: currentIconImage }}
                    options={{
                      themeVariant: currentTheme.metadata.variant,
                      iconColor: currentTheme.colors.surface.foreground,
                    }}
                    className="size-full object-contain"
                    fallback={<Icon name="folder-6" className="size-7" />}
                  />
                ) : previewIconName ? (
                  <Icon name={previewIconName} className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
                ) : (
                  <Icon name={isMultiPath ? 'folders' : 'folder-6'} className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
                )}
              </span>
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.name')}
              </label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('projectEditDialog.field.namePlaceholder')}
                className="h-11"
              />
              <p className="truncate typography-meta text-muted-foreground" title={project.path}>
                {project.path}
              </p>
            </div>

            {/* Color */}
            <div className="flex flex-col gap-2">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.color')}
              </label>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  aria-label={t('projectEditDialog.option.none')}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                    color === null ? 'border-foreground' : 'border-border hover:border-border/80',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
                </button>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    aria-label={c.label}
                    title={c.label}
                    className={cn(
                      'size-9 rounded-xl border-2 transition-all',
                      color === c.key ? 'border-foreground' : 'border-transparent hover:border-border',
                    )}
                    style={{ backgroundColor: c.cssVar, touchAction: 'manipulation' }}
                  />
                ))}
              </div>
            </div>

            {/* Icon */}
            <div className="flex flex-col gap-2">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.icon')}
              </label>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  aria-label={t('projectEditDialog.option.none')}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                    icon === null ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border hover:border-border/80',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
                </button>
                {PROJECT_ICONS.map((i) => (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => setIcon(i.key)}
                    aria-label={i.label}
                    title={i.label}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                      icon === i.key ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border hover:border-border/80',
                    )}
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Icon name={i.Icon} className="size-4" style={currentColorVar ? { color: currentColorVar } : undefined} />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleDiscoverIcon} disabled={isDiscovering}>
                  {isDiscovering
                    ? t('projectEditDialog.actions.discovering')
                    : t('projectEditDialog.actions.discoverFavicon')}
                </Button>
                {hasImageIcon ? (
                  <Button size="sm" variant="outline" onClick={handleRemoveDiscoveredIcon}>
                    {t('projectEditDialog.actions.removeProjectIcon')}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Workspace directories */}
            {open && liveProjectEntry && !liveProjectEntry.hostId ? (
              <WorkspacePathsSection key={liveProjectEntry.id} project={liveProjectEntry} />
            ) : null}
          </div>
        ) : null}
      </MobileResizableSheet>

    </>
  );
};

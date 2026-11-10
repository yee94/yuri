import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type ProjectIdentityFieldsProps = {
  form: ProjectIdentityFormState;
};

export const ProjectIdentityFields: React.FC<ProjectIdentityFieldsProps> = ({ form }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const {
    name,
    setName,
    icon,
    setIcon,
    color,
    setColor,
    iconBackground,
    setIconBackground,
    parsedDefaultModel,
    handleDefaultModelChange,
    isUploadingIcon,
    isRemovingCustomIcon,
    isDiscoveringIcon,
    pendingRemoveImageIcon,
    setPendingRemoveImageIcon,
    pendingUploadIconPreviewUrl,
    setPreviewImageFailed,
    hasPendingUploadImageIcon,
    hasCustomIcon,
    effectiveHasImageIcon,
    hasRemovableImageIcon,
    showImagePreview,
    fileInputRef,
    handleUploadIcon,
    handleRemoveImageIcon,
    handleDiscoverIcon,
    currentIconImage,
    project,
  } = form;

  if (!project) {
    return null;
  }

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;

  return (
    <SettingsGroup>
      <SettingsRow
        label={t('settings.projects.page.field.projectName')}
        itemId="projects.name"
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('settings.projects.page.field.projectNamePlaceholder')}
          aria-label={t('settings.projects.page.field.projectName')}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.yuri.defaults.field.defaultModel')}
        itemId="projects.default-model"
      >
        <ModelSelector
          providerId={parsedDefaultModel.providerId}
          modelId={parsedDefaultModel.modelId}
          onChange={handleDefaultModelChange}
          className="yuri-settings-inline-value"
          placeholder={t('settings.yuri.defaults.option.default')}
          showIcon={false}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.projects.page.field.accentColor')}
        itemId="projects.accent-color"
        footer={(
        <div className="flex flex-wrap items-center gap-1 pt-2">
          <Button
            type="button"
            variant="chip"
            size="icon"
            onClick={() => setColor(null)}
            aria-pressed={color === null}
            aria-label={t('settings.projects.page.field.none')}
            title={t('settings.projects.page.field.none')}
          >
            <Icon name="close" className="size-4 text-muted-foreground" />
          </Button>
          {PROJECT_COLORS.map((entry) => (
            <Button
              key={entry.key}
              type="button"
              variant="chip"
              size="icon"
              onClick={() => setColor(entry.key)}
              aria-pressed={color === entry.key}
              aria-label={entry.label}
              title={entry.label}
            >
              <span className="flex size-5 items-center justify-center rounded-full" style={{ backgroundColor: entry.cssVar }}>
                {color === entry.key ? <Icon name="check" className="size-3 text-foreground" /> : null}
              </span>
            </Button>
          ))}
        </div>
        )}
      >{null}</SettingsRow>

      <SettingsRow
        label={t('settings.projects.page.field.projectIcon')}
        itemId="projects.icon"
        footer={(
        <div className="flex w-full flex-col items-start gap-2 pt-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              void handleUploadIcon(file);
              event.currentTarget.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="chip"
            size="icon"
            onClick={() => setIcon(null)}
            aria-pressed={icon === null}
            aria-label={t('settings.projects.page.field.none')}
            title={t('settings.projects.page.field.none')}
          >
            <Icon name="close" className="h-4 w-4 text-muted-foreground" />
          </Button>
          {PROJECT_ICONS.map((entry) => {
            const iconName = entry.Icon;
            return (
              <Button
                key={entry.key}
                type="button"
                variant="chip"
                size="icon"
                onClick={() => setIcon(entry.key)}
                aria-pressed={icon === entry.key}
                aria-label={entry.label}
                title={entry.label}
              >
                <Icon
                  name={iconName}
                  className="w-4 h-4"
                  style={currentColorVar && icon === entry.key ? { color: currentColorVar } : undefined}
                />
              </Button>
            );
          })}
          </div>
          {effectiveHasImageIcon && showImagePreview && (
            <div className="flex items-center gap-2 pt-1">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-[var(--surface-elevated)] p-1">
              <span
                className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
                style={iconBackground ? { backgroundColor: iconBackground } : undefined}
              >
                {hasPendingUploadImageIcon && pendingUploadIconPreviewUrl ? (
                  <img
                    src={pendingUploadIconPreviewUrl}
                    alt=""
                    className="h-full w-full object-contain"
                    draggable={false}
                    onError={() => setPreviewImageFailed(true)}
                  />
                ) : (
                  <ProjectIconImage
                    project={{ ...project, iconImage: currentIconImage ?? project.iconImage }}
                    options={{
                      themeVariant: currentTheme.metadata.variant,
                      iconColor: currentTheme.colors.surface.foreground,
                    }}
                    className="h-full w-full object-contain"
                    onError={() => setPreviewImageFailed(true)}
                  />
                )}
              </span>
            </span>
            </div>
          )}
          {effectiveHasImageIcon && (
            <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              value={iconBackground ?? '#000000'}
              onChange={(event) => setIconBackground(event.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-1"
              aria-label={t('settings.projects.page.field.projectIconBackgroundAria')}
            />
             <Input
               value={iconBackground ?? ''}
               onChange={(event) => setIconBackground(event.target.value)}
               aria-label={t('settings.projects.page.field.projectIconBackgroundAria')}
              placeholder="#000000"
              className="h-7 w-[8rem]"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => setIconBackground(null)}
              aria-label={t('settings.projects.page.field.clearIconBackgroundAria')}
              title={t('settings.projects.page.field.clearBackground')}
              disabled={!iconBackground}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
          {!hasCustomIcon && (
            <>
              <Button
                size="xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingIcon}
              >
                {isUploadingIcon ? t('settings.projects.page.actions.uploading') : t('settings.projects.page.actions.uploadIcon')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void handleDiscoverIcon()}
                disabled={isDiscoveringIcon}
              >
                {isDiscoveringIcon ? t('settings.projects.page.actions.discovering') : t('settings.projects.page.actions.discoverFavicon')}
              </Button>
            </>
          )}
          {hasRemovableImageIcon && (
            <Button
              size="xs"
              className="!font-normal"
              variant="outline"
              onClick={() => void handleRemoveImageIcon()}
              disabled={isRemovingCustomIcon}
            >
              {isRemovingCustomIcon ? t('settings.projects.page.actions.removing') : t('settings.projects.page.actions.removeProjectIcon')}
            </Button>
          )}
          {pendingRemoveImageIcon && (
            <Button
              size="xs"
              className="!font-normal"
              variant="outline"
              onClick={() => setPendingRemoveImageIcon(false)}
              disabled={isRemovingCustomIcon}
            >
              {t('settings.projects.page.actions.undoRemove')}
            </Button>
          )}
          </div>
        </div>
        )}
      >{null}</SettingsRow>
    </SettingsGroup>
  );
};

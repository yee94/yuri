import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePluginRegistryQuery } from '@/queries/pluginQueries';

interface RegistryBannerProps {
  spec: string;
}

export const RegistryBanner: React.FC<RegistryBannerProps> = ({ spec }) => {
  const { t } = useI18n();
  const { data } = usePluginRegistryQuery([spec]);
  const info = data?.[spec];

  if (!info) return null;

  if (info.kind === 'npm-ok') return null;

  if (info.kind === 'path-ok') return null;

  if (info.kind === 'npm-network') {
    return (
      <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
        <Icon
          name="cloud-off"
          className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className="typography-micro text-muted-foreground">
            {t('settings.plugins.registry.badge.network.tooltip')}
          </p>
        </div>
      </div>
    );
  }

  const isWarning = info.kind === 'path-unreadable';
  const colorVar = isWarning ? 'var(--status-warning)' : 'var(--status-error)';
  const iconName = isWarning ? 'alert' : 'error-warning';

  const description = (() => {
    switch (info.kind) {
      case 'npm-missing-version':
        return t('settings.plugins.registry.banner.invalid.missingVersion');
      case 'npm-missing-package':
        return t('settings.plugins.registry.banner.invalid.missingPackage');
      case 'npm-malformed':
        return t('settings.plugins.registry.banner.invalid.malformed');
      case 'path-missing':
        return t('settings.plugins.registry.banner.invalid.pathMissing');
      case 'path-unreadable':
        return t('settings.plugins.registry.banner.invalid.pathUnreadable');
    }
  })();

  return (
    <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
      <Icon
        name={iconName}
        className="h-5 w-5 shrink-0 mt-0.5"
        style={{ color: colorVar }}
      />
      <div className="flex-1 min-w-0">
        <p className="typography-label" style={{ color: colorVar }}>
          {t('settings.plugins.registry.banner.invalid.title')}
        </p>
        <p className="typography-micro text-muted-foreground mt-0.5">
          {description}
        </p>
      </div>
    </div>
  );
};

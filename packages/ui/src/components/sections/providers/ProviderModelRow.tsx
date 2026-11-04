import type { ReactNode } from 'react';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import './provider-settings.css';

export function ProviderModelRow({ id, name, providerId, added, disabled, capabilities, detail, onSelect, onEdit, onToggle }: {
  id: string;
  name: string;
  providerId?: string;
  added: boolean;
  disabled?: boolean;
  capabilities: ReadonlyArray<{ icon: IconName; label: string }>;
  detail?: ReactNode;
  onSelect?: () => void;
  onEdit?: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-provider-model={id} data-added={added} className="yuri-provider-model-row yuri-settings-group-row !min-h-0 !py-1.5 flex min-w-0 items-center gap-2">
      <ModelLogo modelId={id} providerId={providerId} className="size-5 shrink-0" alt=""
        fallback={<Icon name="stack" className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />} />
      <button type="button" disabled={disabled || !onSelect} onClick={onSelect}
        title={`${name || id} (${id})${typeof detail === 'string' ? ` · ${detail}` : ''}`}
        className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-default">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate typography-ui-label text-foreground">{name || id}</span>
          {detail && <span className="yuri-provider-model-detail truncate text-[10px] leading-4 text-muted-foreground">{detail}</span>}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {capabilities.map(({ icon, label }) => <span key={icon} role="img" aria-label={label} title={label}
          className="yuri-provider-model-capability inline-flex items-center justify-center rounded-full bg-[var(--surface-muted)] px-2 py-1 text-muted-foreground">
          <Icon name={icon} className="size-3.5" />
        </span>)}
      </div>
      {added && onEdit && <Button type="button" variant="ghost" size="icon" disabled={disabled}
        aria-label={t('settings.providers.custom.editModel')} title={t('settings.providers.custom.editModel')} onClick={onEdit}>
        <Icon name="settings-3" className="size-4" />
      </Button>}
      <Button type="button" variant="ghost" size="icon" disabled={disabled}
        aria-label={t(added ? 'settings.providers.custom.removeModel' : 'settings.providers.custom.addModel')}
        title={t(added ? 'settings.providers.custom.removeModel' : 'settings.providers.custom.addModel')} onClick={onToggle}>
        <Icon name={added ? 'subtract' : 'add'} className="size-4" />
      </Button>
    </div>
  );
}

import type { ComponentProps } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { useI18n } from '@/lib/i18n';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { cn } from '@/lib/utils';
import type { ModelPickerEntry } from './ModelPickerList';

export function DesktopModelPickerContent({ className, ...props }: ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      {...props}
      className={cn('yuri-composer-picker w-[min(400px,calc(100vw-2rem))] p-0 flex flex-col', className)}
    />
  );
}

export function DesktopModelVariantPicker({ entry, variants, selectedVariant, formatLabel, onSelect, onBack }: {
  entry: ModelPickerEntry;
  variants: readonly string[];
  selectedVariant: string | undefined;
  formatLabel: (variant: string | undefined) => string;
  onSelect: (variant: string | undefined) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={(event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-1.5 py-1.5">
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" autoFocus onClick={onBack} aria-label={t('header.actions.backAria')}>
          <Icon name="arrow-left" className="size-3.5" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ModelLogo modelId={entry.modelID} providerId={entry.providerID} className="size-3.5 shrink-0" />
          <span className="truncate typography-meta font-medium text-foreground">{getModelDisplayName(entry.model, entry.modelID, { maxLength: 40 })}</span>
          <span aria-hidden="true" className="shrink-0 text-border">·</span>
          <span className="inline-flex shrink-0 items-center gap-1 typography-micro text-muted-foreground">
            <Icon name="brain-ai-3" className="size-3 opacity-70" />
            {t('chat.modelControls.thinking')}
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1" role="listbox" aria-label={t('chat.modelControls.thinking')}>
        {[undefined, ...variants].map((option) => {
          const selected = option === (selectedVariant || undefined);
          return (
            <button
              key={option ?? '__default'}
              type="button"
              role="option"
              aria-selected={selected}
              className={cn(
                'flex w-full shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left typography-meta transition-colors',
                selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-foreground hover:bg-interactive-hover/50',
              )}
              onClick={() => onSelect(option)}
            >
              <span className={cn('truncate font-medium', !option && !selected && 'text-muted-foreground')}>{formatLabel(option)}</span>
              {selected ? <Icon name="check" className="size-3.5 shrink-0 text-primary" /> : <span className="size-3.5 shrink-0" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="model-picker-footer flex shrink-0 items-center gap-1.5 typography-micro text-muted-foreground">
        <Kbd variant="hint">Esc</Kbd>
        {t('header.actions.backAria')}
      </div>
    </div>
  );
}

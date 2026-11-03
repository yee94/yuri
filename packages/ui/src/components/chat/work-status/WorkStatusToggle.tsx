import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

export function WorkStatusToggle() {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.workStatusPanelEnabled);
  const fits = useUIStore((state) => state.workStatusPanelFits);
  const overlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
  const setEnabled = useUIStore((state) => state.setWorkStatusPanelEnabled);
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const selected = (enabled && fits) || overlayOpen;
  const toggle = useEvent(() => {
    if (!fits) {
      if (!enabled) setEnabled(true);
      setOverlayOpen(!overlayOpen);
      return;
    }
    setEnabled(!enabled);
  });

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-work-status-toggle="true"
      aria-pressed={selected}
      aria-label={t('header.workStatusPanel.toggleAria')}
      title={t('header.workStatusPanel.toggleAria')}
      onClick={toggle}
      className={cn('app-region-no-drag size-7', selected ? 'text-foreground' : 'text-muted-foreground/50')}
    >
      <Icon name="settings-2" className="size-4" />
    </Button>
  );
}

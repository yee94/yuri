import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const MiniChatWindowHeader: React.FC<{
  children: React.ReactNode;
  actions?: React.ReactNode;
  mainWindowTarget: Record<string, unknown>;
}> = ({ children, actions, mainWindowTarget }) => {
  const { t } = useI18n();
  const [pinned, setPinned] = React.useState(false);
  const [pinPending, setPinPending] = React.useState(false);
  const pinFlight = React.useRef(false);
  const pinChanged = React.useRef(false);
  const macosMajor = typeof window !== 'undefined' ? window.__YURI_MACOS_MAJOR__ ?? 0 : 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  React.useEffect(() => {
    if (!isElectronShell()) return;
    let active = true;
    void invokeDesktop<{ pinned?: boolean }>('desktop_get_window_pinned').then((result) => {
      if (active && !pinChanged.current && typeof result?.pinned === 'boolean') setPinned(result.pinned);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const togglePinned = useEvent(async () => {
    if (pinFlight.current) return;
    pinChanged.current = true;
    pinFlight.current = true;
    setPinPending(true);
    try {
      const result = await invokeDesktop<{ pinned: boolean }>('desktop_set_window_pinned', { pinned: !pinned });
      if (!result) throw new Error('Window pin state is unavailable');
      setPinned(result.pinned);
    } catch {
      toast.error(t('miniChat.actions.failed'));
    } finally {
      pinFlight.current = false;
      setPinPending(false);
    }
  });
  const openMain = useEvent(async () => {
    try {
      const result = await invokeDesktop<{ focused?: boolean }>('desktop_focus_main_window', mainWindowTarget);
      if (result?.focused) await invokeDesktop('desktop_close_current_window');
    } catch {
      toast.error(t('miniChat.actions.failed'));
    }
  });

  return (
    <header
      className={cn('flex shrink-0 items-center gap-3 bg-background pr-3', hasMacTrafficLights ? 'pl-[5.5rem]' : 'pl-3', usesFramelessChrome || macosMajor >= 26 ? 'h-12' : 'min-h-14')}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {usesFramelessChrome && side === 'left' ? <WindowsWindowControls visible position="left" /> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {actions}
      <Button type="button" variant="ghost" size="icon" onClick={togglePinned} disabled={pinPending} aria-pressed={pinned} aria-label={t(pinned ? 'miniChat.actions.unpinAria' : 'miniChat.actions.pinAria')} title={t(pinned ? 'miniChat.actions.unpin' : 'miniChat.actions.pin')} style={noDrag}>
        <Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={openMain} aria-label={t('miniChat.actions.openMainAria')} title={t('miniChat.actions.openMain')} style={noDrag}>
        <Icon name="external-link" className="size-4" />
      </Button>
      <WindowsWindowControls visible={usesFramelessChrome && side === 'right'} position="right" />
    </header>
  );
};

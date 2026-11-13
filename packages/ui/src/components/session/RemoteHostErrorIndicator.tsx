import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useRemoteOperationErrors } from '@/lib/remote-projects/operation-errors';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

export const RemoteHostErrorIndicator = React.memo(function RemoteHostErrorIndicator({ registry, hostId, connectionError }: {
  registry: HostRuntimeRegistry; hostId: string; connectionError?: string;
}) {
  const { t } = useI18n();
  const errors = useRemoteOperationErrors(registry, hostId);
  const [retrying, setRetrying] = React.useState(false);
  const message = [...new Set([connectionError, ...errors.map((error) => error.message)].filter(Boolean))].join('\n');
  if (!message) return null;
  return <Popover.Root>
    <Popover.Trigger openOnHover delay={200} closeDelay={150} aria-label={message}
      nativeButton={false} render={<span role="button" tabIndex={0} />}
      data-remote-host-error={hostId}
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      className="app-region-no-drag inline-flex size-5 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[var(--status-error)] outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Icon name="exclamation-fill" className="size-3.5" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="bottom" sideOffset={6} collisionPadding={12} className="z-50">
      <Popover.Popup data-remote-host-error-popup="" className="yuri-mobile-overlay-surface yuri-popup-surface max-w-[min(24rem,calc(100vw-2rem))] rounded-xl p-3 text-foreground outline-none" onClick={(event) => event.stopPropagation()}>
        <Popover.Description className="max-h-64 overflow-y-auto whitespace-pre-wrap typography-meta [overflow-wrap:anywhere]">{message}</Popover.Description>
        {errors.length ? <div className="mt-2 flex justify-end"><Button size="xs" disabled={retrying} onClick={async () => {
          setRetrying(true);
          try { await Promise.all(errors.map((error) => error.retry())); }
          finally { setRetrying(false); }
        }}>{t('chat.history.retry')}</Button></div> : null}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
});

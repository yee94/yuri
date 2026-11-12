import React from 'react';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { remoteConnectionHint } from '@/lib/remote-projects/connection-hint';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';

export const RemoteComposerConnectionStatus = React.memo(function RemoteComposerConnectionStatus({ registry, hostId }: {
  registry: HostRuntimeRegistry;
  hostId: string;
}) {
  const host = useRemoteHost(registry, hostId);
  const { t } = useI18n();
  const hint = remoteConnectionHint(host);
  return <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex min-w-0 items-center gap-1.5 px-3 typography-meta text-muted-foreground">
    {hint ? <>
      {hint.pending ? <Icon name="loader-4" aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
      <span className="truncate">{t(hint.key)}</span>
    </> : null}
  </div>;
});

import React from 'react';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import { RemoteChatContext } from '@/sync/remote-chat-context';
import { useI18n } from '@/lib/i18n';
import type { RemoteMobileSession } from './remoteMobileSession';

/** Only session surfaces inherit this provider; machine settings remain Hub-owned. */
export function RemoteMobileSessionBoundary({ scope, children }: { scope: RemoteMobileSession; children: React.ReactNode }) {
  const { t } = useI18n();
  if (!scope.supported) return <div role="status">{t('remoteProjects.unsupported')}</div>;
  if (!scope.registry || !scope.entry || !scope.owner) return <div role={scope.error ? 'alert' : 'status'}>{scope.error?.message ?? t('remoteProjects.state.connecting')}</div>;
  return <HostRuntimeProvider registry={scope.registry} location={scope.entry.location}>
    <RemoteChatContext.Provider value={scope.owner.state}>{children}</RemoteChatContext.Provider>
  </HostRuntimeProvider>;
}

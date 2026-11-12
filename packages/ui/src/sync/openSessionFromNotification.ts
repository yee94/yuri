import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

export type DesktopNotificationOpenDetail = {
  sessionId?: string;
  directory?: string;
  hostId?: string;
  hubId?: string;
};
let navigationRevision = 0;

/**
 * Open a session from a native desktop notification click.
 * Electron routes the click to its originating window and rejects stale owners.
 * Keep that window's runtime: the session may belong to a direct or relay host.
 */
export function openSessionFromNotification(detail: DesktopNotificationOpenDetail): void {
  const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;
  const revision = ++navigationRevision;
  const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
    ? detail.directory.trim()
    : null;

  useUIStore.getState().setActiveMainTab('chat');
  if (detail.hostId || detail.hubId) {
    if (!detail.hostId || !detail.hubId || !directory) return;
    void import('@/lib/remote-projects/navigation').then(({ applyRemoteProjectRoute }) => {
      if (revision !== navigationRevision) return;
      return applyRemoteProjectRoute({ sessionId, directory, hostId: detail.hostId, hubId: detail.hubId, isNewSession: false }, () => revision === navigationRevision);
    }).catch(() => console.warn('[remote-session] Notification navigation failed'));
    return;
  }
  void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
}

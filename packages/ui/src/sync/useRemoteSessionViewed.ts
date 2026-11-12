import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { sessionUnreadQueryOptions, saveSessionUnread, type SessionUnreadSnapshot } from '@/queries/sessionUnreadQueries';

/** Read acknowledgements belong to the visible Host, never the retained Hub session. */
export function useRemoteSessionViewed(registry: HostRuntimeRegistry, entry: HostRuntimeEntry, sessionID: string | null, active: boolean) {
  const client = useQueryClient();
  const transport = getRuntimeTransportIdentity();
  const options = React.useMemo(() => sessionUnreadQueryOptions(transport, entry), [transport, entry]);
  const query = useQuery({ ...options, enabled: active && Boolean(sessionID) });
  const pendingOpen = React.useRef(true);
  const flights = React.useMemo(() => ({ entry, sessionID, revisions: new Set<number>() }), [entry, sessionID]).revisions;
  const acknowledge = useEvent(async (snapshot: SessionUnreadSnapshot, explicit: boolean, expectedEntry: HostRuntimeEntry, expectedSession: string | null) => {
    if (entry !== expectedEntry || sessionID !== expectedSession) return;
    if (!active || !sessionID || !document.hasFocus() || document.visibilityState === 'hidden') return;
    const row = snapshot.sessions[sessionID];
    if (!row) return;
    if (!row.unreadCount) { pendingOpen.current = false; return; }
    if (row.manual && !explicit && !pendingOpen.current) return;
    if (flights.has(row.revision)) return;
    pendingOpen.current = false;
    flights.add(row.revision);
    try {
      entry.sdk();
      await saveSessionUnread(sessionID, false, row.revision, entry);
    } catch {
      // Preserve authority on failure; a later focus/reconnect can retry.
    } finally {
      flights.delete(row.revision);
    }
  });
  React.useEffect(() => { pendingOpen.current = true; }, [entry, sessionID, active]);
  React.useEffect(() => {
    if (query.data) void acknowledge(query.data, false, entry, sessionID);
  }, [query.data, acknowledge, entry, sessionID, active]);
  const refocus = useEvent(async () => {
    if (!active || !sessionID || !document.hasFocus()) return;
    try { await acknowledge(await client.fetchQuery(options), true, entry, sessionID); } catch { /* Keep the unread snapshot. */ }
  });
  useEventListener('focus', refocus);
  useEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refocus(); }, () => document);
  React.useEffect(() => {
    if (!active || !sessionID || !entry.location.hostId) return;
    return registry.subscribeEvents(entry.location.hostId, (envelope) => {
      const payload = envelope.payload as { type?: string };
      if (payload.type === 'session-unread-changed' || payload.type === 'yuri:session-unread-changed'
        || payload.type?.startsWith('session.execution.') || payload.type === 'session.idle') {
        void client.invalidateQueries({ queryKey: options.queryKey });
      }
    });
  }, [registry, entry, active, sessionID, client, options.queryKey]);
}

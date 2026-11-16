import type { DesktopSessionLinkProbeResult } from '@/lib/desktop';
import { findSessionIndexEntryById } from '@/lib/session-index-api';
import { findSessionById, resolveSessionForRoute } from '@/router/sessionLookup';
import { notifySessionOpenFailed } from '@/sync/openSessionWithFeedback';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

export type SessionDeepLinkDetail = {
  sessionId?: string;
  directory?: string;
  /**
   * Desktop window probe outcome when no open window owned the id:
   * `ambiguous` (several runtimes claim it) or `unconfirmed` (a window could not check).
   */
  probe?: 'ambiguous' | 'unconfirmed';
};

let navigationRevision = 0;

/**
 * Answer a desktop probe: does this window's runtime know the session id?
 * Rejects when the runtime cannot answer, so absence stays authoritative.
 */
export async function probeSessionLink(sessionId: string): Promise<DesktopSessionLinkProbeResult> {
  const memory = findSessionById(sessionId.trim());
  if (memory) return { status: 'found', directory: memory.directory };
  const hit = await findSessionIndexEntryById(sessionId);
  return hit ? { status: 'found', directory: hit.directory } : { status: 'not-found' };
}

/**
 * Open a conversation from a `yuri://session/<id>?directory=<path>` link.
 * The id is looked up in this runtime's session index first. Otherwise the
 * directory (a path on the machine that produced the link) must belong to exactly
 * one connected Remote Project. Anything else is reported as not found; the link
 * never guesses a Host and never opens a Remote Project's session by local id.
 */
export async function openSessionFromDeepLink(detail: SessionDeepLinkDetail): Promise<void> {
  const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;
  const directory = typeof detail.directory === 'string' ? detail.directory.trim() : '';
  const revision = ++navigationRevision;
  const isCurrent = () => revision === navigationRevision;
  const missReason = detail.probe === 'unconfirmed' ? 'unresolved' : 'not-found';

  useUIStore.getState().setActiveMainTab('chat');

  if (detail.probe === 'ambiguous') {
    notifySessionOpenFailed(sessionId, 'unresolved');
    return;
  }

  const local = await resolveSessionForRoute(sessionId, { trySessionGet: false });
  if (!isCurrent()) return;
  if (local) {
    void useSessionUIStore.getState().setCurrentSession(sessionId, local.directory);
    return;
  }

  if (!directory) {
    notifySessionOpenFailed(sessionId, missReason);
    return;
  }

  try {
    const [{ supportsRemoteProjects, ensureRemoteHostCatalog }, { resolveRemoteProjectOwner }, { applyRemoteProjectRoute }] = await Promise.all([
      import('@/queries/remoteProjectQueries'),
      import('@/lib/remote-projects/summaries'),
      import('@/lib/remote-projects/navigation'),
    ]);
    if (!supportsRemoteProjects()) {
      notifySessionOpenFailed(sessionId, missReason);
      return;
    }
    const catalog = await ensureRemoteHostCatalog();
    if (!isCurrent()) return;
    if (!catalog.supported) {
      notifySessionOpenFailed(sessionId, missReason);
      return;
    }
    const hostIds = [...new Set(catalog.projects.map((project) => project.hostId))];
    const owners = hostIds.flatMap((hostId) => {
      const owner = resolveRemoteProjectOwner(catalog.projects, catalog.hubId, hostId, directory);
      return owner ? [owner] : [];
    });
    if (owners.length !== 1) {
      notifySessionOpenFailed(sessionId, missReason);
      return;
    }
    const [owner] = owners;
    await applyRemoteProjectRoute({
      sessionId,
      directory,
      hostId: owner.hostId,
      hubId: catalog.hubId,
      projectId: owner.id,
      isNewSession: false,
    }, isCurrent);
  } catch {
    if (isCurrent()) notifySessionOpenFailed(sessionId, missReason);
  }
}

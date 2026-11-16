import { resolveSessionForRoute } from '@/router/sessionLookup';
import { notifySessionOpenFailed } from '@/sync/openSessionWithFeedback';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

export type SessionDeepLinkDetail = {
  sessionId?: string;
  directory?: string;
};

let navigationRevision = 0;

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

  useUIStore.getState().setActiveMainTab('chat');

  const local = await resolveSessionForRoute(sessionId, { trySessionGet: false });
  if (!isCurrent()) return;
  if (local) {
    void useSessionUIStore.getState().setCurrentSession(sessionId, local.directory);
    return;
  }

  if (!directory) {
    notifySessionOpenFailed(sessionId, 'not-found');
    return;
  }

  try {
    const [{ supportsRemoteProjects, ensureRemoteHostCatalog }, { resolveRemoteProjectOwner }, { applyRemoteProjectRoute }] = await Promise.all([
      import('@/queries/remoteProjectQueries'),
      import('@/lib/remote-projects/summaries'),
      import('@/lib/remote-projects/navigation'),
    ]);
    if (!supportsRemoteProjects()) {
      notifySessionOpenFailed(sessionId, 'not-found');
      return;
    }
    const catalog = await ensureRemoteHostCatalog();
    if (!isCurrent()) return;
    if (!catalog.supported) {
      notifySessionOpenFailed(sessionId, 'not-found');
      return;
    }
    const hostIds = [...new Set(catalog.projects.map((project) => project.hostId))];
    const owners = hostIds.flatMap((hostId) => {
      const owner = resolveRemoteProjectOwner(catalog.projects, catalog.hubId, hostId, directory);
      return owner ? [owner] : [];
    });
    if (owners.length !== 1) {
      notifySessionOpenFailed(sessionId, 'not-found');
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
    if (isCurrent()) notifySessionOpenFailed(sessionId, 'not-found');
  }
}

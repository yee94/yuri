import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO';
import { ensureRemoteHostCatalog, ensureRemoteHostSummaries, getHostRuntimeRegistry } from '@/queries/remoteProjectQueries';
import { resolveRemoteProjectOwner } from '@/lib/remote-projects/summaries';
import { openRemoteProjectSession } from '@/router/openRemoteProjectSession';
import { useProjectsStore } from '@/stores/useProjectsStore';

export const assistantSessionReferenceKey = (card: Pick<AssistantContactSessionCardPart, 'target' | 'directory' | 'sessionID'>) =>
  JSON.stringify([card.target ?? null, card.directory, card.sessionID]);

/** A remote receipt must never enter a bare-ID local lookup or native local handoff. */
export async function openAssistantRemoteSession(card: AssistantContactSessionCardPart, mobile: boolean) {
  const target = card.target;
  if (!target) throw new Error('Remote session target required');
  const catalog = await ensureRemoteHostCatalog();
  if (!catalog.supported || catalog.hubId !== target.hubId) throw new Error('Remote Hub unavailable');
  const registry = getHostRuntimeRegistry(catalog);
  const location = { ...target, directory: card.directory };
  registry.resolve(location).sdk();
  const summaries = await ensureRemoteHostSummaries(registry, target.hostId);
  registry.resolve(location).sdk();
  const project = resolveRemoteProjectOwner(catalog.projects, target.hubId, target.hostId, card.directory, summaries.worktrees);
  if (!project) throw new Error('Remote project unavailable');
  useProjectsStore.getState().upsertRemoteProject(project, target.hubId);
  openRemoteProjectSession(project, registry, card.sessionID, card.directory, mobile);
}

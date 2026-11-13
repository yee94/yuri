import type { CreateGitWorktreePayload, ProjectEntry } from '@/lib/api/types';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { captureProjectScope } from '@/lib/api/project-scope';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { substituteCommandVariables, getWorktreeSetupConfig } from '@/lib/yuriConfig';
import { ensureRemoteHostCatalog, getHostRuntimeRegistry } from '@/queries/remoteProjectQueries';
import { useSessionNavigationStore, type RemoteSessionDraftOptions } from '@/stores/useSessionNavigationStore';
import { seedRemoteDraft as seedRemoteProjectDraft } from '@/sync/remote-input-store';
import { createPendingDraftWorktreeRequest, waitForPendingDraftWorktreeRequest, resolvePendingDraftWorktreeRequest, rejectPendingDraftWorktreeRequest } from '@/lib/worktrees/pendingDraftWorktree';
import type { WorktreeMetadata } from '@/types/worktree';
import { useSelectionStore } from '@/sync/selection-store';
import { readSessionModelId, readSessionModelProviderId, readSessionModelVariant } from '@/sync/session-send-selection';

/** Capture the selected Host before any asynchronous work; raw paths never select a Hub API. */
export async function createRemoteWorktreeDraft(
  project: ProjectEntry,
  payload: CreateGitWorktreePayload,
  options: { initialPrompt?: string; title?: string; createSession?: boolean; kind?: 'pr' | 'standard'; createdFromBranch?: string; isSelected: () => boolean },
): Promise<{ path: string; branch: string; id?: string }> {
  if (!project.hostId || !project.hubId) throw new Error('Remote Project Host scope is unavailable');
  const originalNavigation = useSessionNavigationStore.getState().remoteSession;
  const hubScope = captureProjectScope();
  const catalog = await ensureRemoteHostCatalog();
  hubScope.assertCurrent();
  if (!catalog.supported || catalog.hubId !== project.hubId
    || !catalog.projects.some((p) => p.id === project.id && p.hostId === project.hostId && p.path === project.path)) {
    throw new Error('Remote Project is not referenced by the current Hub');
  }
  const registry = getHostRuntimeRegistry(catalog);
  await registry.connectHost(project.hostId);
  const entry = registry.resolve({ hubId: project.hubId, hostId: project.hostId, directory: project.path });
  const scope = captureProjectScope(entry);
  const git = createProjectGitAPI(entry);
  if (!await git.checkIsGitRepository(project.path)) throw new Error('Worktrees can only be created in Git repositories');

  const config = await getWorktreeSetupConfig(project, entry);
  const commands = config.commands;
  const startCommand = Array.isArray(commands) ? commands.filter((v): v is string => typeof v === 'string' && !!v.trim())
    .map((v) => substituteCommandVariables(v.trim(), { rootWorktreePath: project.path })).join(' && ') : undefined;
  const status = await git.getGitStatus(project.path);
  const branches = await git.getGitBranches(project.path);
  const checkouts = await git.listGitWorktrees(project.path);
  const normalizedProject = normalizeDirectoryKey(project.path);
  const owningCheckout = checkouts.map((checkout) => normalizeDirectoryKey(checkout.path))
    .filter((root) => normalizedProject === root || normalizedProject.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
  const relativePath = owningCheckout ? normalizedProject.slice(owningCheckout.length) : '';
  const tracking = branches.branches?.[status.current]?.tracking || status.tracking;
  const remote = tracking?.replace(/^remotes\//, '').split('/')[0];
  const branch = payload.branchName || payload.existingBranch?.replace(/^remotes\//, '');
  const request = { ...payload, ...(startCommand ? { startCommand } : {}),
    ...(remote && branch ? { setUpstream: payload.setUpstream ?? true,
      upstreamRemote: payload.upstreamRemote || remote, upstreamBranch: payload.upstreamBranch || branch } : {}),
    // A remote draft must not send before Git has attached its target directory.
    returnAfterDirectoryCreated: false };
  const preview = await git.previewGitWorktree!(project.path, request);
  if (!preview.path) throw new Error('Remote worktree preview missing path');
  const pendingId = createPendingDraftWorktreeRequest();
  void waitForPendingDraftWorktreeRequest(pendingId).catch(() => undefined);
  const previewDirectory = relativePath ? `${preview.path.replace(/[\\/]+$/, '')}${relativePath}` : preview.path;
  const previewLocation = { ...entry.location, directory: previewDirectory };
  const draft: RemoteSessionDraftOptions & { bootstrapWaitEnabled: boolean } = { title: options.title, initialPrompt: options.initialPrompt,
    bootstrapWaitEnabled: config.wait,
    defaultModel: project.defaultModel ?? undefined, pendingWorktreeRequestId: pendingId,
    bootstrapPendingDirectory: previewDirectory, preserveDirectoryOverride: true,
    bootstrapStatus: { status: 'pending', error: null, updatedAt: Date.now() } };
  try {
    if (options.initialPrompt) await seedRemoteProjectDraft(previewLocation, options.initialPrompt);
    scope.assertCurrent();
  } catch (error) {
    rejectPendingDraftWorktreeRequest(pendingId, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  if (options.isSelected() && useSessionNavigationStore.getState().remoteSession === originalNavigation) {
    useSessionNavigationStore.getState().openRemoteSession(project, previewLocation, null, draft);
  }
  let pendingNavigation = useSessionNavigationStore.getState().remoteSession;
  const openedPending = pendingNavigation?.draft?.pendingWorktreeRequestId === pendingId;
  const ownsPending = () => {
    if (!options.isSelected() || !openedPending) return false;
    const current = useSessionNavigationStore.getState().remoteSession;
    if (current?.sessionId === null && current.projectId === project.id && current.location.hubId === project.hubId
      && current.location.hostId === project.hostId && current.draft?.pendingWorktreeRequestId === pendingId) {
      pendingNavigation = current;
      return true;
    }
    return current === pendingNavigation;
  };
  try {
  const created = await git.createGitWorktree!(project.path, request);
  if (!created.path || !created.name) throw new Error('Remote worktree create missing name/path');
  let bootstrap = created.bootstrapStatus;
  const deadline = Date.now() + 120_000;
  while (bootstrap?.status === 'pending' && config.wait) {
    if (Date.now() >= deadline) throw new Error('Remote worktree setup timed out; the existing draft was retained');
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    scope.assertCurrent();
    bootstrap = await git.getGitWorktreeBootstrapStatus!(created.path);
  }
  if (bootstrap?.status === 'failed') throw new Error(bootstrap.error || 'Remote worktree setup failed');
  scope.assertCurrent();
  const directory = relativePath ? `${created.path.replace(/[\\/]+$/, '')}${relativePath}` : created.path;
  const location = { ...entry.location, directory };
  const metadata: WorktreeMetadata = { name: created.name, path: directory, worktreeRoot: created.path,
    projectDirectory: project.path, relativePath: relativePath.replace(/^\//, '') || undefined,
    branch: created.branch, label: created.branch || created.name, source: 'sdk', worktreeSource: 'created-for-session',
    headState: created.branch ? 'branch' : 'unborn', worktreeStatus: bootstrap?.status === 'pending' ? 'pending' : 'ready',
    createdFromBranch: options.createdFromBranch || status.current || payload.startRef, kind: options.kind ?? 'standard' };
  const settled: RemoteSessionDraftOptions = { pendingWorktreeRequestId: null,
    bootstrapPendingDirectory: null,
    // Background setup remains visible in worktreeMetadata; only an explicitly
    // requested setup wait is a blocking composer barrier after Git attaches.
    worktreeMetadata: metadata, bootstrapStatus: config.wait ? bootstrap ?? { status: 'ready', error: null, updatedAt: Date.now() } : undefined };
  if (directory !== previewDirectory) {
    const { getRemoteInputStore, remoteSessionDraftKey } = await import('@/sync/remote-input-store');
    const input = getRemoteInputStore(location);
    const source = remoteSessionDraftKey(previewLocation, null);
    const previous = input.getState().getDraft(source);
    const moved = await input.getState().moveDraftWithAttachments(source, remoteSessionDraftKey(location, null), previous?.revision);
    if (previous && !moved) throw new Error('Remote draft changed while the worktree target was being finalized; the original draft was retained');
    scope.assertCurrent();
  }
  if (!options.createSession && ownsPending() && pendingNavigation) {
    useSessionNavigationStore.getState().updateRemoteDraft(pendingNavigation, settled, location);
    pendingNavigation = useSessionNavigationStore.getState().remoteSession;
  }
  if (!options.createSession) resolvePendingDraftWorktreeRequest(pendingId, directory);
  let id: string | undefined;
  if (options.createSession) {
    try {
      const service = registry.resolve(location).service();
      const title = ownsPending() ? pendingNavigation?.draft?.title ?? options.title : options.title;
      const session = await service.createSession({ title }, directory);
      id = session.id;
      scope.assertCurrent();
      // Native defaults belong to this Host, never the retained Hub config.
      // A failed optional defaults read does not discard a successfully created session.
      const defaults = await service.getConfig(directory).catch(() => undefined);
      scope.assertCurrent();
      const candidateModel = project.defaultModel || defaults?.model;
      const model = typeof candidateModel === 'string' ? candidateModel : undefined;
      const separator = model?.indexOf('/') ?? -1;
      const providerId = separator > 0 ? model!.slice(0, separator) : readSessionModelProviderId(session);
      const modelId = separator > 0 ? model!.slice(separator + 1) : readSessionModelId(session);
      const candidateAgent = defaults?.default_agent || session.agent;
      const agent = typeof candidateAgent === 'string' ? candidateAgent : undefined;
      const selection = useSelectionStore.getState();
      if (providerId && modelId) selection.saveSessionModelSelection(session.id, providerId, modelId, location);
      if (agent) selection.saveSessionAgentSelection(session.id, agent, location);
      if (agent && providerId && modelId) {
        selection.saveAgentModelForSession(session.id, agent, providerId, modelId, location);
        selection.saveAgentModelVariantForSession(session.id, agent, providerId, modelId, readSessionModelVariant(session), location);
      }
    } catch (error) {
      await git.deleteGitWorktree!(project.path, { directory: created.path, deleteLocalBranch: true }).catch(() => undefined);
      throw error;
    }
  }
  scope.assertCurrent();
  if (options.createSession && ownsPending()) {
    useSessionNavigationStore.getState().openRemoteSession(project, location, id ?? null, { ...pendingNavigation?.draft, ...settled });
  }
  if (options.createSession) resolvePendingDraftWorktreeRequest(pendingId, directory);
  return { path: directory, branch: created.branch, ...(id ? { id } : {}) };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (ownsPending() && pendingNavigation) useSessionNavigationStore.getState().updateRemoteDraft(pendingNavigation, {
      pendingWorktreeRequestId: null, bootstrapPendingDirectory: null,
      bootstrapStatus: { status: 'failed', error: failure.message, updatedAt: Date.now() },
    });
    rejectPendingDraftWorktreeRequest(pendingId, failure);
    throw error;
  }
}

import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { HostLocation } from '@/lib/remote-projects/location';
import { locationKey, REMOTE_NEW_SESSION_DRAFT_ID } from '@/lib/remote-projects/location';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { HostRuntimeProvider, useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { useRemoteHostCatalog, getHostRuntimeRegistry, type RemoteHostSummaries } from '@/queries/remoteProjectQueries';
import { providerCatalogQueryOptions, rawAgentsQueryOptions } from '@/queries/configCatalogQueries';
import { createRemoteSessionState } from '@/sync/remote-session-state';
import { RemoteChatContext, getRemoteChatOwner } from '@/sync/remote-chat-context';
import { getRemoteInputStore, remoteSessionDraftKey, useRemotePendingComposer, remotePendingComposerKey, consumeRemoteComposerResource, requestRemoteComposerInput, seedRemoteDraftSyntheticParts } from '@/sync/remote-input-store';
import { draftKeyString, type DraftSyntheticPart } from '@/sync/input-draft-types';
import { useSelectionStore } from '@/sync/selection-store';
import { readSessionModelId, readSessionModelProviderId, readSessionModelVariant } from '@/sync/session-send-selection';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { uploadPromptAttachmentBytes, blobFromDataUrl, needsPromptAttachmentUpload } from '@/lib/prompt-attachment-upload';
import { postSessionCompact } from '@/sync/session-compaction-api';
import { postSessionRevertStage, postSessionRevertClear, postSessionRevertCommit } from '@/sync/session-revert-api';
import { useSessionInboxOverlayStore } from '@/sync/session-inbox-overlay';
import { cancelUnpromotedInboxItem, steerSessionInbox, queueSessionInbox } from '@/sync/session-prompt-api';
import { ChatInput } from './ChatInput';
import type { ChatInputSurface, ChatInputDeliveryRequest } from './chatInputSurface';
import { SessionSurfaceContext, PRIMARY_SESSION_SURFACE_CAPABILITIES, STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES } from './SessionSurfaceContext';
import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { FormCard } from './FormCard';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { ascendingId } from '@/sync/message-id';
import { fetchForkBoundary } from '@/sync/session-fork-boundary';
import { buildSessionMentionInstruction } from '@/composer/delivery';
import { editSessionInboxIntoDraft } from '@/sync/session-inbox-edit';
import { TranscriptSearch } from './TranscriptSearch';
import { TimelineDialog } from './TimelineDialog';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';
import { buildSentMessageComposerRestoration, commitComposerRestoration } from '@/sync/message-composer-restoration';
import { createDraftAttachmentResourceAdapter } from '@/sync/draft-attachment-resource-adapter';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useRemoteSessionViewed } from '@/sync/useRemoteSessionViewed';
import { resolveRetryActionCopy } from '@/sync/session-retry-action';
import type { I18nKey } from '@/lib/i18n';
import { NativeSessionInboxChips } from './QueuedMessageChips';
import ToolOutputDialog from './message/ToolOutputDialog';
import { StatusRow } from './StatusRow';
import { ComposerFoot, DraftComposerFoot } from './ComposerFoot';
import type { ToolPopupContent } from './message/types';
import { parseSlashCommandInvocation } from '@/composer/inline-visual';
import { skillAttachmentsFromText } from '@/composer/skill-attachments';

type Props = { location: HostLocation; sessionId: string | null; active?: boolean; readOnly?: boolean; composerPresentation?: 'primary' | 'panel'; onNavigateSession?: (sessionId: string, directory: string) => void; viewport?: typeof import('./ChatContainer').ChatViewport };
const EMPTY_INBOX: never[] = [];
const EMPTY_INLINE: InlineCommentDraft[] = [];

/** Main ChatContainer's remote branch: the existing message list/editor, explicit Host authority. */
export function RemoteChatContainer(props: Props) {
  const inherited = useHostRuntime();
  if (inherited && inherited.entry.key === locationKey(props.location)) {
    return <RemoteChatOwner {...props} registry={inherited.registry} />;
  }
  return <RemoteChatDiscovery {...props} />;
}

function RemoteChatDiscovery(props: Props) {
  const catalog = useRemoteHostCatalog(true);
  const { t } = useI18n();
  if (!catalog.data?.supported || catalog.data.hubId !== props.location.hubId) {
    return <div role={catalog.error ? 'alert' : 'status'} className="p-4 typography-meta text-muted-foreground">
      {catalog.error ? String(catalog.error.message) : catalog.data ? t('remoteProjects.unsupported') : t('common.loading')}
    </div>;
  }
  const registry = getHostRuntimeRegistry(catalog.data);
  return <HostRuntimeProvider registry={registry} location={props.location}>
    <RemoteChatOwner {...props} registry={registry} />
  </HostRuntimeProvider>;
}

function RemoteChatOwner(props: Props & { registry: HostRuntimeRegistry }) {
  const runtime = useHostRuntime()!;
  const owner = React.useMemo(() => getRemoteChatOwner(props.registry, runtime.entry), [props.registry, runtime.entry]);
  React.useEffect(() => owner.retain(), [owner]);
  const state = owner.state;
  useRemoteSessionViewed(props.registry, state.entry, props.sessionId, props.active !== false);
  return <RemoteChatContext.Provider value={state}><RemoteChatView {...props} state={state} /></RemoteChatContext.Provider>;
}

function RemoteChatView({ location, sessionId, active = true, readOnly = false, composerPresentation = 'panel', onNavigateSession, viewport: Viewport, state }: Props & { state: ReturnType<typeof createRemoteSessionState> }) {
  const { t } = useI18n();
  const entry = state.entry;
  const useInputStore = React.useMemo(() => getRemoteInputStore(location), [location]);
  const remoteNavigation = useSessionNavigationStore((store) => store.remoteSession);
  const draftOptions = remoteNavigation && remoteNavigation.sessionId === sessionId && locationKey(remoteNavigation.location) === locationKey(location) ? remoteNavigation.draft : undefined;
  const assertWritable = useEvent(() => {
    if (!active || readOnly) throw new Error('Remote chat is read-only');
    entry.sdk();
  });
  const transportIdentity = getRuntimeTransportIdentity();
  const runtimeGeneration = getRuntimeGeneration();
  const [error, setError] = React.useState<string | null>(null);
  const [observationError, setObservationError] = React.useState<string | null>(null);
  const report = useEvent((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  React.useEffect(() => {
    setObservationError(null);
    if (!active || !sessionId) return;
    return state.observe(sessionId, (error) => setObservationError(error instanceof Error ? error.message : String(error)), () => setObservationError(null));
  }, [state, active, sessionId]);
  const refreshOnForeground = useEvent(() => {
    if (!active || !sessionId || document.visibilityState === 'hidden') return;
    void Promise.all([state.repository.refreshFromAuthority(state.scope(sessionId)), state.refreshMetadata(sessionId)]).catch(report);
  });
  useEventListener('focus', refreshOnForeground);
  useEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshOnForeground(); }, () => document);
  const subscribe = React.useMemo(() => (notify: () => void) => sessionId
    ? state.repository.subscribe(state.scope(sessionId), notify) : () => {}, [state, sessionId]);
  const getTranscript = React.useMemo(() => () => sessionId ? state.repository.getTranscript(state.scope(sessionId)) : null, [state, sessionId]);
  const data = React.useSyncExternalStore(subscribe, getTranscript, getTranscript);
  const snapshot = React.useSyncExternalStore(state.subscribeSnapshot, () => state.getSnapshot(sessionId ?? ''), () => state.getSnapshot(sessionId ?? ''));
  const inbox = useSessionInboxOverlayStore((store) => sessionId ? store.bySession[state.sessionKey(sessionId)] ?? EMPTY_INBOX : EMPTY_INBOX);
  const sending = Boolean(snapshot.pendingSendMessageID) || inbox.some((item) => item.delivery === 'steer' && Boolean(data?.messagesByID[item.id]));
  const messages = React.useMemo(() => {
    if (!data) return [];
    const boundary = snapshot.session?.revert?.messageID;
    const cut = boundary ? data.messageOrder.indexOf(boundary) : -1;
    return (cut >= 0 ? data.messageOrder.slice(0, cut) : data.messageOrder).map((id) => ({ info: data.messagesByID[id], parts: (data.partsByMessageID[id] ?? []) as import('@/lib/opencode/v2-types').Part[] }));
  }, [data, snapshot.session?.revert?.messageID]);
  const busy = sending || snapshot.status?.type === 'busy' || snapshot.status?.type === 'retry';
  const retryActionCopy = React.useMemo(() => resolveRetryActionCopy(snapshot.status, (key) => t(key as I18nKey)), [snapshot.status, t]);
  const [catalogDemand, setCatalogDemand] = React.useState(false);
  const requestCatalog = useEvent((open: boolean) => setCatalogDemand(open));
  const modelPickerOpen = useUIStore((store) => store.isModelSelectorOpen || store.isAgentSelectorOpen);
  const providersQuery = useQuery({ ...providerCatalogQueryOptions(location.directory, transportIdentity, entry), enabled: active && (catalogDemand || modelPickerOpen), staleTime: Infinity, gcTime: Infinity });
  const client = useQueryClient();
  const policyKey = [...entry.queryScope, 'permission-policy'];
  const policy = useQuery({ queryKey: policyKey, enabled: active && Boolean(sessionId), queryFn: async ({ signal }) => {
    const response = await entry.fetch('/api/permission-auto-accept', { signal });
    if (!response.ok) throw new Error(`Remote permission policy (${response.status})`);
    const payload = await response.json() as { sessions?: Record<string, boolean> };
    entry.sdk();
    if (!payload.sessions || typeof payload.sessions !== 'object') throw new Error('Invalid remote permission policy');
    return payload.sessions;
  } });
  const policyMutation = useMutation({ mutationFn: async (enabled: boolean) => {
    assertWritable();
    if (!sessionId) throw new Error('Remote session required');
    const response = await entry.fetch(`/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, directory: location.directory }),
    });
    if (!response.ok) throw new Error(`Remote permission policy (${response.status})`);
    const payload = await response.json() as { sessions?: Record<string, boolean> };
    entry.sdk();
    if (!payload.sessions || typeof payload.sessions !== 'object') throw new Error('Invalid remote permission policy');
    client.setQueryData(policyKey, payload.sessions);
  } });
  const agentsQuery = useQuery({ ...rawAgentsQueryOptions(location.directory, transportIdentity, entry), enabled: active && (Boolean(sessionId) || catalogDemand || modelPickerOpen), staleTime: Infinity, gcTime: Infinity });
  const providers = React.useMemo(() => providersQuery.data?.providers.map((provider) => ({ ...provider, models: Object.values(provider.models) })) ?? [], [providersQuery.data]);
  const [picks, setPicks] = React.useState<Record<string, ChatInputSurface['selection']['value']>>({});
  const selectionKey = state.sessionKey(sessionId ?? 'new');
  const picked = picks[selectionKey];
  const selectionSessionID = sessionId ?? REMOTE_NEW_SESSION_DRAFT_ID;
  const rememberedModel = useSelectionStore((store) => store.getSessionModelSelection(selectionSessionID, location));
  const rememberedAgent = useSelectionStore((store) => store.getSessionAgentSelection(selectionSessionID, location));
  const session = snapshot.session;
  const catalogDefault = React.useMemo(() => {
    const catalog = providersQuery.data;
    if (!catalog) return undefined;
    for (const [providerID, modelID] of Object.entries(catalog.default ?? {})) {
      if (catalog.providers.some((provider) => provider.id === providerID && provider.models[modelID])) return { providerID, modelID };
    }
    return undefined;
  }, [providersQuery.data]);
  const defaultModelSeparator = draftOptions?.defaultModel?.indexOf('/') ?? -1;
  const defaultProviderID = defaultModelSeparator > 0 ? draftOptions?.defaultModel?.slice(0, defaultModelSeparator) : undefined;
  const defaultModelID = defaultModelSeparator > 0 ? draftOptions?.defaultModel?.slice(defaultModelSeparator + 1) : undefined;
  const baseSelection = React.useMemo(() => ({
    providerID: picked?.providerID ?? rememberedModel?.providerId ?? (session && readSessionModelProviderId(session)) ?? defaultProviderID ?? catalogDefault?.providerID,
    modelID: picked?.modelID ?? rememberedModel?.modelId ?? (session && readSessionModelId(session)) ?? defaultModelID ?? catalogDefault?.modelID,
    agent: picked?.agent ?? rememberedAgent ?? session?.agent ?? agentsQuery.data?.[0]?.name,
    variant: picked ? picked.variant : (session && readSessionModelVariant(session)) ?? undefined,
  }), [picked, session, agentsQuery.data, rememberedModel, rememberedAgent, defaultProviderID, defaultModelID, catalogDefault]);
  const rememberedVariant = useSelectionStore((store) => baseSelection.agent && baseSelection.providerID && baseSelection.modelID
    ? store.getAgentModelVariantForSession(selectionSessionID, baseSelection.agent, baseSelection.providerID, baseSelection.modelID, location) : undefined);
  const selection = React.useMemo(() => ({ ...baseSelection,
    variant: picked ? picked.variant : rememberedVariant ?? baseSelection.variant,
  }), [baseSelection, picked, rememberedVariant]);
  const draftKey = React.useMemo(() => remoteSessionDraftKey(location, sessionId), [location, sessionId]);
  const draftID = draftKeyString(draftKey);
  useInputStore((store) => store.drafts[draftID]?.attachments);
  useInputStore((store) => store.draftAttachmentViews[draftID]);
  const attachments = useInputStore.getState().getDraftAttachmentViews(draftKey);
  const attachmentAdapter = React.useMemo(() => createDraftAttachmentResourceAdapter(draftKey, () => useInputStore.getState()), [draftKey, useInputStore]);
  React.useEffect(() => {
    let cancelled = false;
    void useInputStore.getState().hydrateDraftMetadata(draftKey.transportIdentity).then(async (ready) => {
      if (!ready) throw new Error('Remote draft storage unavailable');
      if (!cancelled) {
        await useInputStore.getState().hydrateDraftAttachments(draftKey);
        if (cancelled) return;
        if (!sessionId && draftOptions?.syntheticParts) await seedRemoteDraftSyntheticParts(location, draftOptions.syntheticParts);
        if (!sessionId && draftOptions?.initialPrompt && !useInputStore.getState().getDraft(draftKey)?.text) requestRemoteComposerInput(location, sessionId, { text: draftOptions.initialPrompt, mode: 'replace' });
      }
    }).catch(report);
    return () => { cancelled = true; };
  }, [useInputStore, draftKey, report, draftOptions?.initialPrompt, draftOptions?.syntheticParts, location, sessionId]);
  const pending = useRemotePendingComposer((store) => store.entries[remotePendingComposerKey(location, sessionId)]);
  const inlineKey = state.sessionKey(sessionId ?? 'draft');
  const inlineDrafts = useInlineCommentDraftStore((store) => store.drafts[inlineKey] ?? EMPTY_INLINE);
  const consumedSynthetic = React.useMemo(() => ({ draftID, parts: new Map<string, DraftSyntheticPart>() }), [draftID]).parts;
  const initialSelections = React.useRef(new Set<string>());
  const navigate = useEvent((id: string, directory = location.directory, draft?: typeof draftOptions) => {
    if (onNavigateSession) { onNavigateSession(id, directory); return; }
    const store = useProjectsStore.getState();
    const project = store.projects.find((project) => project.id === store.activeProjectId && project.hostId === location.hostId);
    if (!project) throw new Error('Remote Project is no longer selected');
    useSessionNavigationStore.getState().openRemoteSession(project, { ...location, directory }, id, draft);
  });
  const send = useEvent(async (request: ChatInputDeliveryRequest) => {
    assertWritable();
    const references = request.references ?? [];
    for (const reference of references) {
      if (reference.type === 'session' && reference.target && (reference.target.hubId !== location.hubId
        || reference.target.hostId !== location.hostId || reference.target.instanceId !== entry.location.instanceId)) {
        throw new Error('Session reference belongs to another Host authority');
      }
    }
    if (request.inputMode !== 'shell' && /^\/timeline\s*$/i.test(request.text ?? '')) {
      useUIStore.getState().setTimelineDialogOpen(true);
      return;
    }
    // Cold drafts do no background model enumeration. The explicit send action
    // ensures the authoritative default only when no user/session choice exists.
    let sendSelection = request.providerID && request.modelID ? { providerID: request.providerID, modelID: request.modelID, agent: request.agent, variant: request.variant } : undefined;
    if (!sendSelection && (request.options?.delivery !== 'queue' || !request.sessionID)) {
      const catalog = await client.fetchQuery(providerCatalogQueryOptions(location.directory, transportIdentity, entry));
      assertWritable();
      const configured = Object.entries(catalog.default).find(([providerID, modelID]) => catalog.providers.some((provider) => provider.id === providerID && provider.models[modelID]));
      if (!configured) throw new Error('Remote default model unavailable; select a model');
      sendSelection = { providerID: configured[0], modelID: configured[1], agent: request.agent, variant: request.variant };
    }
    const draftTextAtStart = useInputStore.getState().getDraft(draftKey)?.text;
    const submittedSynthetic = new Set(useInputStore.getState().getDraft(draftKey)?.syntheticParts.map((part) => part.partID) ?? []);
    let id = request.sessionID;
    if (!id) {
      if (draftOptions?.pendingWorktreeRequestId || draftOptions?.bootstrapStatus?.status === 'pending' && draftOptions.bootstrapWaitEnabled !== false) throw new Error('Remote worktree is still preparing');
      if (draftOptions?.bootstrapStatus?.status === 'failed') throw new Error(draftOptions.bootstrapStatus.error || 'Remote worktree setup failed');
      const created = await entry.service().createSession({ ...(draftOptions?.title ? { title: draftOptions.title } : {}), ...(draftOptions?.parentID ? { parentID: draftOptions.parentID } : {}) }, location.directory);
      id = created.id;
      initialSelections.current.add(id);
      // Keep a failed first prompt on its created session rather than creating duplicates.
      const input = useInputStore.getState();
      const destination = remoteSessionDraftKey(location, id);
      await input.moveDraftWithAttachments(draftKey, destination);
      if (sendSelection) {
        setPicks((previous) => ({ ...previous, [state.sessionKey(id!)]: sendSelection }));
        state.selectModel(id, sendSelection.providerID, sendSelection.modelID);
        if (sendSelection.agent) state.selectAgent(id, sendSelection.agent);
      }
      navigate(id, location.directory, draftOptions);
    }
    if (draftOptions) {
      if (draftOptions.permissionAutoAcceptEnabled) {
        const response = await entry.fetch(`/api/permission-auto-accept/sessions/${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, directory: location.directory }),
        });
        if (!response.ok) throw new Error(`Remote permission policy (${response.status})`);
        entry.sdk();
        void client.invalidateQueries({ queryKey: policyKey });
      }
      if (draftOptions.targetFolderId) {
        const folders = await client.fetchQuery({ queryKey: [...entry.queryScope, 'session-folders'], staleTime: 0, queryFn: async ({ signal }) => {
          const response = await entry.fetch('/api/session-folders', { signal });
          if (!response.ok) throw new Error(`Remote session folders (${response.status})`);
          const value = await response.json() as NonNullable<RemoteHostSummaries['folders']>;
          entry.sdk();
          if (!value.foldersMap || typeof value.foldersMap !== 'object') throw new Error('Invalid remote session folders');
          return value;
        } });
        const existing = folders.foldersMap[location.directory];
        if (!Array.isArray(existing) || !existing.some((folder) => folder.id === draftOptions.targetFolderId)) throw new Error('Remote target folder no longer exists');
        const foldersMap = { ...folders.foldersMap, [location.directory]: existing.map((folder) => ({ ...folder, sessionIds: [...folder.sessionIds.filter((sessionID) => sessionID !== id), ...(folder.id === draftOptions.targetFolderId ? [id] : [])] })) };
        const response = await entry.fetch('/api/session-folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...folders, foldersMap, updatedAt: Date.now() }) });
        if (!response.ok) throw new Error(`Remote session folders (${response.status})`);
        entry.sdk();
        client.setQueryData([...entry.queryScope, 'session-folders'], { ...folders, foldersMap });
      }
      navigate(id);
    }
    const creationParts = request.sessionID === null ? (draftOptions?.syntheticParts ?? []).filter((part, index) => !submittedSynthetic.has(part.partID ?? `remote-draft-metadata:${index}`)) : [];
    const outboundAttachments = [...new Map([...(request.attachments ?? []), ...[...(request.parts ?? []), ...creationParts].flatMap((part) => part.attachments ?? [])].map((file) => [file.id, file])).values()];
    const files = await Promise.all(outboundAttachments.map(async (file) => {
      let uri = file.dataUrl;
      if (needsPromptAttachmentUpload(uri)) {
        const body = file.file ?? blobFromDataUrl(uri, file.mimeType);
        if (!body) throw new Error('Remote attachment bytes unavailable');
        uri = (await uploadPromptAttachmentBytes({ body, mime: file.mimeType, filename: file.filename, scope: entry })).url;
      }
      return { uri, name: file.filename };
    }));
    assertWritable();
    const sessionIDs = [...new Set(references.flatMap((reference) => reference.type === 'session' ? [reference.sessionId] : []))];
    const sessionContext = buildSessionMentionInstruction(await Promise.all(sessionIDs.map(async (sessionID) => {
      const referenced = await entry.service().getSession(sessionID);
      assertWritable();
      return { id: sessionID, title: referenced.title || sessionID, directory: referenced.directory, messages: [] };
    })));
    const text = [request.text ?? '', ...[...(request.parts ?? []), ...creationParts].map((part) => part.text), ...(request.systemContext ?? []).map((part) => part.text), sessionContext].filter(Boolean).join('\n\n');
    const skills = [...new Set([...skillAttachmentsFromText(request.text ?? '').map((skill) => skill.id),
      ...references.flatMap((reference) => reference.type === 'skill' ? [reference.skillName] : [])])].map((id) => ({ id }));
    const agents = request.agentMention ? [{ name: request.agentMention }] : undefined;
    const invocation = parseSlashCommandInvocation(text);
    const command = invocation ? [text, invocation.commandName, invocation.argumentsText] : null;
    // A new session must establish its initial user choice even if its first
    // input is queued. Existing-session enqueue never changes runner selection.
    if (initialSelections.current.has(id) && request.options?.delivery === 'queue' && sendSelection) {
      await entry.service().applySendSelection(id, { model: { providerID: sendSelection.providerID, id: sendSelection.modelID,
        ...(sendSelection.variant ? { variant: sendSelection.variant } : {}) }, ...(sendSelection.agent ? { agent: sendSelection.agent } : {}) }, location.directory);
      initialSelections.current.delete(id);
    }
    if (command?.[1] === 'compact') return postSessionCompact({ scope: entry, sessionID: id, directory: location.directory });
    if (command?.[1] === 'undo') {
      const target = [...messages].reverse().find((row) => row.info.role === 'user');
      if (!target) throw new Error('Remote undo boundary unavailable');
      await postSessionRevertStage({ scope: entry, sessionID: id, messageID: target.info.id, files: true });
      await state.refreshMetadata(id); return;
    }
    if (command?.[1] === 'redo') { await postSessionRevertClear({ scope: entry, sessionID: id }); await state.refreshMetadata(id); return; }
    if (command?.[1] === 'fork') {
      const before = await fetchForkBoundary(entry.sdk(), id, undefined, busy, () => { try { entry.sdk(); return true; } catch { return false; } });
      const fork = await entry.service().forkSession(id, before, location.directory); navigate(fork.id); return;
    }
    if ((command || request.inputMode === 'shell') && request.options?.delivery !== 'queue' && sendSelection) {
      await entry.service().applySendSelection(id, { model: { providerID: sendSelection.providerID, id: sendSelection.modelID, ...(sendSelection.variant ? { variant: sendSelection.variant } : {}) }, ...(sendSelection.agent ? { agent: sendSelection.agent } : {}) }, location.directory);
    }
    if (request.inputMode === 'shell') return entry.sdk().session.shell({ sessionID: id, command: text });
    if (command) return entry.sdk().session.command({ sessionID: id, name: command[1], text: command[2] ?? '', files, skills, agents, delivery: request.options?.delivery === 'queue' ? 'queue' : 'steer' });
    if (snapshot.session?.revert) await postSessionRevertCommit({ scope: entry, sessionID: id, directory: location.directory });
    const result = await state.send({ sessionID: id, messageID: request.options?.messageID ?? ascendingId('msg'), text, files, skills, agents,
      delivery: request.options?.delivery === 'queue' ? 'queue' : 'steer',
      selection: sendSelection });
    initialSelections.current.delete(id);
    if (request.sessionID === null) {
      const destination = remoteSessionDraftKey(location, id);
      const input = useInputStore.getState();
      if (input.getDraft(destination)?.text === draftTextAtStart) input.setDraftText(destination, '');
      const destinationAdapter = createDraftAttachmentResourceAdapter(destination, () => useInputStore.getState());
      for (const file of outboundAttachments) await destinationAdapter.removeByAttachmentID(file.id);
      // The source draft has moved; only consume the parts captured before creation.
      if (submittedSynthetic.size) input.consumeDraftSyntheticParts(destination, (part) => !submittedSynthetic.has(part.partID));
    }
    setError(null);
    return result;
  });
  const change = useEvent((next: ChatInputSurface['selection']['value']) => {
    assertWritable();
    setPicks((previous) => ({ ...previous, [selectionKey]: next }));
    if (next.providerID && next.modelID) state.selectModel(selectionSessionID, next.providerID, next.modelID);
    if (next.agent) state.selectAgent(selectionSessionID, next.agent);
    if (next.agent && next.providerID && next.modelID) useSelectionStore.getState().saveAgentModelVariantForSession(
      selectionSessionID, next.agent, next.providerID, next.modelID, next.variant, location);
  });
  const selectionStillCurrent = useEvent((key: string) => key === selectionKey);
  const history = React.useMemo(() => messages.filter((row) => row.info.role === 'user').map((row) => row.parts.flatMap((part) => part.type === 'text' && !part.synthetic ? [part.text] : []).join('\n')).filter(Boolean), [messages]);
  const resources = {
    inputStore: useInputStore,
    busy: false, attachments,
    addAttachment: attachmentAdapter.addLocal,
    removeAttachment: attachmentAdapter.removeByAttachmentID,
    clearAttachments: attachmentAdapter.clearRootAttachments,
    restoreAttachments: attachmentAdapter.restoreRootAttachments,
    pendingInput: pending?.input ?? null, consumePendingInput: () => consumeRemoteComposerResource(location, sessionId, 'input'),
    pendingPreset: pending?.preset ?? null, consumePendingPreset: () => consumeRemoteComposerResource(location, sessionId, 'preset'),
    consumeSyntheticParts: () => {
      const input = useInputStore.getState();
      const views = input.getDraftAttachmentViews(draftKey);
      consumedSynthetic.clear();
      return input.consumeDraftSyntheticParts(draftKey)?.map((part) => {
        consumedSynthetic.set(part.partID, part);
        return { partID: part.partID, text: part.text, synthetic: part.synthetic,
          attachments: part.attachments.flatMap((metadata) => views.filter((view) => view.id === metadata.attachmentID)) };
      }) ?? null;
    },
    restoreSyntheticParts: (parts: readonly import('@/sync/input-store').SyntheticContextPart[]) => {
      const input = useInputStore.getState();
      const current = input.getDraft(draftKey)?.syntheticParts ?? [];
      const restored = parts.map((part) => {
        const captured = part.partID ? consumedSynthetic.get(part.partID) : undefined;
        if (!captured && part.attachments?.length) throw new Error('Remote synthetic attachment metadata unavailable');
        return captured ?? { partID: part.partID ?? crypto.randomUUID(), text: part.text, synthetic: part.synthetic, attachments: [] };
      });
      const ids = new Set(restored.map((part) => part.partID));
      input.setDraftSyntheticParts(draftKey, [...restored, ...current.filter((part) => !ids.has(part.partID))]);
      for (const id of ids) consumedSynthetic.delete(id);
    },
    inlineDrafts, removeInlineDraft: (id: string) => useInlineCommentDraftStore.getState().removeDraft(inlineKey, id),
    restoreInlineDrafts: (drafts: readonly InlineCommentDraft[]) => useInlineCommentDraftStore.setState((store) => {
      const restored = new Set(drafts.map((draft) => draft.id));
      return { drafts: { ...store.drafts, [inlineKey]: [...drafts, ...(store.drafts[inlineKey] ?? []).filter((draft) => !restored.has(draft.id))] } };
    }),
    history,
    captureRuntime: useInputStore.getState().captureDraftRuntime, getDraft: useInputStore.getState().getDraft,
    abortPrompt: { sessionID: null, clear: () => {} },
  };
  const surface: ChatInputSurface = {
    composerPresentation,
    nativeInbox: null,
    kind: 'secondary', surfaceID: state.sessionKey(sessionId ?? 'new'), active: active && !readOnly,
    sessionID: sessionId ?? 'remote-new-session', directory: location.directory, draftKey, transportIdentity, runtimeGeneration,
    deliveryTarget: { kind: 'primary' }, queue: { scope: null },
    commands: { sessionID: sessionId, hasMessages: messages.length > 0, hasNewDraft: !sessionId },
    selection: { value: selection, change, requestCatalog, flush: async () => { assertWritable(); }, catalog: { providers, agents: agentsQuery.data ?? [], ready: !catalogDemand && !modelPickerOpen || providersQuery.isSuccess && agentsQuery.isSuccess, error: providersQuery.isError || agentsQuery.isError } },
    resources, activity: { phase: snapshot.status?.type ?? 'unknown', canAbort: busy },
    permissionPolicy: sessionId && policy.data ? { enabled: policy.data[sessionId] === true, saving: policyMutation.isPending, change: (enabled) => policyMutation.mutateAsync(enabled) } : undefined,
    backend: { send, sendQueued: send, create: send,
      compact: async () => { assertWritable(); if (sessionId) await postSessionCompact({ scope: entry, sessionID: sessionId, directory: location.directory }); },
      abort: async () => { assertWritable(); if (sessionId) await state.interrupt(sessionId); } },
    shortcuts: {
      cycle: async (direction) => {
        assertWritable();
        const key = selectionKey;
        const catalog = agentsQuery.data ?? await client.fetchQuery(rawAgentsQueryOptions(location.directory, transportIdentity, entry));
        assertWritable();
        if (!selectionStillCurrent(key)) return;
        if (!catalog) throw new Error('Remote Agent catalog unavailable');
        const agents = catalog.filter((agent) => agent.mode !== 'subagent' && !agent.hidden);
        if (!agents.length) return;
        const index = agents.findIndex((agent) => agent.name === selection.agent);
        change({ ...selection, agent: agents[(index + direction + agents.length) % agents.length].name });
      },
      new: async () => {
        assertWritable();
        if (onNavigateSession) {
          const created = await entry.service().createSession(undefined, location.directory);
          navigate(created.id);
          return;
        }
        const store = useProjectsStore.getState();
        const project = store.projects.find((project) => project.id === store.activeProjectId && project.hubId === location.hubId && project.hostId === location.hostId);
        if (!project) throw new Error('Remote Project is no longer selected');
        useSessionNavigationStore.getState().openRemoteSession(project, location, null);
      },
      abort: () => { assertWritable(); if (sessionId) void state.interrupt(sessionId).catch(report); },
      submit: () => { assertWritable(); },
    },
  };
  const revert = useEvent(async (messageID: string) => {
    assertWritable();
    if (!sessionId) return;
    await postSessionRevertStage({ scope: entry, sessionID: sessionId, messageID, files: true });
    await state.refreshMetadata(sessionId);
  });
  const fork = useEvent(async (messageID: string) => {
    assertWritable();
    if (!sessionId) return;
    const before = await fetchForkBoundary(entry.sdk(), sessionId, messageID, busy, () => {
      try { entry.sdk(); return true; } catch { return false; }
    });
    const created = await entry.service().forkSession(sessionId, before, location.directory);
    navigate(created.id);
  });
  const sessionSurface = { kind: 'primary' as const, surfaceId: surface.surfaceID, sessionId, directory: location.directory, active,
    capabilities: active && !readOnly ? PRIMARY_SESSION_SURFACE_CAPABILITIES : STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES, navigateSession: navigate, onRevertMessage: revert, onForkMessage: fork,
    onEditMessage: async (messageID: string) => {
      assertWritable();
      if (!sessionId) return;
      const input = useInputStore.getState();
      const expectedRevision = input.getDraft(draftKey)?.revision ?? 'absent';
      const runtime = input.captureDraftRuntime();
      const record = normalizeSessionProjectionMessage(sessionId, await entry.sdk().session.message({ sessionID: sessionId, messageID }));
      if (!record) throw new Error('Remote edit message unavailable');
      const payload = await buildSentMessageComposerRestoration(record.parts as unknown as Record<string, unknown>[], { directory: location.directory });
      entry.sdk();
      await postSessionRevertStage({ scope: entry, sessionID: sessionId, messageID, files: false });
      const result = await commitComposerRestoration({ key: draftKey, expectedRevision, payload, runtime, input });
      if (result.status !== 'committed' || !result.current) throw new Error('Remote edit draft changed');
      await state.refreshMetadata(sessionId);
    },
  };
  const isMobile = useUIStore((store) => store.isMobile);
  const expanded = useUIStore((store) => store.isExpandedInput);
  const stickyUserHeader = useUIStore((store) => store.stickyUserHeader);
  const promptNavigator = useUIStore((store) => store.promptNavigatorEnabled);
  const timelineOpen = useUIStore((store) => store.isTimelineDialogOpen);
  const setTimelineOpen = useUIStore((store) => store.setTimelineDialogOpen);
  const listRef = React.useRef<MessageListHandle | null>(null);
  const [anchorToken, armAnchor] = React.useReducer((n: number) => n + 1, 0);
  const follow = useChatAutoFollow({ scrollControllerRef: listRef, enabled: active, currentSessionId: sessionId,
    viewportKey: state.sessionKey(sessionId ?? 'new'), sessionMessageCount: messages.length, sessionIsWorking: busy, isMobile });
  const loadMore = useEvent(async () => { if (sessionId) await state.repository.fetchPreviousPage(state.scope(sessionId)); });
  const historyMeta = data ? { limit: data.boundary.loadedTurns, cursor: data.boundary.kind === 'has-more' ? data.boundary.cursor : undefined,
    complete: data.boundary.kind === 'exhausted', loading: false, canLoadEarlier: data.boundary.kind !== 'exhausted' } : null;
  const timeline = useChatTimelineController({ sessionId, directory: location.directory, messages, historyMeta,
    scrollRef: follow.scrollRef, messageListRef: listRef, loadMoreMessages: loadMore,
    goToBottom: follow.goToBottom, releaseAutoFollow: follow.releaseAutoFollow,
    beginHistoryViewportPreservation: follow.beginHistoryViewportPreservation, endHistoryViewportPreservation: follow.endHistoryViewportPreservation,
    isPinned: follow.isPinned, showScrollButton: follow.showScrollButton, isMobile, onWillLoadEarlier: armAnchor });
  const [inboxPopup, setInboxPopup] = React.useState<ToolPopupContent | null>(null);
  const inboxAction = useEvent(async (action: 'steer' | 'queue' | 'cancel', inboxID: string) => {
    assertWritable();
    if (!sessionId) return;
    const input = { scope: entry, sessionID: sessionId, inboxID, directory: location.directory };
    await (action === 'steer' ? steerSessionInbox(input) : action === 'queue' ? queueSessionInbox(input) : cancelUnpromotedInboxItem(input));
  });
  const editInbox = useEvent(async (inboxID: string) => {
    assertWritable();
    if (!sessionId) return;
    const restored = await editSessionInboxIntoDraft({ scope: entry, sessionID: sessionId, inboxID, directory: location.directory,
      inputStore: useInputStore,
      targetKey: draftKey, expectedRevision: useInputStore.getState().getDraft(draftKey)?.revision ?? 'absent', runtimeGeneration,
      isCurrent: () => { try { entry.sdk(); return true; } catch { return false; } } });
    if (!restored) throw new Error('Remote inbox draft changed');
  });
  const nativeInboxAction = useEvent((action: 'edit' | 'steer' | 'queue' | 'cancel', id: string) => action === 'edit' ? editInbox(id) : inboxAction(action, id));
  surface.nativeInbox = <NativeSessionInboxChips items={inbox.filter((item) => !data?.messagesByID[item.id])} readOnly={readOnly || !active} onAction={nativeInboxAction} onShowPopup={setInboxPopup} />;
  const transcriptStatusRow = <StatusRow isWorking={busy} isGenericStatus={!sending} showTodos={false}
    statusText={busy ? t(sending ? 'chat.assistantStatus.sendingMessage' : 'chat.assistantStatus.working') : null}
    isWaitingForPermission={snapshot.permissions.length > 0} isTurnSettled={!sending && snapshot.status?.type === 'idle'}
    retryInfo={snapshot.status?.type === 'retry' ? snapshot.status : null} agentName={selection.agent}
    showAssistantStatus={busy || snapshot.permissions.length > 0} />;
  return <SessionSurfaceContext.Provider value={sessionSurface}>
    <div className="relative flex h-full min-h-0 flex-col bg-background" data-remote-chat={locationKey(location)}>
      {(catalogDemand || modelPickerOpen) && (providersQuery.error || agentsQuery.error) ? <div role="alert" className="px-3 py-2 typography-meta text-[var(--status-error)]">
        {String(providersQuery.error?.message ?? agentsQuery.error?.message)}
        <Button size="xs" onClick={() => { void Promise.all([providersQuery.refetch(), agentsQuery.refetch()]); }}>{t('chat.history.retry')}</Button>
      </div> : null}
      {error || observationError ? <div role="alert" className="px-3 py-2 typography-meta text-[var(--status-error)]">{error ?? observationError}<Button size="xs" onClick={() => { if (sessionId) void Promise.all([state.repository.refreshFromAuthority(state.scope(sessionId)), state.refreshMetadata(sessionId)]).then(() => { setError(null); setObservationError(null); }).catch(report); }}>{t('chat.history.retry')}</Button></div> : null}
      {sessionId || isMobile ? <TranscriptSearch messages={messages} enabled={active && !expanded} canOpen={() => !document.querySelector('[role="dialog"]')} onNavigate={follow.releaseAutoFollow}>
      {Viewport ? <Viewport currentSessionId={sessionId ?? 'remote-new-session'} virtualizerKey={surface.surfaceID}
        timelineHistoryAnchorToken={anchorToken} isDesktopExpandedInput={expanded} isMobile={isMobile} stickyUserHeader={stickyUserHeader}
        directory={location.directory} scrollRef={follow.scrollRef} messageListRef={listRef} pendingRevealWork={timeline.pendingRevealWork}
        renderedMessages={timeline.renderedMessages} isLoadingOlder={timeline.isLoadingOlder} sessionIsWorking={busy}
        streamingMessageId={null} activeStreamingPhase={null} retryOverlay={sessionId && snapshot.status?.type === 'retry' ? { sessionId, message: snapshot.status.message } : null}
        handleMessageContentChange={follow.notifyContentChange} getAnimationHandlers={follow.getAnimationHandlers}
        handleHistoryScroll={timeline.handleHistoryScroll} scrollToBottom={() => follow.goToBottom()}
        sessionQuestions={!readOnly && active ? snapshot.questions : []} sessionPermissions={!readOnly && active ? snapshot.permissions : []}
        sessionForms={!readOnly && active ? snapshot.forms : []} retryActionCopy={retryActionCopy} isProgrammaticFollowActive={follow.isFollowingProgrammatically}
        showLoadOlderButton={data?.boundary.kind === 'has-more'} turnIds={timeline.turnIds} activeTurnId={timeline.activeTurnId}
        onSelectTurn={(id) => void timeline.scrollToTurn(id)} showPromptNavigator={!isMobile && promptNavigator}
        canLoadEarlierPrompts={timeline.historySignals.canLoadEarlier} isLoadingOlderPrompts={timeline.isLoadingOlder}
        onLoadEarlierPrompts={() => void timeline.loadEarlier({ userInitiated: true }).catch(report)}
        transcriptStatusRow={transcriptStatusRow} /> :
      <ScrollShadow ref={follow.scrollRef} className="chat-scroll min-h-0 flex-1 overflow-y-auto" style={{ overflowAnchor: 'none' }} onScroll={timeline.handleHistoryScroll}>
        {retryActionCopy ? <div className="chat-column px-3 py-2">
          <div className="typography-ui-label text-foreground">{retryActionCopy.title}</div>
          <div className="typography-meta text-muted-foreground mt-1">{retryActionCopy.message}</div>
          {retryActionCopy.link ? <a href={retryActionCopy.link} target="_blank" rel="noopener noreferrer" className="typography-meta underline">{retryActionCopy.label}</a> : null}
        </div> : null}
        {data?.boundary.kind === 'has-more' ? <Button size="xs" onClick={() => void timeline.loadEarlier({ userInitiated: true }).catch(report)} disabled={timeline.isLoadingOlder}>{t('chat.history.loadingMore')}</Button> : null}
        <MessageList ref={listRef} sessionKey={sessionId ?? 'remote-new-session'} virtualizerKey={surface.surfaceID} timelineHistoryAnchorToken={anchorToken}
          messages={timeline.renderedMessages} directory={location.directory} sessionIsWorking={busy}
          activeStreamingMessageId={null} activeStreamingPhase={null} onMessageContentChange={follow.notifyContentChange}
          getAnimationHandlers={follow.getAnimationHandlers} isLoadingOlder={timeline.isLoadingOlder}
          scrollToBottom={() => follow.goToBottom()} scrollRef={follow.scrollRef} />
        {!readOnly && active ? <>
          {snapshot.permissions.map((permission) => <PermissionCard key={permission.id} permission={permission} />)}
          {snapshot.questions.map((question) => <QuestionCard key={question.id} question={question} />)}
          {snapshot.forms.map((form) => <FormCard key={form.id} form={form} directory={location.directory} />)}
        </> : null}
        {transcriptStatusRow}
      </ScrollShadow>}
      </TranscriptSearch> : null}
      {session?.revert && sessionId && !readOnly && active ? <Button size="xs" onClick={() => { assertWritable(); void postSessionRevertClear({ scope: entry, sessionID: sessionId }).then(() => state.refreshMetadata(sessionId)).catch(report); }}>{t('chat.revertIndicator.redo')}</Button> : null}
      {!sessionId ? <DraftComposerFoot isMobile={isMobile} expanded={expanded} compact={isMobile}>
        <ChatInput surface={surface} scrollToBottom={follow.scrollToBottomOnSend} showScrollToBottom={follow.showScrollButton} onScrollToBottom={() => follow.goToBottom()} />
      </DraftComposerFoot> : <ComposerFoot isMobile={isMobile} expanded={expanded}>
        <ChatInput surface={surface} scrollToBottom={follow.scrollToBottomOnSend} showScrollToBottom={follow.showScrollButton} onScrollToBottom={() => follow.goToBottom()} />
      </ComposerFoot>}
      {inboxPopup ? <ToolOutputDialog popup={inboxPopup} isMobile={isMobile} onOpenChange={(open) => { if (!open) setInboxPopup(null); }} /> : null}
      {sessionId ? <TimelineDialog open={timelineOpen && active} onOpenChange={setTimelineOpen} sessionID={sessionId} directory={location.directory}
        onRevertMessage={revert} onScrollToMessage={timeline.scrollToMessage}
        canLoadEarlier={timeline.historySignals.canLoadEarlier} isLoadingEarlier={timeline.isLoadingOlder}
        onLoadEarlier={() => void timeline.loadEarlier({ userInitiated: true }).catch(report)} /> : null}
    </div>
  </SessionSurfaceContext.Provider>;
}

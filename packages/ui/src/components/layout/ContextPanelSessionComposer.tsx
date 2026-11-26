import React from 'react';
import { useEvent, useMountedState } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatInput } from '@/components/chat/ChatInput';
import { ComposerFoot } from '@/components/chat/ComposerFoot';
import { resolveComposerVisibleAgents } from '@/components/chat/chatComposerCatalog';
import type { ChatInputSecondarySurface } from '@/components/chat/chatInputSurface';
import { resolveAgentModelSelection } from '@/components/chat/mobileControlsUtils';
import { NativeSessionInboxChips } from '@/components/chat/QueuedMessageChips';
import type { SessionSurfaceContextValue, SessionSurfaceMessageEditSnapshot } from '@/components/chat/SessionSurfaceContext';
import { TimelineDialog } from '@/components/chat/TimelineDialog';
import { Button } from '@/components/ui/button';
import ToolOutputDialog from '@/components/chat/message/ToolOutputDialog';
import type { ToolPopupContent } from '@/components/chat/message/types';
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { providerCatalogQueryOptions, rawAgentsQueryOptions } from '@/queries/configCatalogQueries';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { createDraftAttachmentResourceAdapter } from '@/sync/draft-attachment-resource-adapter';
import { draftKeyString, sessionDraftKey } from '@/sync/input-draft-types';
import { useInputStore } from '@/sync/input-store';
import { useSelectionStore } from '@/sync/selection-store';
import { abortCurrentOperation, commitMessageEdit, revertToMessage, stageMessageEdit, unrevertSession } from '@/sync/session-actions';
import { fetchForkBoundary } from '@/sync/session-fork-boundary';
import { editSessionInboxIntoDraft } from '@/sync/session-inbox-edit';
import { useSessionInboxOverlayStore } from '@/sync/session-inbox-overlay';
import { sessionInboxQueryOptions } from '@/sync/session-inbox-query';
import { cancelUnpromotedInboxItem, queueSessionInbox, steerSessionInbox } from '@/sync/session-prompt-api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionMessages, useUserMessageHistory } from '@/sync/sync-context';
import type { resolveContextPanelSessionExecution } from './contextPanelSessionExecution';

const EMPTY_INLINE: InlineCommentDraft[] = [];

export type ContextPanelSessionActions = Required<Pick<SessionSurfaceContextValue, 'onEditMessage' | 'onRevertMessage' | 'onForkMessage'>>;

export function ContextPanelSessionComposer({
    surfaceID, sessionID, directory, execution, status, hasMessages, actionsRef, stagedEdit,
    onNavigateSession, scrollToBottom, onScrollToMessage, hasMore, isLoadingOlder, loadOlder,
}: {
    surfaceID: string;
    sessionID: string;
    directory: string;
    execution: ReturnType<typeof resolveContextPanelSessionExecution>;
    status: 'idle' | 'busy' | 'retry' | 'unknown';
    hasMessages: boolean;
    actionsRef: React.Ref<ContextPanelSessionActions>;
    stagedEdit: React.RefObject<string | null>;
    onNavigateSession: (sessionID: string, directory: string) => void;
    scrollToBottom: () => void;
    onScrollToMessage: (messageID: string) => Promise<boolean>;
    hasMore: boolean;
    isLoadingOlder: boolean;
    loadOlder: () => void;
}) {
    const { t } = useI18n();
    const transportIdentity = getRuntimeTransportIdentity();
    const runtimeGeneration = getRuntimeGeneration();
    const draftKey = React.useMemo(() => sessionDraftKey({ transportIdentity }, sessionID), [transportIdentity, sessionID]);
    const isMounted = useMountedState();
    const session = useSession(sessionID, directory);
    const [timelineOpen, setTimelineOpen] = React.useState(false);
    const openTimeline = useEvent(() => setTimelineOpen(true));
    const working = status === 'busy' || status === 'retry';
    const isCurrent = () => isMounted() && getRuntimeGeneration() === runtimeGeneration
        && getRuntimeTransportIdentity() === transportIdentity;
    const assertWritable = () => {
        if (!isCurrent()) throw new Error('Panel chat is read-only');
    };
    const onEditMessage = useEvent(async (messageID: string, snapshot: SessionSurfaceMessageEditSnapshot) => {
        assertWritable();
        const handle = await stageMessageEdit(sessionID, messageID, snapshot, { directory, draftKey });
        if (!isCurrent()) {
            await handle.rollback();
            return;
        }
        stagedEdit.current = messageID;
    });
    const onRevertMessage = useEvent(async (messageID: string) => {
        assertWritable();
        await revertToMessage(sessionID, messageID, { directory, draftKey });
        stagedEdit.current = null;
    });
    const onForkMessage = useEvent(async (messageID: string) => {
        assertWritable();
        const before = await fetchForkBoundary(opencodeClient.getScopedSdkClient(directory), sessionID, messageID, working, isCurrent);
        assertWritable();
        const created = await opencodeClient.forkSession(sessionID, before, directory);
        if (isCurrent()) onNavigateSession(created.id, directory);
    });
    React.useImperativeHandle(actionsRef, () => ({ onEditMessage, onRevertMessage, onForkMessage }), [onEditMessage, onRevertMessage, onForkMessage]);
    const [catalogOpen, setCatalogOpen] = React.useState(false);
    const rememberedModel = useSelectionStore((state) => state.getSessionModelSelection(sessionID));
    const rememberedAgent = useSelectionStore((state) => state.getSessionAgentSelection(sessionID));
    const [pick, setPick] = React.useState<ChatInputSecondarySurface['selection']['value']>();
    const knownModel = rememberedModel ?? (session?.model
        ? { providerId: session.model.providerID, modelId: session.model.id }
        : { providerId: execution.providerId, modelId: execution.modelId });
    const catalogQuery = useQuery({
        ...providerCatalogQueryOptions(directory, transportIdentity),
        enabled: catalogOpen || !knownModel.providerId || !knownModel.modelId,
    });
    const agentsOptions = rawAgentsQueryOptions(directory, transportIdentity);
    const agentsQuery = useQuery({ ...agentsOptions, enabled: catalogOpen });
    const queryClient = useQueryClient();
    const providers = React.useMemo(() => (
        catalogQuery.data?.providers.map((provider) => ({ ...provider, models: Object.values(provider.models) })) ?? []
    ), [catalogQuery.data]);
    const agents = React.useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
    const configuredModel = React.useMemo(() => Object.entries(catalogQuery.data?.default ?? {}).find(([providerID, modelID]) => (
        catalogQuery.data?.providers.some((provider) => provider.id === providerID && provider.models[modelID])
    )), [catalogQuery.data]);
    const providerID = pick?.providerID ?? knownModel.providerId ?? configuredModel?.[0];
    const modelID = pick?.modelID ?? knownModel.modelId ?? configuredModel?.[1];
    const agent = pick?.agent ?? rememberedAgent ?? session?.agent ?? execution.agentName;
    const rememberedVariant = useSelectionStore((state) => agent && providerID && modelID
        ? state.getAgentModelVariantForSession(sessionID, agent, providerID, modelID)
        : undefined);
    const selection = {
        providerID, modelID, agent,
        variant: pick ? pick.variant : rememberedVariant ?? (session?.model?.providerID === providerID && session?.model?.id === modelID
            ? session?.model?.variant : undefined),
    };
    const catalog = React.useMemo(() => ({
        providers, agents, ready: !catalogOpen || catalogQuery.isSuccess && agentsQuery.isSuccess,
        modelsReady: catalogQuery.isSuccess, agentsReady: agentsQuery.isSuccess,
        error: catalogQuery.isError || agentsQuery.isError,
    }), [providers, agents, catalogOpen, catalogQuery.isSuccess, catalogQuery.isError, agentsQuery.isSuccess, agentsQuery.isError]);
    const change = useEvent((next: ChatInputSecondarySurface['selection']['value']) => {
        assertWritable();
        setPick(next);
        const memory = useSelectionStore.getState();
        if (next.agent) memory.saveSessionAgentSelection(sessionID, next.agent);
        if (next.providerID && next.modelID) {
            memory.saveSessionModelSelection(sessionID, next.providerID, next.modelID, undefined, { rememberAsDefault: false });
            if (next.agent) memory.saveAgentModelVariantForSession(sessionID, next.agent, next.providerID, next.modelID, next.variant);
        }
    });
    const draftID = draftKeyString(draftKey);
    const attachments = useInputStore((state) => state.drafts[draftID]?.attachments);
    const attachmentViews = useInputStore((state) => state.draftAttachmentViews[draftID]);
    const rootAttachments = React.useMemo(() => attachments?.flatMap(({ attachmentRefID }) => {
        const view = attachmentViews?.[attachmentRefID];
        return view ? [view] : [];
    }) ?? [], [attachments, attachmentViews]);
    const adapter = React.useMemo(() => createDraftAttachmentResourceAdapter(draftKey, useInputStore.getState), [draftKey]);
    React.useEffect(() => {
        void useInputStore.getState().hydrateDraftAttachments(draftKey);
    }, [draftKey]);
    const history = useUserMessageHistory(sessionID, directory);
    const inlineDrafts = useInlineCommentDraftStore((state) => state.drafts[sessionID] ?? EMPTY_INLINE);
    useQuery(sessionInboxQueryOptions({ sessionID, directory }));
    const inbox = useSessionInboxOverlayStore((state) => state.bySession[sessionID]);
    const messages = useSessionMessages(inbox?.length ? sessionID : '', directory);
    const visibleInbox = React.useMemo(() => {
        if (!inbox?.length) return [];
        const messageIDs = new Set(messages.map(({ id }) => id));
        return inbox.filter((item) => !messageIDs.has(item.id));
    }, [inbox, messages]);
    const [popup, setPopup] = React.useState<ToolPopupContent | null>(null);
    const inboxAction = useEvent(async (action: 'edit' | 'steer' | 'queue' | 'cancel', inboxID: string) => {
        assertWritable();
        const target = { sessionID, directory, inboxID };
        if (action === 'steer') return steerSessionInbox(target);
        if (action === 'queue') return queueSessionInbox(target);
        if (action === 'cancel') return cancelUnpromotedInboxItem(target);
        const restored = await editSessionInboxIntoDraft({
            ...target, targetKey: draftKey, runtimeGeneration,
            expectedRevision: useInputStore.getState().getDraft(draftKey)?.revision ?? 'absent',
            isCurrent: () => {
                try { assertWritable(); return true; } catch { return false; }
            },
        });
        if (!restored) throw new Error('Session inbox draft changed');
    });
    const abort = useEvent(() => {
        assertWritable();
        return abortCurrentOperation(sessionID, directory);
    });
    const surface: ChatInputSecondarySurface = {
        kind: 'secondary', composerPresentation: 'panel', isolatedControls: true, includeSubagents: true,
        surfaceID, active: true, sessionID, directory, draftKey, transportIdentity, runtimeGeneration,
        activity: { phase: status, canAbort: working },
        selection: { value: selection, catalog, change, requestCatalog: setCatalogOpen, flush: async () => assertWritable() },
        commands: { sessionID, hasMessages, hasNewDraft: false },
        commandPolicy: ({ source, name }) => source !== 'yuri' || !['new', 'fork', 'undo', 'redo', 'reload', 'craft-goal', 'btw'].includes(name),
        openTimeline,
        deliveryTarget: { kind: 'primary' }, queue: { scope: null },
        nativeInbox: <NativeSessionInboxChips items={visibleInbox} onAction={inboxAction} onShowPopup={setPopup} />,
        resources: {
            inputStore: useInputStore, busy: false, attachments: rootAttachments,
            addAttachment: adapter.addLocal, removeAttachment: adapter.removeByAttachmentID,
            clearAttachments: adapter.clearRootAttachments, restoreAttachments: adapter.restoreRootAttachments,
            pendingInput: null, consumePendingInput: () => null, pendingPreset: null, consumePendingPreset: () => null,
            consumeSyntheticParts: () => null, restoreSyntheticParts: () => {},
            inlineDrafts, history,
            removeInlineDraft: (id) => useInlineCommentDraftStore.getState().removeDraft(sessionID, id),
            restoreInlineDrafts: (drafts) => useInlineCommentDraftStore.setState((state) => ({
                drafts: { ...state.drafts, [sessionID]: [...drafts, ...(state.drafts[sessionID] ?? []).filter((draft) => !drafts.some(({ id }) => id === draft.id))] },
            })),
            captureRuntime: useInputStore.getState().captureDraftRuntime, getDraft: useInputStore.getState().getDraft,
            abortPrompt: { sessionID: null, clear: () => {} },
        },
        backend: {
            send: async (request) => {
                assertWritable();
                if (request.sessionID !== sessionID || request.transportIdentity !== getRuntimeTransportIdentity()
                    || request.runtimeGeneration !== getRuntimeGeneration() || !request.providerID || !request.modelID) {
                    throw new Error('Session composer target or selection unavailable');
                }
                const input = useInputStore.getState();
                const synthetic = input.getDraft(draftKey)?.syntheticParts ?? [];
                const views = input.getDraftAttachmentViews(draftKey);
                const parts = [...(request.parts ?? []), ...synthetic.map((part) => ({
                    text: part.text, synthetic: part.synthetic,
                    attachments: part.attachments.map((attachment) => {
                        const view = views.find(({ id }) => id === attachment.attachmentID);
                        if (!view) throw new Error('Session composer attachment unavailable');
                        return view;
                    }),
                }))].map((part) => ({ ...part, attachments: part.attachments ? [...part.attachments] : undefined }));
                const edit = stagedEdit.current;
                if (edit) {
                    await commitMessageEdit(sessionID, edit, { directory });
                    if (stagedEdit.current === edit) stagedEdit.current = null;
                    assertWritable();
                }
                await useSessionUIStore.getState().sendMessage(
                    request.text ?? '', request.providerID, request.modelID, request.agent,
                    [...(request.attachments ?? [])], request.agentMention, parts, request.variant, request.inputMode,
                    { sessionId: sessionID, directoryHint: directory, preservePrimaryContext: true,
                        delivery: !edit && request.options?.delivery === 'queue' ? 'queue' : 'steer', messageID: request.options?.messageID },
                );
                if (synthetic.length && request.runtimeGeneration === getRuntimeGeneration()) {
                    input.consumeDraftSyntheticParts(draftKey, (part) => !synthetic.some(({ partID }) => partID === part.partID));
                }
            },
            sendQueued: (request) => inboxAction('steer', request.queueItemID),
            create: async () => { throw new Error('Panel composer requires an existing session'); },
            compact: async (request) => {
                assertWritable();
                return opencodeClient.summarizeSession(sessionID, request.providerID ?? '', request.modelID ?? '', directory);
            },
            abort,
        },
        shortcuts: {
            cycle: async (direction) => {
                assertWritable();
                const selectable = resolveComposerVisibleAgents(await queryClient.ensureQueryData(agentsOptions));
                if (!selectable.length) return;
                const index = selectable.findIndex((entry) => entry.name === selection.agent);
                const next = resolveAgentModelSelection(
                    { providerID: providerID ?? '', modelID: modelID ?? '', agent: agent ?? null },
                    selectable[(index + direction + selectable.length) % selectable.length].name, selectable, providers,
                );
                change({ ...next, agent: next.agent ?? undefined,
                    variant: next.providerID === providerID && next.modelID === modelID ? selection.variant : undefined });
            },
            new: () => {},
            abort,
            submit: () => {},
        },
    };
    return <>
        {session?.revert?.messageID ? <Button size="xs" onClick={() => {
            assertWritable();
            void unrevertSession(sessionID, directory).catch(() => {});
        }}>{t('chat.revertIndicator.redo')}</Button> : null}
        <ComposerFoot isMobile={false} expanded={false} overlay={false}>
            <ChatInput surface={surface} scrollToBottom={scrollToBottom} />
            {popup ? <ToolOutputDialog popup={popup} isMobile={false} onOpenChange={(open) => { if (!open) setPopup(null); }} /> : null}
        </ComposerFoot>
        <TimelineDialog open={timelineOpen} onOpenChange={setTimelineOpen} sessionID={sessionID} directory={directory}
            onRevertMessage={onRevertMessage} onScrollToMessage={onScrollToMessage}
            canLoadEarlier={hasMore} isLoadingEarlier={isLoadingOlder} onLoadEarlier={loadOlder} />
    </>;
}

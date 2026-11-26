import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ContextPanelSessionTranscript } from './ContextPanelSessionTranscript';

const fixture = vi.hoisted(() => ({
    surface: null as ChatInputSurface | null,
    session: { id: 'child', parentID: 'parent' as string | undefined, agent: 'explore', model: { providerID: 'provider', id: 'model', variant: 'low' } },
    send: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    refreshForms: vi.fn(async () => []),
    readComposerSession: vi.fn(),
}));

vi.mock('@/lib/i18n', async (original) => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/chat/ChatInput', () => ({
    ChatInput: ({ surface }: { surface: ChatInputSurface }) => {
        fixture.surface = surface;
        return <textarea data-session-composer={surface.sessionID} />;
    },
}));
vi.mock('@/components/chat/MessageList', () => ({ default: () => <div data-transcript /> }));
vi.mock('@/components/chat/ReadOnlyPromptBanner', () => ({ ReadOnlyPromptBanner: () => <div data-read-only /> }));
vi.mock('@/components/chat/TimelineDialog', () => ({ TimelineDialog: () => null }));
vi.mock('@/components/chat/StatusRow', () => ({ StatusRow: () => null }));
vi.mock('@/components/chat/PermissionCard', () => ({ PermissionCard: ({ permission }: { permission: { id: string } }) => <button>{permission.id}</button> }));
vi.mock('@/components/chat/QuestionCard', () => ({ QuestionCard: ({ question }: { question: { id: string } }) => <button>{question.id}</button> }));
vi.mock('@/components/chat/FormCard', () => ({ FormCard: ({ form }: { form: { id: string } }) => <button>{form.id}</button> }));
vi.mock('@/hooks/useRecoverPendingQuestions', () => ({ useRecoverPendingQuestions: () => {} }));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({ ensureSessionRenderable: async () => {}, isLoading: () => false }) }));
vi.mock('@/sync/session-actions', async (original) => ({
    ...await original<typeof import('@/sync/session-actions')>(),
    abortCurrentOperation: fixture.abort,
}));
vi.mock('@/sync/session-form-store', async (original) => ({
    ...await original<typeof import('@/sync/session-form-store')>(),
    useSessionFormStore: (selector: (state: { forms: Record<string, Array<{ id: string }>> }) => unknown) => selector({ forms: { child: [{ id: 'child form' }] } }),
    refreshSessionForms: fixture.refreshForms,
}));
vi.mock('@/sync/sync-context', async (original) => {
    const actual = await original<typeof import('@/sync/sync-context')>();
    const empty: never[] = [];
    const status = { type: 'busy' };
    return { ...actual,
        useSyncDirectory: () => '/panel',
        useDirectorySync: (selector: (state: { session: Array<typeof fixture.session> }) => unknown) => selector({ session: [fixture.session] }),
        useSession: () => {
            fixture.readComposerSession();
            return fixture.session;
        },
        useSessionMessageCount: () => 0,
        useSessionMessages: () => empty,
        useSessionMessageRecords: () => empty,
        useUserMessageHistory: () => empty,
        useSessionMessageLoadState: () => null,
        useSessionMaterializationStatus: () => ({ renderable: true }),
        useSessionStatus: () => status,
        useSessionTranscriptPagination: () => ({ boundary: { kind: 'exhausted' } }),
        useScopedBlockingPermissions: () => [{ id: 'child permission' }],
        useScopedBlockingQuestions: () => [{ id: 'child question' }],
    };
});
vi.mock('@/hooks/useChatAutoFollow', () => ({
    useChatAutoFollow: () => ({
        scrollRef: { current: null }, notifyContentChange: () => {}, getAnimationHandlers: () => {},
        restoreSnapshot: async () => {}, goToBottom: () => {}, releaseAutoFollow: () => {},
    }),
}));

test('local panel enables only confirmed child chats and keeps selection and delivery scoped', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const node = document.createElement('div');
    const root = createRoot(node);
    const previous = useSelectionStore.getState();
    const send = vi.spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(fixture.send);
    const render = (allow: boolean, sessionId = 'child') => act(async () => root.render(
        <QueryClientProvider client={client}>
            <ContextPanelSessionTranscript surfaceId="panel" sessionId={sessionId} directory="/panel"
                active allowPromptingSubagentSessions={allow} canNavigateBack={false}
                onNavigateSession={() => {}} onNavigateBack={() => {}} />
        </QueryClientProvider>,
    ));
    try {
        await render(false);
        expect(node.querySelector('[data-read-only]')).not.toBeNull();
        expect(node.querySelector('textarea')).toBeNull();
        expect(node.textContent).not.toContain('child question');
        for (let index = 0; index < 50; index++) await render(false);
        expect(fixture.readComposerSession).not.toHaveBeenCalled();
        expect(fixture.refreshForms).not.toHaveBeenCalled();
        expect(client.getQueryCache().getAll()).toHaveLength(0);

        await render(true);
        expect(node.querySelector('[data-read-only]')).toBeNull();
        await vi.waitFor(() => expect(node.querySelector('[data-session-composer="child"]')).not.toBeNull());
        expect(Array.from(node.querySelectorAll('button'), (button) => button.textContent))
            .toEqual(expect.arrayContaining(['child permission', 'child question', 'child form']));
        expect(fixture.surface!.selection.value).toMatchObject({ agent: 'explore', variant: 'low' });
        await act(async () => fixture.surface!.selection.change?.({ providerID: 'other', modelID: 'new', agent: 'research', variant: 'high' }));
        const surface = fixture.surface!;
        expect(surface.draftKey?.owner.ownerID).toBe('child');
        expect(surface.selection.value).toEqual({ providerID: 'other', modelID: 'new', agent: 'research', variant: 'high' });
        expect(useSelectionStore.getState().lastUsedProvider).toBe(previous.lastUsedProvider);
        expect(useSelectionStore.getState().getSessionModelSelection('parent')).toBe(previous.sessionModelSelections.get('parent') ?? null);
        const request = {
            surfaceID: surface.surfaceID, sessionID: surface.sessionID, directory: surface.directory!,
            draftKey: surface.draftKey!, deliveryTarget: surface.deliveryTarget,
            transportIdentity: surface.transportIdentity, runtimeGeneration: surface.runtimeGeneration,
            ...surface.selection.value, text: 'Follow up',
        };
        for (const delivery of ['queue', 'steer'] as const) {
            await surface.backend.send({ ...request, operation: 'send', options: { delivery } });
            expect(fixture.send).toHaveBeenLastCalledWith('Follow up', 'other', 'new', 'research', [], undefined, [], 'high', undefined,
                expect.objectContaining({ sessionId: 'child', directoryHint: '/panel', delivery, preservePrimaryContext: true }));
        }
        await surface.backend.abort({ ...request, operation: 'abort' });
        expect(fixture.abort).toHaveBeenCalledWith('child', '/panel');
        await render(false);
        await expect(surface.backend.send({ ...request, operation: 'send' })).rejects.toThrow('read-only');
        expect(node.querySelector('[data-read-only]')).not.toBeNull();

        await render(true, 'parent');
        expect(node.querySelector('textarea')).toBeNull();
        expect(node.querySelector('[data-read-only]')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        client.clear();
        send.mockRestore();
        useSelectionStore.setState(previous);
    }
});

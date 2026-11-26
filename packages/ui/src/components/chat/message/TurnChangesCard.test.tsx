import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TurnChangesCard } from './TurnChangesCard';
import { SessionSurfaceContext, PRIMARY_SESSION_SURFACE_CAPABILITIES } from '../SessionSurfaceContext';

const mocks = vi.hoisted(() => ({
    openContextPanelTab: vi.fn(),
    revertToMessage: vi.fn(),
    openTurnChangedFilePreview: vi.fn(),
    getSessionDiff: vi.fn(),
    workspaceDirectories: ['/repo'] as string[],
}));

vi.mock('@/contexts/HostRuntimeProvider', () => ({
    useHostRuntime: () => null,
}));

vi.mock('@/hooks/useEffectiveDirectory', () => ({
    useEffectiveDirectory: () => '/repo',
    useEffectiveWorkspaceDirectories: () => mocks.workspaceDirectories,
}));

vi.mock('@/apps/mobileAppContext', () => ({
    useMobileAppActions: () => null,
}));

vi.mock('@/stores/useUIStore', () => ({
    useUIStore: (selector: (state: { openContextPanelTab: typeof mocks.openContextPanelTab }) => unknown) =>
        selector({ openContextPanelTab: mocks.openContextPanelTab }),
}));

vi.mock('@/sync/session-ui-store', () => ({
    useSessionUIStore: (selector: (state: { revertToMessage: typeof mocks.revertToMessage }) => unknown) =>
        selector({ revertToMessage: mocks.revertToMessage }),
}));

vi.mock('../openTurnChangedFile', () => ({
    openTurnChangedFilePreview: (...args: unknown[]) => mocks.openTurnChangedFilePreview(...args),
}));

vi.mock('@/lib/opencode/client', () => ({
    opencodeClient: {
        getSessionDiff: (...args: unknown[]) => mocks.getSessionDiff(...args),
    },
}));

vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeTransportIdentity: () => 'transport-test',
}));

vi.mock('@/lib/i18n', () => ({
    useI18n: () => ({
        t: (key: string, params?: Record<string, unknown>) => {
            if (key === 'chat.changedFiles.editedFilesSingle') return `Edited ${params?.count} file`;
            if (key === 'chat.changedFiles.editedFilesPlural') return `Edited ${params?.count} files`;
            if (key === 'chat.changedFiles.actions.revert') return 'Undo';
            if (key === 'chat.changedFiles.actions.viewChanges') return 'View changes';
            if (key === 'chat.changedFiles.actions.showMoreSingle') return `Show ${params?.count} more file`;
            if (key === 'chat.changedFiles.actions.showMorePlural') return `Show ${params?.count} more files`;
            if (key === 'chat.changedFiles.actions.showLess') return 'Show less';
            if (key === 'chat.changedFiles.actions.retryDiff') return 'Retry loading diff';
            if (key === 'chat.changedFiles.actions.openFileTitle') return `Open ${params?.path}`;
            return key;
        },
    }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIX_DIFFS = [
    { file: '.agents/skills/langfuse-daily-insight/SKILL.md', status: 'modified', additions: 3, deletions: 3, patch: '@@' },
    { file: '.agents/skills/langfuse-daily-insight/references/PLAN.md', status: 'modified', additions: 5, deletions: 5, patch: '@@' },
    { file: 'docs/langfuse-insight-ledger.json', status: 'modified', additions: 1, deletions: 1, patch: '@@' },
    { file: 'src/d.ts', status: 'modified', additions: 6, deletions: 0, patch: '@@' },
    { file: 'src/e.ts', status: 'added', additions: 8, deletions: 0, patch: '@@' },
    { file: 'src/f.ts', status: 'modified', additions: 5, deletions: 0, patch: '@@' },
];

const flushAsync = async () => {
    for (let i = 0; i < 6; i += 1) {
        await act(async () => {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
};

describe('TurnChangesCard', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        mocks.openContextPanelTab.mockReset();
        mocks.revertToMessage.mockReset();
        mocks.openTurnChangedFilePreview.mockReset();
        mocks.getSessionDiff.mockReset();
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    const mountCard = async (
        props: Partial<React.ComponentProps<typeof TurnChangesCard>> = {},
        options: { onRevertMessage?: (messageId: string) => Promise<void> } = {},
    ) => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        await act(async () => {
            root.render(
                <QueryClientProvider client={queryClient}>
                    <SessionSurfaceContext.Provider
                        value={{
                            kind: 'primary',
                            surfaceId: 'primary',
                            active: true,
                            sessionId: 'ses_1',
                            directory: '/repo',
                            capabilities: PRIMARY_SESSION_SURFACE_CAPABILITIES,
                            onRevertMessage: options.onRevertMessage,
                        }}
                    >
                        <TurnChangesCard
                            sessionId="ses_1"
                            fileCount={6}
                            turnId="msg_turn_2"
                            turnDiffFromMessageId="msg_user_1"
                            turnDiffFiles={SIX_DIFFS.map((d) => d.file)}
                            turnDiffSignature="sig_1"
                            isLatestTurn={true}
                            isMobile={false}
                            {...props}
                        />
                    </SessionSurfaceContext.Provider>
                </QueryClientProvider>,
            );
        });
        await flushAsync();
        return queryClient;
    };

    test('renders header totals, 3 files by default, inline expand toggle, and wired actions', async () => {
        mocks.getSessionDiff.mockResolvedValueOnce(SIX_DIFFS);
        const onRevertMessage = vi.fn(async () => {});
        const onContentChange = vi.fn();

        await mountCard({ onContentChange }, { onRevertMessage });

        expect(container.textContent).toContain('Edited 6 files');
        expect(container.textContent).toContain('+28');
        expect(container.textContent).toContain('-9');

        // Default shows first 3 files + expand button for remaining 3
        expect(container.querySelectorAll('[data-turn-change-file="true"]')).toHaveLength(3);
        const toggleButton = container.querySelector('[data-turn-changes-toggle="true"]') as HTMLButtonElement;
        expect(toggleButton).toBeTruthy();
        expect(toggleButton.textContent).toContain('Show 3 more files');

        // Expanding reveals all 6 files inline and flips toggle label
        await act(async () => {
            toggleButton.click();
        });
        expect(container.querySelectorAll('[data-turn-change-file="true"]')).toHaveLength(6);
        expect(toggleButton.textContent).toContain('Show less');
        expect(onContentChange).toHaveBeenCalledWith('structural');

        // Clicking a file opens DiffView focused on that file with the cycle opener message ID
        const ledgerButton = container.querySelector(
            'button[aria-label="Open docs/langfuse-insight-ledger.json"]',
        ) as HTMLButtonElement;
        expect(ledgerButton).toBeTruthy();
        await act(async () => {
            ledgerButton.click();
        });
        expect(mocks.openTurnChangedFilePreview).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo',
            filePath: 'docs/langfuse-insight-ledger.json',
            turnMessageId: 'msg_user_1',
            sessionId: 'ses_1',
        }));

        // Clicking View changes opens the full turn diff panel
        const viewButton = container.querySelector('[data-turn-changes-view="true"]') as HTMLButtonElement;
        await act(async () => {
            viewButton.click();
        });
        expect(mocks.openContextPanelTab).toHaveBeenCalledWith('/repo', expect.objectContaining({
            mode: 'diff',
            diffScope: 'turn',
            diffTurnMessageId: 'msg_user_1',
            diffSessionId: 'ses_1',
        }));

        // Clicking Undo invokes revert with the cycle opener message ID
        const revertButton = container.querySelector('[data-turn-changes-revert="true"]') as HTMLButtonElement;
        await act(async () => {
            revertButton.click();
        });
        await flushAsync();
        expect(onRevertMessage).toHaveBeenCalledWith('msg_user_1');
    });

    test('hides the card when v2 turn diff resolves to zero net changes', async () => {
        mocks.getSessionDiff.mockResolvedValueOnce([]);
        await mountCard();

        expect(container.querySelector('[data-turn-changes-preview="true"]')).toBeNull();
    });

    test('preserves file list and exposes retry when v2 turn diff fetch fails', async () => {
        mocks.getSessionDiff.mockRejectedValueOnce(new Error('network error'));
        await mountCard();

        const retryButton = container.querySelector('[data-turn-changes-retry="true"]') as HTMLButtonElement;
        expect(retryButton).toBeTruthy();
        expect(retryButton.textContent).toContain('Retry loading diff');
        expect(container.querySelectorAll('[data-turn-change-file="true"]')).toHaveLength(3);

        mocks.getSessionDiff.mockResolvedValueOnce(SIX_DIFFS);
        await act(async () => {
            retryButton.click();
        });
        await flushAsync();
        expect(container.textContent).toContain('+28');
        expect(container.textContent).toContain('-9');
    });

    test('merges primary snapshot diff and secondary attached-repo changes in multi-path workspaces', async () => {
        mocks.workspaceDirectories = ['/repo', '/workspace/mmbizwxaaiagent'];
        mocks.getSessionDiff.mockResolvedValueOnce([
            { file: 'src/index.ts', status: 'modified', additions: 4, deletions: 1, patch: '@@' },
        ]);

        try {
            await mountCard({
                fileCount: 2,
                turnDiffFiles: ['repo/src/index.ts', 'mmbizwxaaiagent/src/tablekv.cc'],
                turnWorkspaceChanges: [
                    {
                        file: 'mmbizwxaaiagent/src/tablekv.cc',
                        repoDirectory: '/workspace/mmbizwxaaiagent',
                        repoRelativePath: 'src/tablekv.cc',
                        absolutePath: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
                        additions: 10,
                        deletions: 2,
                        status: 'modified',
                        sourceMessageIds: ['msg_a_1'],
                        hasSlimParts: false,
                    },
                ],
            });

            expect(container.textContent).toContain('Edited 2 files');
            expect(container.textContent).toContain('+14');
            expect(container.textContent).toContain('-3');
            const buttons = Array.from(container.querySelectorAll('[data-turn-change-file="true"]'));
            expect(buttons.map((b) => b.getAttribute('title'))).toEqual([
                'mmbizwxaaiagent/src/tablekv.cc',
                'repo/src/index.ts',
            ]);
        } finally {
            mocks.workspaceDirectories = ['/repo'];
        }
    });

    test('renders secondary-only multi-path turn changes without querying primary session diff', async () => {
        mocks.workspaceDirectories = ['/repo', '/workspace/mmbizwxaaiagent'];

        try {
            await mountCard({
                fileCount: 1,
                turnDiffFiles: ['mmbizwxaaiagent/src/tablekv.cc'],
                turnWorkspaceChanges: [
                    {
                        file: 'mmbizwxaaiagent/src/tablekv.cc',
                        repoDirectory: '/workspace/mmbizwxaaiagent',
                        repoRelativePath: 'src/tablekv.cc',
                        absolutePath: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
                        additions: 9,
                        deletions: 4,
                        status: 'modified',
                        sourceMessageIds: ['msg_a_1'],
                        hasSlimParts: false,
                    },
                ],
            });

            expect(mocks.getSessionDiff).not.toHaveBeenCalled();
            expect(container.textContent).toContain('Edited 1 file');
            expect(container.textContent).toContain('+9');
            expect(container.textContent).toContain('-4');
        } finally {
            mocks.workspaceDirectories = ['/repo'];
        }
    });
});

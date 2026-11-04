import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { ChildStoreManager } from '@/sync/child-store';
import { useUIStore } from '@/stores/useUIStore';
import { BackgroundActivityHint } from './BackgroundActivityHint';
import { getSessionShellActivity } from '@/sync/session-shell-activity';
import type { TurnActivityRecord } from '../lib/turns/types';
import { QueryClient } from '@tanstack/react-query';
import type { ShellInfo } from '@opencode/client';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: { count: number }) =>
    values ? `${values.count} 个后台任务进行中` : key }) }));
vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
});
const context = (globalThis as unknown as {
    __yuri_sync_context__: React.Context<{ childStores: ChildStoreManager } | null>;
}).__yuri_sync_context__;
let root: Root | undefined;
const previousUI = useUIStore.getState();
function work(id: string, tool: string, metadata: Record<string, unknown>): TurnActivityRecord {
    return { id, kind: 'tool', turnId: 'turn', messageId: 'tool-message', partIndex: 0,
        part: { id, type: 'tool', sessionID: 'parent', messageID: 'tool-message', callID: id, tool,
            state: { status: 'completed', input: {}, metadata } } };
}
afterEach(async () => {
    await act(async () => root?.unmount());
    useUIStore.setState(previousUI);
    vi.restoreAllMocks();
});

test.each([false, true])('live descendants retain non-interactive footer activity (mobile=%s)', async (isMobile) => {
    const children = new ChildStoreManager();
    const store = children.ensureChild('/workspace', { bootstrap: false });
    const parent = { id: 'parent', time: { created: 1, updated: 1 } } as Session;
    store.setState({
        session: [parent, { id: 'child', parentID: 'parent' } as Session],
        session_status: { parent: { type: 'idle' }, child: { type: 'busy' } },
    });
    useUIStore.setState({ isMobile, isSidebarOpen: false, mobileSessionPanelOpen: false });
    const host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(<context.Provider value={{ childStores: children }}>
        <BackgroundActivityHint sessionId="parent" activityParts={[
            work('child-call', 'subagent', { sessionID: 'child' }),
            work('shell-call', 'shell', { shellID: 'sh_tests' }),
        ]} />
    </context.Provider>));
    const button = host.querySelector<HTMLElement>('[data-background-activity]')!;
    expect(button.textContent).toBe('1 个后台任务进行中');
    const shells = getSessionShellActivity(children);
    await act(async () => shells.event('/workspace', { type: 'shell.created', properties: {
        info: { id: 'sh_tests', status: 'running', metadata: { sessionID: 'parent' } },
    } }));
    expect(button.textContent).toBe('2 个后台任务进行中');
    await act(async () => shells.event('/workspace', { type: 'shell.exited', properties: { id: 'sh_tests', status: 'exited' } }));
    expect(button.textContent).toBe('1 个后台任务进行中');
    expect(button.querySelector('.animate-text-shimmer')).not.toBeNull();
    expect(button.querySelector('svg')).toBeNull();
    expect(host.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    await act(async () => button.click());
    expect(useUIStore.getState().mobileSessionPanelOpen).toBe(false);
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
    await act(async () => store.setState({
        session: [parent, { id: 'child', parentID: 'parent' } as Session, { id: 'nested', parentID: 'child' } as Session],
        session_status: { parent: { type: 'busy' }, child: { type: 'busy' }, nested: { type: 'retry', attempt: 1, message: 'retry', next: 100 } },
    }));
    expect(button.textContent).toBe('2 个后台任务进行中');
    await act(async () => store.setState({ session_status: {
        parent: { type: 'busy' }, child: { type: 'idle' }, nested: { type: 'busy' },
    } }));
    expect(button.textContent).toBe('1 个后台任务进行中');
    await act(async () => store.setState({ session_status: { parent: { type: 'idle' }, child: { type: 'idle' } } }));
    expect(host.querySelector('[data-background-activity]')).toBeNull();
});

test.each([false, true])('each footer counts only its own live task identities, not the session total (mobile=%s)', async (isMobile) => {
    useUIStore.setState({ isMobile });
    const children = new ChildStoreManager();
    const store = children.ensureChild('/workspace', { bootstrap: false });
    store.setState({ session: [{ id: 'parent' }, { id: 'child', parentID: 'parent' }] as Session[],
        session_status: { parent: { type: 'idle' }, child: { type: 'busy' } } });
    const shells = getSessionShellActivity(children);
    const created = (id: string) => shells.event('/workspace', { type: 'shell.created', properties: {
        info: { id, status: 'running', metadata: { sessionID: 'parent' } },
    } });
    created('sh_old');
    created('sh_current');
    const host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(<context.Provider value={{ childStores: children }}>
        <div data-turn="old"><BackgroundActivityHint sessionId="parent" activityParts={[work('old', 'shell', { shellID: 'sh_old' })]} /></div>
        <div data-turn="unrelated"><BackgroundActivityHint sessionId="parent" activityParts={[work('done', 'shell', { shellID: 'sh_done', status: 'running' })]} /></div>
        <div data-turn="current"><BackgroundActivityHint sessionId="parent" activityParts={[
            work('current', 'shell', { shellID: 'sh_current' }), work('child', 'subagent', { sessionID: 'child' }),
        ]} /></div>
    </context.Provider>));
    expect(host.querySelector('[data-turn="old"]')?.textContent).toBe('1 个后台任务进行中');
    expect(host.querySelector('[data-turn="unrelated"] [data-background-activity]')).toBeNull();
    expect(host.querySelector('[data-turn="current"]')?.textContent).toBe('2 个后台任务进行中');
    // Same session-wide count and active set, but a different shell identity.
    const client = new QueryClient();
    try {
        await act(async () => shells.refresh(client, {
            locations: async () => [{ directory: '/workspace' }],
            shells: async () => ['sh_current', 'sh_replacement'].map((id): ShellInfo => ({
                id, status: 'running', command: 'run tests', cwd: '/workspace', shell: 'sh', file: '/output',
                metadata: { sessionID: 'parent' }, time: { started: 1 },
            })),
        }));
    } finally { client.clear(); }
    expect(host.querySelector('[data-turn="old"] [data-background-activity]')).toBeNull();
    expect(host.querySelector('[data-turn="current"]')?.textContent).toBe('2 个后台任务进行中');
});

test('turns with no work identities do not require or subscribe to the live sync system', async () => {
    const host = document.createElement('div');
    root = createRoot(host);
    for (let i = 0; i < 50; i++) {
        await act(async () => root!.render(<BackgroundActivityHint sessionId="parent" activityParts={[]} />));
    }
    expect(host.querySelector('[data-background-activity]')).toBeNull();
});

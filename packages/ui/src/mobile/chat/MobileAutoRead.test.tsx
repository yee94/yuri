import React, { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MobileAutoReadProvider, MobileAutoReadMenuItem } from './MobileAutoRead';
import { AutoReadContext, AutoReadPlaybackContext, useAutoReadRenderedReply } from './auto-read-context';

const mocks = vi.hoisted(() => ({
    messages: [{ id: 'old', role: 'assistant', time: { created: 10, completed: 20 } }],
    resolved: true, play: vi.fn(), stop: vi.fn(), unlock: vi.fn(), acquire: vi.fn(), release: vi.fn(),
    runtimeChanged: () => {}, localRead: vi.fn(),
}));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => { mocks.localRead(); return mocks.messages; }, useSessionMessagesResolved: () => { mocks.localRead(); return mocks.resolved; } }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: true, play: mocks.play, stop: mocks.stop, unlock: mocks.unlock }) }));
vi.mock('@/lib/voice/screen-awake', () => ({ acquireScreenAwake: mocks.acquire }));
vi.mock('@/lib/runtime-switch', () => ({ subscribeRuntimeEndpointChanged: (callback: () => void) => { mocks.runtimeChanged = callback; return () => {}; } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
const translate = (key: string) => key;
let context: React.ContextType<typeof AutoReadContext>;
let playback: React.ContextType<typeof AutoReadPlaybackContext>;
function Probe({ id, created, completed = true, sessionId }: { id: string; created: number; completed?: boolean; sessionId: string }) {
    context = useContext(AutoReadContext);
    playback = useContext(AutoReadPlaybackContext);
    useAutoReadRenderedReply({ sessionId, messageId: id, created, completed, text: `reply ${id}` });
    return null;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function render(id = 'old', created = 10, completed = true, sessionId = 's1', active = true) {
    await act(async () => root.render(<MobileAutoReadProvider sessionId={sessionId} directory="/project" active={active}>
        <MobileAutoReadMenuItem>{({ enabled, available, toggle }) => (
            <button role="menuitemcheckbox" aria-checked={enabled} disabled={!available} onClick={toggle} />
        )}</MobileAutoReadMenuItem>
        <Probe id={id} created={created} completed={completed} sessionId={sessionId} />
    </MobileAutoReadProvider>));
    await act(async () => vi.advanceTimersByTime(40));
}
beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers(); vi.clearAllMocks();
    localStorage.removeItem('yuri.auto-read');
    mocks.messages = [{ id: 'old', role: 'assistant', time: { created: 10, completed: 20 } }];
    mocks.resolved = true;
    mocks.play.mockResolvedValue(undefined); mocks.unlock.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined); mocks.acquire.mockResolvedValue(mocks.release);
    host = document.createElement('div'); root = createRoot(host);
    await render();
});

function remoteFixture(hostId: string, count = 1) {
    let recordReads = 0;
    const history = { id: 'history', role: 'assistant', time: { created: 100, completed: 110 } };
    const listeners = new Set<() => void>();
    const infos: Record<string, typeof history> = { history };
    for (let i = 1; i < count; i++) infos[`old-${i}`] = { ...history, id: `old-${i}` };
    let transcript = { messageOrder: Object.keys(infos), messagesByID: new Proxy(infos, { get(target, id) { recordReads++; return Reflect.get(target, id); } }) };
    const remote = {
        entry: { key: `host:${hostId}`, location: { hubId: 'hub', hostId, directory: '/project' } },
        scope: (sessionID: string) => ({ sessionID }),
        repository: {
            subscribe: (_scope: unknown, notify: () => void) => { listeners.add(notify); return () => listeners.delete(notify); },
            getTranscript: () => transcript, getRequestState: () => ({ status: 'ready' }),
        },
    } as unknown as NonNullable<React.ComponentProps<typeof MobileAutoReadProvider>['remoteState']>;
    return { remote, reads: () => recordReads, publish: () => { transcript = { ...transcript }; for (const notify of listeners) notify(); } };
}

it('remote explicit state never reads the retained same-ID Hub history and scans only on enable', async () => {
    const remote = remoteFixture('a', 10_000);
    mocks.localRead.mockClear();
    const renderRemote = async (id = 'history', created = 100) => {
        await act(async () => root.render(<MobileAutoReadProvider remote remoteState={remote.remote} sessionId="s1" directory="/project" active>
            <Probe id={id} created={created} sessionId="s1" />
        </MobileAutoReadProvider>));
        await act(async () => vi.advanceTimersByTime(40));
    };
    await renderRemote(); await enable();
    expect(mocks.localRead).not.toHaveBeenCalled(); expect(mocks.play).not.toHaveBeenCalled();
    const initialReads = remote.reads();
    expect(initialReads).toBe(10_000);
    for (let i = 0; i < 50; i++) await act(async () => remote.publish());
    expect(remote.reads()).toBe(initialReads);
    await renderRemote('reply', 120);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.play.mock.calls[0][0]).toBe('reply reply');
});

it('same-ID remote Host change stops speech and fences a late completion without replaying history', async () => {
    const a = remoteFixture('a'), b = remoteFixture('b');
    const mount = async (remoteState: typeof a.remote, id: string, created: number) => {
        await act(async () => root.render(<MobileAutoReadProvider remote remoteState={remoteState} sessionId="s1" directory="/project" active>
            <Probe id={id} created={created} sessionId="s1" />
        </MobileAutoReadProvider>));
        await act(async () => vi.advanceTimersByTime(40));
    };
    await mount(a.remote, 'history', 100); await enable(); await mount(a.remote, 'new-a', 120);
    const finish = mocks.play.mock.calls[0][1];
    await mount(b.remote, 'history', 100);
    expect(mocks.release).toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await mount(b.remote, 'new-b', 130);
    expect(mocks.play).toHaveBeenCalledTimes(2);
});

it('switching local/remote/Host sources never remounts the mobile shell children', async () => {
    const a = remoteFixture('a'), b = remoteFixture('b');
    const mount = async (remoteState?: typeof a.remote) => {
        await act(async () => root.render(<MobileAutoReadProvider remote={Boolean(remoteState)} remoteState={remoteState} sessionId="s1" directory="/project" active>
            <input data-shell-draft defaultValue="preserved" />
        </MobileAutoReadProvider>));
    };
    await mount(); const input = host.querySelector<HTMLInputElement>('[data-shell-draft]')!;
    input.value = 'in progress';
    await mount(a.remote); await mount(b.remote); await mount();
    expect(host.querySelector('[data-shell-draft]')).toBe(input);
    expect(input.value).toBe('in progress');
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const enable = async () => { await act(async () => context!.toggle()); await act(async () => vi.advanceTimersByTime(40)); };

it('does not read existing history or streaming text, then reads a settled reply only once', async () => {
    await enable();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true');
    await render('new', 30, false); expect(mocks.play).not.toHaveBeenCalled();
    await render('new', 30); expect(mocks.play).toHaveBeenCalledTimes(1);
    await render('new', 30); expect(mocks.play).toHaveBeenCalledTimes(1);
    await render('older-page', 5); expect(mocks.play).toHaveBeenCalledTimes(1);
});

it('queues replies until actual audio completion instead of overlapping synthesis', async () => {
    await enable(); await render('one', 30); await render('two', 40);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(playback?.messageId).toBe('one');
    await act(async () => mocks.play.mock.calls[0][1]());
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play.mock.calls[1][0]).toBe('reply two');
    expect(playback?.messageId).toBe('two');
    await act(async () => mocks.play.mock.calls[1][1]());
    expect(playback).toBeNull();
});

it('stops automatic speech from the active message control', async () => {
    await enable(); await render('one', 30);
    expect(playback?.sessionId).toBe('s1');
    await act(async () => playback!.stop());
    expect(playback).toBeNull();
    expect(context!.enabled).toBe(false);
    expect(mocks.stop).toHaveBeenCalled();
});

it('releases screen lock and stops playback on disable; late completion cannot drain queue', async () => {
    await enable(); await render('one', 30); await render('two', 40);
    const finish = mocks.play.mock.calls[0][1];
    await act(async () => context!.toggle());
    await act(async () => finish());
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(context!.enabled).toBe(false);
    expect(playback).toBeNull();
});

it.each(['session', 'leave', 'runtime'])('stops on %s scope changes', async (change) => {
    await enable(); await render('one', 30);
    if (change === 'runtime') await act(async () => mocks.runtimeChanged());
    else await render('one', 30, true, change === 'session' ? 's2' : 's1', change !== 'leave');
    expect(context!.enabled).toBe(true);
    expect(localStorage.getItem('yuri.auto-read')).toBe('true');
    expect(mocks.release).toHaveBeenCalledTimes(1);
});

it('retains the preference across sessions but does not replay their history', async () => {
    await enable(); await render('one', 30);
    const oldFinish = mocks.play.mock.calls[0][1];
    mocks.messages = [{ id: 'history-s2', role: 'assistant', time: { created: 100, completed: 110 } }];
    await render('history-s2', 100, true, 's2');
    expect(context!.enabled).toBe(true);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await act(async () => oldFinish());
    await render('new-s2', 120, true, 's2');
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play.mock.calls[1][0]).toBe('reply new-s2');
});

it('restores localStorage on remount, waits for hydration, and persists an explicit disable', async () => {
    await enable();
    await act(async () => root.unmount());
    root = createRoot(host);
    mocks.resolved = false;
    await render();
    expect(context!.enabled).toBe(true);
    expect(mocks.play).not.toHaveBeenCalled();
    mocks.resolved = true;
    await render();
    expect(mocks.play).not.toHaveBeenCalled();
    await render('after-reload', 30);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await act(async () => context!.toggle());
    expect(localStorage.getItem('yuri.auto-read')).toBe('false');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render('another', 40);
    expect(context!.enabled).toBe(false);
    expect(mocks.play).toHaveBeenCalledTimes(1);
});

it('releases a late wake-lock acquisition after disabling', async () => {
    let resolve!: (release: () => Promise<void>) => void;
    mocks.acquire.mockReturnValue(new Promise((done) => { resolve = done; }));
    await enable(); await act(async () => context!.toggle());
    await act(async () => resolve(mocks.release));
    expect(mocks.release).toHaveBeenCalledTimes(1);
});

it('does not enable before transcript hydration', async () => {
    mocks.resolved = false; await render(); await enable();
    expect(context!.enabled).toBe(false); expect(mocks.acquire).not.toHaveBeenCalled();
});

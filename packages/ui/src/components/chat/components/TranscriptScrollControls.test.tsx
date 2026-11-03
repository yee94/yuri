import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptScrollControls } from './TranscriptScrollControls';
import { getSpeechTracking, pauseSpeechFollowing, trackSpeech } from '@/lib/voice/speech-tracking';

const work = vi.hoisted(() => ({ snapshots: vi.fn(), subscriptions: vi.fn(), cleanup: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/voice/speech-tracking', async (load) => {
    const actual = await load<typeof import('@/lib/voice/speech-tracking')>();
    return {
        ...actual,
        getSpeechTracking: () => { work.snapshots(); return actual.getSpeechTracking(); },
        subscribeSpeechTracking: (listener: () => void) => {
            work.subscriptions();
            const release = actual.subscribeSpeechTracking(listener);
            return () => { work.cleanup(); release(); };
        },
    };
});

let root: Root;
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let playback: ReturnType<typeof trackSpeech> | undefined;
const bottom = vi.fn();
let props: React.ComponentProps<typeof TranscriptScrollControls>;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    scroller = document.createElement('div');
    scroller.innerHTML = '<p data-speech-content>海风轻轻吹来。</p>';
    document.body.append(host, scroller);
    root = createRoot(host);
    props = { scrollRef: { current: scroller }, active: true, showScrollToBottom: false, onScrollToBottom: bottom };
    vi.clearAllMocks();
});
afterEach(async () => {
    await act(async () => { playback?.stop(); root.unmount(); });
    playback = undefined;
    host.remove(); scroller.remove(); vi.unstubAllGlobals();
});
const render = async () => { await act(async () => root.render(<TranscriptScrollControls {...props} />)); };

it('keeps independent bottom and speech actions in one composer-width circular row', async () => {
    await render();
    expect(host.querySelector('button')).toBeNull();
    props.showScrollToBottom = true;
    await render();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    await act(async () => {
        playback = trackSpeech(scroller.firstElementChild as HTMLElement);
        playback.update('海风轻轻吹来。', 0);
    });
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['chat.scrollToBottom.aria', 'chat.messageBody.tts.follow']);
    expect(buttons[0].parentElement).toBe(buttons[1].parentElement);
    expect(buttons[0].parentElement?.className).toContain('chat-input-column');
    for (const button of buttons) {
        expect(button.className).toContain('yuri-mobile-floating-action');
        expect(button.className).toContain('size-10');
    }
    expect(buttons[0].classList.contains('yuri-mobile-inverse-action')).toBe(false);
    expect(buttons[1].classList.contains('yuri-mobile-inverse-action')).toBe(true);
    await act(async () => buttons[0].click());
    expect(bottom).toHaveBeenCalledTimes(1);
    await act(async () => pauseSpeechFollowing(scroller));
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].classList.contains('yuri-mobile-inverse-action')).toBe(false);
    await act(async () => buttons[1].click());
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].classList.contains('yuri-mobile-inverse-action')).toBe(true);
    await act(async () => playback?.stop());
    expect(host.querySelectorAll('button')).toHaveLength(1);
});

it('toggles following off and on without changing the current spoken range', async () => {
    await act(async () => {
        playback = trackSpeech(scroller.firstElementChild as HTMLElement);
        playback.update('海风轻轻吹来。', 0);
    });
    await render();
    const button = host.querySelector('button')!;
    const range = getSpeechTracking()?.range;
    for (let index = 0; index < 3; index++) {
        await act(async () => button.click());
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.classList.contains('yuri-mobile-inverse-action')).toBe(false);
        expect(getSpeechTracking()?.range).toBe(range);
        await act(async () => button.click());
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.classList.contains('yuri-mobile-inverse-action')).toBe(true);
        expect(getSpeechTracking()?.range).toBe(range);
    }
});

it('does not expose another transcript’s speech action or any action on an inactive surface', async () => {
    await act(async () => { playback = trackSpeech(document.createElement('div')); });
    await render();
    expect(host.querySelector('button')).toBeNull();
    props.showScrollToBottom = true;
    props.active = false;
    await render();
    expect(host.querySelector('button')).toBeNull();
});

it('does no leaf snapshot or subscription work over 50 unrelated parent updates', async () => {
    function Parent({ version }: { version: number }) {
        return <div data-version={version}><TranscriptScrollControls {...props} /></div>;
    }
    await act(async () => root.render(<Parent version={0} />));
    work.snapshots.mockClear(); work.subscriptions.mockClear(); work.cleanup.mockClear();
    for (let version = 1; version <= 50; version++) {
        await act(async () => root.render(<Parent version={version} />));
    }
    expect(work.snapshots).not.toHaveBeenCalled();
    expect(work.subscriptions).not.toHaveBeenCalled();
    expect(work.cleanup).not.toHaveBeenCalled();
    props = { ...props, showScrollToBottom: true, onScrollToBottom: vi.fn() };
    await act(async () => root.render(<Parent version={51} />));
    await act(async () => host.querySelector('button')!.click());
    expect(props.onScrollToBottom).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
});

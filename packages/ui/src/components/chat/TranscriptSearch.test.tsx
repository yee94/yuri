import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChatMessageEntry } from './lib/turns/types';
import { TranscriptSearch } from './TranscriptSearch';
import { TranscriptSearchContext } from './TranscriptSearchContext';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({
    t: (key: string, params?: { current: number; total: number }) => params ? `${params.current}/${params.total}` : key,
}) }));

const entry = (text: string): ChatMessageEntry => ({ info: { id: 'message', role: 'assistant' }, parts: [{ id: 'part', type: 'text', text }] } as ChatMessageEntry);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onNavigate = vi.fn();
const canOpen = vi.fn(() => true);
const observedTargets: unknown[] = [];

function Target() {
    const target = React.useContext(TranscriptSearchContext);
    observedTargets.push(target);
    return <output>{target ? `${target.partId}:${target.occurrence}` : ''}</output>;
}
const child = <Target />;
const render = async (messages = [entry('hello hello')], enabled = true, key = 'session') => {
    await act(async () => root.render(<TranscriptSearch key={key} messages={messages} enabled={enabled} canOpen={canOpen} onNavigate={onNavigate}>{child}</TranscriptSearch>));
};
const keydown = async (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    await act(async () => (document.activeElement ?? window).dispatchEvent(event));
    return event;
};
const type = async (value: string) => {
    const input = host.querySelector('input')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onNavigate.mockClear(); canOpen.mockReset().mockReturnValue(true); observedTargets.length = 0;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

test('Cmd/Ctrl+F focuses search, Enter cycles hits, Shift+Enter reverses, Escape restores focus', async () => {
    const button = document.createElement('button'); document.body.append(button); button.focus();
    await render();
    expect((await keydown('f', { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('[role="search"]')?.querySelectorAll('button')).toHaveLength(3);
    expect(host.querySelector('input')?.dataset.bordered).toBe('false');
    expect(host.querySelector('[role="search"] input[type="checkbox"]')).toBeNull();
    await type('hello');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('1/2');
    expect(host.querySelector('output')?.textContent).toBe('part:0');
    await keydown('Enter');
    expect(host.querySelector('output')?.textContent).toBe('part:1');
    await keydown('Enter');
    expect(host.querySelector('output')?.textContent).toBe('part:0');
    await keydown('Enter', { shiftKey: true });
    expect(host.querySelector('output')?.textContent).toBe('part:1');
    await keydown('f', { ctrlKey: true });
    expect(host.querySelector('input')?.selectionStart).toBe(0);
    expect(host.querySelector('input')?.selectionEnd).toBe(5);
    await keydown('Escape');
    expect(host.querySelector('[role="search"]')).toBeNull();
    expect(host.querySelector('output')?.textContent).toBe('');
    expect(document.activeElement).toBe(button);
    button.remove();
});

test('closed/disabled find does not touch message data or intercept other surfaces', async () => {
    let reads = 0;
    const messages = [entry('hello')];
    Object.defineProperty(messages[0], 'parts', { get: () => { reads++; throw new Error('must not search'); } });
    await render(messages);
    for (let i = 0; i < 50; i++) await render([...messages]);
    expect(reads).toBe(0);
    canOpen.mockReturnValue(false);
    expect((await keydown('f', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(host.querySelector('input')).toBeNull();
    await render(messages, false);
    expect((await keydown('f', { metaKey: true })).defaultPrevented).toBe(false);
    expect(reads).toBe(0);
});

test('unrelated deltas do not change the selected target, new sessions clear find', async () => {
    await render(); await keydown('f', { metaKey: true }); await type('hello');
    observedTargets.length = 0; onNavigate.mockClear();
    for (let i = 0; i < 50; i++) await render([entry(`hello hello ${i}`)]);
    expect(observedTargets).toHaveLength(0);
    expect(onNavigate).not.toHaveBeenCalled();
    await render([entry('hello')], true, 'another-session');
    expect(host.querySelector('[role="search"]')).toBeNull();
    expect(host.querySelector('output')?.textContent).toBe('');
});

test('no results disables navigation and a single result can be revealed again after user scrolling', async () => {
    await render([entry('one')]); await keydown('f', { ctrlKey: true }); await type('missing');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('0/0');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="chat.find.next"]')?.disabled).toBe(true);
    await type('one');
    const before = observedTargets.at(-1);
    await keydown('Enter');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('1/1');
    expect(observedTargets.at(-1)).not.toBe(before);
    await render([entry('one')], false);
    await render([entry('one')], true);
    expect(host.querySelector('[role="search"]')).toBeNull();
});

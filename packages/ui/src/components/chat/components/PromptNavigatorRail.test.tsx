import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, test, vi } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import { useUIStore } from '@/stores/useUIStore';
import { PromptNavigatorRail } from './PromptNavigatorRail';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({
    useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }),
}));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/queries/installedSkillsQueries', () => ({ useInstalledSkillsQuery: () => ({ data: [] }) }));

beforeAll(async () => { await import('../MarkdownRendererImpl'); });

test('prompt navigation is enabled by default without opening the keyboard preview', () => {
    const initial = useUIStore.getInitialState();
    expect(initial.promptNavigatorEnabled).toBe(true);
    expect(initial.isPromptNavigatorPanelOpen).toBe(false);
});

test.each([false, true])('preserves saved prompt navigation enablement (%s)', (enabled) => {
    const initial = useUIStore.getInitialState();
    const options = useUIStore.persist.getOptions();
    const saved = options.partialize!({ ...initial, promptNavigatorEnabled: enabled });
    const restored = options.merge!(saved, initial);
    expect(restored.promptNavigatorEnabled).toBe(enabled);
});

test('navigation removes chip references before truncation and preserves turn selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSelectTurn = vi.fn();
    const textPart = (text: string) => ({ type: 'text', text } as Part);
    const previews = new Map([
        ['body', [textPart(`[/attachments/${'long-path/'.repeat(25)}image.png] [skill:review] 请检查 [说明](https://example.com) [普通文本]`)]],
        ['chips', [textPart('[image.png] [command:/commands/review.md]')]],
    ]);
    try {
        await act(async () => root.render(<PromptNavigatorRail
            turnIds={['body', 'chips']}
            previewsByTurnId={previews}
            activeTurnId="body"
            repliesByTurnId={new Map([['body', '这是对应的 AI 回复。'], ['chips', '另一轮回复。']])}
            onSelectTurn={onSelectTurn}
            canLoadEarlier={false}
            isLoadingOlder={false}
            onLoadEarlier={() => {}}
        />));
        const ticks = host.querySelectorAll('[role="option"]');
        expect(ticks[0].getAttribute('aria-label')).toBe('请检查 [说明](https://example.com) [普通文本]');
        expect(ticks[1].getAttribute('aria-label')).toBe('chat.timeline.noTextContent');
        await act(async () => useUIStore.getState().setPromptNavigatorPanelOpen(true));
        await act(async () => {
            await vi.waitFor(() => expect(host.querySelector('a[href="https://example.com"]')).not.toBeNull());
        });
        expect(host.textContent).toContain('这是对应的 AI 回复。');
        expect(host.textContent).not.toContain('另一轮回复。');
        const rail = host.querySelector('[role="listbox"]')!;
        await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(onSelectTurn).toHaveBeenCalledExactlyOnceWith('body');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

test('only the highlighted preview renders shared chips and Markdown, and links still select the turn', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onSelectTurn = vi.fn();
    const textPart = (text: string) => ({ type: 'text', text } as Part);
    const turnIds = Array.from({ length: 1000 }, (_, index) => `turn-${index}`);
    const previews = new Map(turnIds.map((id) => [id, [textPart('[skill:review] **检查** [说明](https://example.com)')]]));
    const replies = new Map([['turn-999', '已启动：[服务](http://127.0.0.1:5180)，支持 **热更新** 和 `代码`。']]);
    const render = () => root.render(<PromptNavigatorRail
        turnIds={turnIds}
        previewsByTurnId={previews}
        activeTurnId="turn-999"
        repliesByTurnId={replies}
        onSelectTurn={onSelectTurn}
        canLoadEarlier={false}
        isLoadingOlder={false}
        onLoadEarlier={() => {}}
    />);
    try {
        await act(async () => render());
        for (let index = 0; index < 50; index++) await act(async () => render());
        expect(host.querySelector('[data-message-reference-kind]')).toBeNull();
        expect(host.querySelector('[data-markdown-content]')).toBeNull();
        expect(host.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(38);

        await act(async () => useUIStore.getState().setPromptNavigatorPanelOpen(true));
        await act(async () => {
            await vi.waitFor(() => expect(host.querySelector('a[href="http://127.0.0.1:5180"]')).not.toBeNull());
        });
        expect(host.querySelectorAll('[data-message-reference-kind="skill"]')).toHaveLength(1);
        expect(host.querySelector('[data-message-reference-kind="skill"]')?.textContent).toContain('review');
        expect([...host.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['检查', '热更新']);
        expect(host.querySelector('code')?.textContent).toBe('代码');
        expect(host.querySelector('[data-transcript-search-part]')).toBeNull();
        expect(host.querySelector('[data-user-message-collapse="true"]')).toBeNull();

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        await act(async () => host.querySelector('a[href="http://127.0.0.1:5180"]')!.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(true);
        expect(onSelectTurn).toHaveBeenCalledExactlyOnceWith('turn-999');
        expect(host.querySelector('[data-message-reference-kind]')).toBeNull();
        expect(host.querySelector('[data-markdown-content]')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

test('all intersecting turns are highlighted, including assistant-only visibility and recycled rows', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let notify: IntersectionObserverCallback = () => {};
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: IntersectionObserverCallback) { notify = callback; }
        observe(element: Element) { observed.add(element); }
        unobserve(element: Element) { observed.delete(element); }
        disconnect() { observed.clear(); }
    });
    const host = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.innerHTML = '<div data-message-id="reply-1"></div><div data-turn-id="turn-2"></div><div data-turn-id="turn-3"></div>';
    document.body.append(scroll, host);
    const root = createRoot(host);
    const emit = async (elements: Element[], isIntersecting: boolean) => {
        await act(async () => notify(elements.map((target) => ({
            target, isIntersecting, intersectionRect: { height: isIntersecting ? 50 : 0 },
        } as IntersectionObserverEntry)), {} as IntersectionObserver));
    };
    const current = () => [...host.querySelectorAll('[aria-current="true"]')].map((node) => node.id);
    try {
        await act(async () => root.render(<PromptNavigatorRail
            turnIds={['turn-1', 'turn-2', 'turn-3']}
            previewsByTurnId={new Map()}
            activeTurnId="turn-3"
            scrollRef={{ current: scroll }}
            turnByMessageId={new Map([['reply-1', 'turn-1'], ['turn-2', 'turn-2'], ['turn-3', 'turn-3']])}
            onSelectTurn={() => {}}
            canLoadEarlier={false}
            isLoadingOlder={false}
            onLoadEarlier={() => {}}
        />));
        expect(observed.size).toBe(3);
        await emit([scroll.children[0], scroll.children[1]], true);
        expect(current()).toEqual(['prompt-rail-tick-turn-1', 'prompt-rail-tick-turn-2']);
        await emit([scroll.children[0]], false);
        expect(current()).toEqual(['prompt-rail-tick-turn-2']);
        await act(async () => scroll.children[1].remove());
        expect(current()).toEqual([]);
        const replacement = document.createElement('div');
        replacement.dataset.messageId = 'reply-1';
        await act(async () => scroll.append(replacement));
        expect(observed.has(replacement)).toBe(true);
        await emit([replacement], true);
        expect(current()).toEqual(['prompt-rail-tick-turn-1']);
    } finally {
        await act(async () => root.unmount());
        expect(observed.size).toBe(0);
        host.remove();
        scroll.remove();
        vi.unstubAllGlobals();
    }
});

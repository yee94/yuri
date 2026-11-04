import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import { statusBarPopoverSurfaceClassName } from '../chat/statusBarPopover';
import { WorkStatusToggle } from '../chat/work-status/WorkStatusToggle';

const fixture = vi.hoisted(() => ({
    session: {
        currentSessionId: null as string | null,
        currentSessionDirectory: '/repo',
        newSessionDraft: { open: true, draftEstablishing: false, draftSubmitting: false, pendingUserMessage: null as object | null },
    },
    ui: {
        isMobile: false, isExpandedInput: false, isRightSidebarOpen: false,
        workStatusPanelEnabled: true, workStatusPanelFits: false, workStatusOverlayOpen: false,
        contextPanelByDirectory: {},
        setWorkStatusPanelFits: vi.fn(), setWorkStatusPanelVisible: vi.fn(), setWorkStatusOverlayOpen: vi.fn(),
        setWorkStatusPanelEnabled: vi.fn(),
    },
    transcript: [] as object[],
    paintedWidths: [] as (string | null)[],
}));

vi.mock('@/stores/useUIStore', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/stores/useUIStore')>(),
    normalizeContextPanelDirectoryKey: (directory: string) => directory,
    useUIStore: (selector: (state: typeof fixture.ui) => unknown) => selector(fixture.ui),
}));
vi.mock('@/sync/session-ui-store', () => ({
    useSessionUIStore: (selector: (state: typeof fixture.session) => unknown) => selector(fixture.session),
}));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => fixture.transcript }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/chat/ChatErrorBoundary', () => ({ ChatErrorBoundary: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/chat/work-status/WorkStatusCompact', () => ({ WorkStatusCompact: () => <span>Project status</span> }));
vi.mock('@/components/chat/ChatContainer', () => ({
    ChatContainer: () => {
        React.useLayoutEffect(() => {
            fixture.paintedWidths.push(document.querySelector<HTMLElement>('aside[aria-hidden="false"]')?.style.width ?? null);
        });
        return <main>Chat</main>;
    },
}));

let root: Root;
let host: HTMLDivElement;
let viewportWidth: number;
let mediaQueries: Map<string, MediaQueryList>;
const resize = (width: number) => {
    viewportWidth = width;
    for (const query of mediaQueries.values()) query.dispatchEvent(new Event('change'));
};

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fixture.session.currentSessionId = null;
    Object.assign(fixture.session.newSessionDraft, { open: true, draftEstablishing: false, draftSubmitting: false, pendingUserMessage: null });
    Object.assign(fixture.ui, { isMobile: false, isRightSidebarOpen: false, workStatusPanelEnabled: true, workStatusPanelFits: false, workStatusOverlayOpen: false, contextPanelByDirectory: {} });
    fixture.ui.setWorkStatusPanelFits.mockImplementation((fits: boolean) => { fixture.ui.workStatusPanelFits = fits; });
    fixture.ui.setWorkStatusOverlayOpen.mockImplementation((open: boolean) => { fixture.ui.workStatusOverlayOpen = open; });
    fixture.ui.setWorkStatusPanelEnabled.mockImplementation((enabled: boolean) => {
        fixture.ui.workStatusPanelEnabled = enabled;
        fixture.ui.workStatusOverlayOpen = false;
    });
    fixture.transcript = [];
    fixture.paintedWidths = [];
    viewportWidth = 1600;
    mediaQueries = new Map();
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
        let query = mediaQueries.get(media);
        if (!query) {
            query = Object.assign(new EventTarget(), {
                media, matches: false, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
            }) as MediaQueryList;
            Object.defineProperty(query, 'matches', { get: () => viewportWidth >= Number(media.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) });
            mediaQueries.set(media, query);
        }
        return query;
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

it('reserves the column on the first chat paint and keeps it through session creation and transcript arrival', async () => {
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    fixture.session.newSessionDraft.draftEstablishing = true;
    fixture.session.newSessionDraft.pendingUserMessage = { id: 'pending' };
    fixture.paintedWidths = [];
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths[0]).toBe('196px');
    const column = host.querySelector('aside');
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside')).toBe(column);
    fixture.transcript = [{ id: 'message' }];
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths.every((width) => width === '196px')).toBe(true);
    expect(host.querySelector<HTMLElement>('aside')?.style.transitionProperty).toBe('none');
});

it('uses the current viewport on initial session entry and only shows inline at 1440px or wider', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    viewportWidth = 1439;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    await act(async () => resize(1440));
    const inline = host.querySelector<HTMLElement>('aside[aria-hidden="false"]');
    expect(inline?.style.width).toBe('196px');
    expect(inline?.style.right).toBe('14px');
    expect(inline?.className).toContain('absolute');
    expect(inline?.className).not.toContain('yuri-mobile-overlay-surface');
    for (const shadowClass of statusBarPopoverSurfaceClassName.split(' ')) {
        expect(inline?.classList.contains(shadowClass)).toBe(false);
    }
    expect(host.querySelector('.absolute.inset-0')).not.toBeNull();
    expect(host.textContent).toContain('Project status');
    await act(async () => resize(1439));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
});

it('shows a selected session before its transcript loads, without a hidden first paint', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths[0]).toBe('196px');
});

it.each([1200, 1600])('opens the manually requested status popup beside a file preview at %ipx', async (width) => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    viewportWidth = width;
    fixture.ui.contextPanelByDirectory = {
        '/repo': { isOpen: true, activeTabId: 'file', tabs: [{ id: 'file', mode: 'file' }] },
    };
    fixture.ui.isRightSidebarOpen = true;
    const render = () => root.render(<><WorkStatusToggle /><ChatView /></>);
    await act(async () => render());
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-work-status-toggle]')!.click());
    await act(async () => render());
    const popup = host.querySelector<HTMLElement>('aside[aria-hidden="false"]');
    expect(popup?.textContent).toBe('Project status');
    expect(popup?.style.width).toBe('264px');
    expect(host.querySelector('.yuri-chat-work-status-inline')).toBeNull();
    expect(fixture.ui.isRightSidebarOpen).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-work-status-toggle]')!.click());
    await act(async () => render());
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-work-status-toggle]')!.click());
    await act(async () => render());
    expect(host.querySelector('aside[aria-hidden="false"]')?.textContent).toBe('Project status');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => render());
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
});

it('opens the narrow popup on the first click even when the saved preference is disabled', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    fixture.ui.workStatusPanelEnabled = false;
    viewportWidth = 1200;
    const render = () => root.render(<><WorkStatusToggle /><ChatView /></>);
    await act(async () => render());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-work-status-toggle]')!.click());
    await act(async () => render());
    expect(host.querySelector('aside[aria-hidden="false"]')?.textContent).toBe('Project status');
});

it.each([1600, 1200])('keeps the status column mounted when opening a subagent chat at %ipx', async (width) => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    fixture.ui.workStatusOverlayOpen = true;
    viewportWidth = width;
    await act(async () => root.render(<ChatView />));
    const column = host.querySelector('aside[aria-hidden="false"]');
    expect(column).not.toBeNull();
    fixture.ui.contextPanelByDirectory = {
        '/repo': { isOpen: true, activeTabId: 'child', tabs: [{ id: 'child', mode: 'chat' }] },
    };
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBe(column);
    fixture.ui.contextPanelByDirectory = {
        '/repo': { isOpen: true, activeTabId: 'file', tabs: [{ id: 'file', mode: 'file' }] },
    };
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector<HTMLElement>('aside[aria-hidden="false"]')?.style.width).toBe('264px');
    expect(host.querySelector('.yuri-chat-work-status-inline')).toBeNull();
});

it('retains manual overlay display below the breakpoint, ignores a hidden rail and excludes mobile', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    viewportWidth = 1200;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    fixture.ui.workStatusOverlayOpen = true;
    await act(async () => root.render(<ChatView />));
    const overlay = host.querySelector<HTMLElement>('aside[aria-hidden="false"]');
    expect(overlay?.className).toContain('absolute');
    expect(overlay?.className).not.toContain('bg-[var(--surface-elevated)]');
    for (const shadowClass of statusBarPopoverSurfaceClassName.split(' ')) {
        expect(overlay?.classList.contains(shadowClass)).toBe(true);
    }
    expect(overlay?.textContent).toBe('Project status');
    fixture.ui.isRightSidebarOpen = true;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBe(overlay);
    fixture.ui.isRightSidebarOpen = false;
    fixture.ui.isMobile = true;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside')).toBeNull();
});

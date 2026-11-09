import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  project: { id: 'p', path: '/repo' }, worktrees: new Map(), branches: { all: ['main'], current: 'main' },
  validate: vi.fn(async (): Promise<{ ok: boolean; errors: Array<{ code: string; message: string }> }> => ({ ok: true, errors: [] })), fetchBranches: vi.fn(), t: (key: string) => key,
  branchError: null as Error | null, branchesLoading: false,
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: {}, github: {} }) }));
vi.mock('@/queries/githubAuthQueries', () => ({ useGitHubAuthQuery: () => ({ data: { connected: false }, isFetched: true }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (value: unknown) => unknown) => select({ projects: [h.project], activeProjectId: 'p' }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: unknown) => unknown) => select({ isMobile: true }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (value: unknown) => unknown) => select({ availableWorktreesByProject: h.worktrees }) }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: {} }));
vi.mock('@/sync/session-actions', () => ({}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: {} }));
vi.mock('@/stores/useGitStore', () => ({ useGitBranches: () => h.branches, useGitLoadingBranches: () => false, useGitStore: (select: (value: unknown) => unknown) => select({ fetchBranches: h.fetchBranches }) }));
vi.mock('@/queries/gitBranchQueries', () => ({ useGitBranchesQuery: () => ({ data: h.branches, error: h.branchError, isFetching: h.branchesLoading, refetch: h.fetchBranches }) }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ validateWorktreeCreate: h.validate, createWorktree: vi.fn() }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: h.t }) }));
vi.mock('@/components/session/GitHubIntegrationDialog', () => ({ GitHubIntegrationDialog: () => null }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileResizableSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { useScrollShadow?: boolean; outerClassName?: string; disableHorizontal?: boolean; preventOverscroll?: boolean }>(function Scroller({ children, useScrollShadow = false, outerClassName: _outer, disableHorizontal: _horizontal, preventOverscroll: _overscroll, ...props }, ref) { return <div {...props} ref={ref} data-scroll-shadow={String(useScrollShadow)}>{children}</div>; }) }));
vi.mock('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

import { NewWorktreeDialog } from './NewWorktreeDialog';
import { MobileWindowActiveContext } from '../ui/mobile-window-active-context';

afterEach(() => { vi.useRealTimers(); h.validate.mockReset().mockResolvedValue({ ok: true, errors: [] }); h.branchError = null; h.branchesLoading = false; h.branches = { all: ['main'], current: 'main' }; h.fetchBranches.mockReset(); vi.unstubAllGlobals(); });
test('the worktree form never fades a focused field at the keyboard-bounded scroll edge', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<NewWorktreeDialog open onOpenChange={() => {}} projectId="p" />));
    const field = host.querySelector('input[placeholder="session.newWorktree.worktreeDirectoryPlaceholder"]')!;
    expect(field).toBeTruthy();
    expect(field.closest('[data-scroll-shadow]')?.getAttribute('data-scroll-shadow')).toBe('false');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('mobile form reveals the complete focused field after focus or viewport resize, not on typing or manual scrolling', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewport = Object.assign(new EventTarget(), { height: 376, offsetTop: 200 });
  vi.stubGlobal('visualViewport', viewport);
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly disconnect = vi.fn();
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const flush = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }); };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (open = true) => root.render(<NewWorktreeDialog open={open} onOpenChange={() => {}} projectId="p" />);
  try {
    await act(async () => render());
    const input = host.querySelector<HTMLInputElement>('input[placeholder="session.newWorktree.worktreeDirectoryPlaceholder"]')!;
    const scroller = input.closest<HTMLElement>('[data-scroll-shadow]')!;
    const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 368, width: 368, height: bottom - top, x: 0, y: top, toJSON() {} });
    let bottom = 306;
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => box(77, 303));
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => box(bottom - 36, bottom));
    const reveal = vi.spyOn(input, 'scrollIntoView').mockImplementation(() => { bottom = 294; });
    await act(async () => input.focus()); await flush();
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    expect(document.activeElement).toBe(input);
    bottom = 306;
    await act(async () => { for (let i = 0; i < 50; i++) viewport.dispatchEvent(new Event('resize')); });
    expect(frames.size).toBe(1); await flush(); expect(reveal).toHaveBeenCalledTimes(2);
    await act(async () => { for (let i = 0; i < 50; i++) viewport.dispatchEvent(new Event('scroll')); });
    await flush(); expect(reveal).toHaveBeenCalledTimes(2);
    bottom = 306;
    await act(async () => { observers[0].callback([], observers[0]); });
    await flush(); expect(reveal).toHaveBeenCalledTimes(3);
    bottom = 306;
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush(); expect(reveal).toHaveBeenCalledTimes(3);
    await act(async () => { viewport.dispatchEvent(new Event('resize')); input.blur(); });
    await flush(); expect(reveal).toHaveBeenCalledTimes(3);
    await act(async () => { input.focus(); });
    await act(async () => render(false));
    expect(frames.size).toBe(0); await flush(); expect(reveal).toHaveBeenCalledTimes(3);
    expect(observers[0].disconnect).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); }
});

test('a covered mobile form never reveals or refocuses its field on viewport changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewport = Object.assign(new EventTarget(), { height: 376, offsetTop: 200 });
  vi.stubGlobal('visualViewport', viewport);
  const frame = vi.spyOn(window, 'requestAnimationFrame');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MobileWindowActiveContext.Provider value={false}><NewWorktreeDialog open onOpenChange={() => {}} projectId="p" /></MobileWindowActiveContext.Provider>));
    const input = host.querySelector<HTMLInputElement>('input[placeholder="session.newWorktree.worktreeDirectoryPlaceholder"]')!;
    const reveal = vi.spyOn(input, 'scrollIntoView');
    await act(async () => input.focus());
    frame.mockClear();
    await act(async () => { for (let i = 0; i < 50; i++) viewport.dispatchEvent(new Event('resize')); });
    expect(frame).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); }
});
test.each(['success', 'failure'])('a touched worktree form validates once after %s, not on its own status updates or 50 unrelated parent renders', async (outcome) => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (outcome === 'failure') h.validate.mockRejectedValueOnce(new Error('Isolated validation offline'));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const close = () => {};
  const render = (tick: number, open = true) => root.render(<><span>{tick}</span><NewWorktreeDialog open={open} onOpenChange={close} projectId="p" /></>);
  try {
    await act(async () => render(0));
    const input = host.querySelector('input[placeholder="session.newWorktree.branchNamePlaceholder"]')!;
    expect(input).toBeTruthy();
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(h.validate).toHaveBeenCalledTimes(1);
    for (let tick = 1; tick <= 50; tick++) {
      await act(async () => render(tick));
      await act(async () => vi.advanceTimersByTimeAsync(300));
    }
    expect(h.validate).toHaveBeenCalledTimes(1);
    await act(async () => render(51, false));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(h.validate).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
test('closing and reopening a form cancels adoption of a late validation rejection from the old draft', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolve!: (result: { ok: boolean; errors: Array<{ code: string; message: string }> }) => void;
  h.validate.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const close = () => {};
  const render = (open: boolean) => root.render(<NewWorktreeDialog open={open} onOpenChange={close} projectId="p" />);
  try {
    await act(async () => render(true));
    const input = host.querySelector('input[placeholder="session.newWorktree.branchNamePlaceholder"]')!;
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(h.validate).toHaveBeenCalledTimes(1);
    await act(async () => render(false)); await act(async () => render(true));
    await act(async () => resolve({ ok: false, errors: [{ code: 'branch_exists', message: 'Late old draft conflict' }] }));
    expect(host.textContent).not.toContain('Late old draft conflict');
    expect(host.querySelector('input[placeholder="session.newWorktree.branchNamePlaceholder"]')).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(h.validate).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('a failed branch refresh preserves the draft and directory, exposes explicit retry, and distinguishes successful empty', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (tick: number) => root.render(<><span>{tick}</span><NewWorktreeDialog open onOpenChange={() => {}} projectId="p" /></>);
  try {
    await act(async () => render(0));
    const input = host.querySelector('input[placeholder="session.newWorktree.branchNamePlaceholder"]') as HTMLInputElement;
    const draft = input.value;
    const picker = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'main')!;
    await act(async () => picker.click());
    h.branchError = new Error('Isolated branch refresh unavailable');
    for (let i = 1; i <= 50; i++) await act(async () => render(i));
    expect(host.textContent).toContain('Isolated branch refresh unavailable');
    expect(input.value).toBe(draft);
    expect(host.textContent).not.toContain('session.newWorktree.noBranchesFound');
    expect(h.fetchBranches).not.toHaveBeenCalled();
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'layout.browserProvider.retry')!;
    await act(async () => retry.click());
    expect(h.fetchBranches).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false });
    h.branchError = null; h.branches = { all: [], current: 'main' };
    await act(async () => render(51));
    expect(host.textContent).not.toContain('Isolated branch refresh unavailable');
    expect(host.textContent).toContain('session.newWorktree.noBranchesFound');
    expect(input.value).toBe(draft);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

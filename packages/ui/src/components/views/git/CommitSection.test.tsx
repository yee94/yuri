import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CommitSection } from './CommitSection';
import { Input } from '@/components/ui/input';

const fixture = vi.hoisted(() => ({ mobile: false, contentHeight: 0 }));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile, hasTouchInput: fixture.mobile }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

let host: HTMLDivElement;
let root: Root;
let props: React.ComponentProps<typeof CommitSection>;

const render = async (overrides: Partial<typeof props> = {}) => {
  props = { ...props, ...overrides };
  await act(async () => root.render(<CommitSection {...props} />));
};
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const resizeHandle = () => host.querySelector<HTMLDivElement>('[role="separator"]')!;
const pointer = (handle: HTMLDivElement, type: string, clientY: number, pointerId = 1, button = 0) => {
  handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientY, button, isPrimary: true }));
};
const prepareResize = () => {
  const handle = resizeHandle();
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  const input = host.querySelector('textarea')!;
  const measure = vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, parseFloat(input.style.height)));
  return { handle, input, measure };
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mobile = false;
  fixture.contentHeight = 0;
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => fixture.contentHeight);
  props = {
    compact: true,
    stagedCount: 0,
    commitMessage: '',
    onCommitMessageChange: vi.fn(),
    generatedHighlights: [],
    onInsertHighlights: vi.fn(),
    onGenerateMessage: vi.fn(),
    isGeneratingMessage: false,
    onCommit: vi.fn(),
    onCommitAndPush: vi.fn(),
    commitAction: null,
    gitmojiEnabled: true,
    onOpenGitmojiPicker: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compact Git sidebar commit section', () => {
  test('uses a small title, single-line resizable textarea and shared xs actions with a small bottom inset', async () => {
    fixture.contentHeight = 300;
    await render();
    expect(host.querySelector('h3')?.classList.contains('text-xs')).toBe(true);
    const input = host.querySelector('textarea')!;
    expect(input.getAttribute('rows')).toBe('1');
    expect(input.style.height).toBe('38px');
    expect(input.style.minHeight).toBe('38px');
    expect(input.style.maxHeight).toBe('');
    expect(input.style.overflowY).toBe('auto');
    expect(input.classList.contains('resize-none')).toBe(true);
    expect(resizeHandle().classList.contains('top-0')).toBe(true);
    expect(resizeHandle().getAttribute('aria-label')).toBe('textarea.resizeHandleAria');
    expect(input.classList.contains('text-xs')).toBe(true);
    expect(input.classList.contains('focus:ring-1')).toBe(true);
    expect(input.parentElement?.parentElement?.classList.contains('pb-1')).toBe(true);
    expect(button('gitView.commit.commitAria').classList.contains('h-6')).toBe(true);
    expect(button('gitView.commit.generateAria').classList.contains('bg-interactive-hover')).toBe(false);
  });

  test('matches search input edge, hover and focus treatment without adding a second border', async () => {
    await act(async () => root.render(<><CommitSection {...props} /><Input className="rounded-md focus:ring-1" /></>));
    const textarea = host.querySelector('textarea')!;
    const search = host.querySelector('input')!;
    for (const className of [
      'rounded-md', 'ring-1', 'ring-inset', 'ring-border/60',
      'duration-200', 'ease-out',
      'hover:[&:not(:focus)]:ring-transparent',
      'focus:ring-1', 'focus:ring-[var(--interactive-focus-ring)]',
    ]) {
      expect(textarea.classList.contains(className)).toBe(true);
      expect(search.classList.contains(className)).toBe(true);
    }
    expect(textarea.classList.contains('bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--background))]')).toBe(true);
    expect(textarea.classList.contains('hover:[&:not(:focus)]:bg-[color-mix(in_srgb,var(--surface-foreground)_4%,var(--background))]')).toBe(true);
    expect(textarea.classList.contains('border')).toBe(false);
    expect(textarea.classList.contains('transition-[background-color,box-shadow]')).toBe(true);
    expect(textarea.classList.contains('transition')).toBe(false);
  });

  test('preserves a manually resized desktop height while editing, clearing and toggling actions', async () => {
    await render();
    const { handle, input } = prepareResize();
    input.focus();
    await act(async () => {
      pointer(handle, 'pointerdown', 300);
      pointer(handle, 'pointermove', 78);
      pointer(handle, 'pointerup', 78);
    });
    fixture.contentHeight = 300;
    await render({ commitMessage: 'subject\n\nbody' });
    expect(host.querySelector('textarea')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.style.height).toBe('260px');
    await render({ commitMessage: '', stagedCount: 1, commitAction: 'commit' });
    expect(input.style.height).toBe('260px');
    await render({ commitAction: null });
    expect(input.style.height).toBe('260px');
  });

  test('drags the top border in both directions with one layout read and no React commits over 50 moves', async () => {
    const commit = vi.fn();
    await act(async () => root.render(<React.Profiler id="commit" onRender={commit}><CommitSection {...props} /></React.Profiler>));
    const { handle, input, measure } = prepareResize();
    commit.mockClear();
    await act(async () => {
      pointer(handle, 'pointerdown', 300);
      for (let i = 1; i <= 50; i++) pointer(handle, 'pointermove', 300 - i * 2);
    });
    expect(input.style.height).toBe('138px');
    expect(handle.getAttribute('aria-valuenow')).toBe('138');
    expect(measure).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    await act(async () => {
      pointer(handle, 'pointermove', 250);
    });
    expect(input.style.height).toBe('88px');
    await act(async () => {
      pointer(handle, 'pointermove', 400);
      pointer(handle, 'pointerup', 400);
      pointer(handle, 'pointermove', 0);
    });
    expect(input.style.height).toBe('38px');
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  test.each(['pointercancel', 'lostpointercapture'])('ends resizing on %s and ignores other pointers and secondary buttons', async (endEvent) => {
    await render();
    const { handle, input, measure } = prepareResize();
    await act(async () => {
      pointer(handle, 'pointerdown', 300, 1, 2);
      pointer(handle, 'pointermove', 200);
    });
    expect(measure).not.toHaveBeenCalled();
    await act(async () => {
      pointer(handle, 'pointerdown', 300);
      pointer(handle, 'pointermove', 200, 2);
    });
    expect(input.style.height).toBe('38px');
    await act(async () => {
      pointer(handle, 'pointermove', 200);
      pointer(handle, endEvent, 200);
      pointer(handle, 'pointermove', 100);
    });
    expect(input.style.height).toBe('138px');
  });

  test('supports keyboard resizing and disables the border during a commit', async () => {
    await render();
    const { handle, input, measure } = prepareResize();
    const key = (key: string) => handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
    await act(async () => { key('ArrowUp'); });
    expect(input.style.height).toBe('48px');
    await act(async () => { key('ArrowDown'); });
    expect(input.style.height).toBe('38px');
    await act(async () => { key('ArrowUp'); key('ArrowUp'); key('Home'); });
    expect(input.style.height).toBe('38px');
    await render({ commitAction: 'commit' });
    expect(handle.tabIndex).toBe(-1);
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { key('ArrowUp'); pointer(handle, 'pointerdown', 300); pointer(handle, 'pointermove', 100); });
    expect(input.style.height).toBe('38px');
    expect(measure).not.toHaveBeenCalled();
  });

  test('retains mobile multiline growth and the same focused input when editing', async () => {
    fixture.mobile = true;
    props.compact = false;
    await render();
    const input = host.querySelector('textarea')!;
    input.focus();
    fixture.contentHeight = 80;
    await render({ commitMessage: 'subject\n\nbody' });
    expect(host.querySelector('textarea')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.style.height).toBe('80px');
    fixture.contentHeight = 300;
    await render({ commitMessage: 'longer body' });
    expect(input.style.height).toBe('200px');
    expect(input.style.overflowY).toBe('auto');
    fixture.contentHeight = 0;
    await render({ commitMessage: '' });
    expect(input.style.height).toBe('38px');
    expect(input.style.overflowY).toBe('hidden');
  });

  test('preserves staging, pending-index and in-flight guards on all commit actions', async () => {
    await render({ commitMessage: 'feat: example' });
    expect(button('gitView.commit.commitAria').disabled).toBe(true);
    expect(button('gitView.commit.generateAria').disabled).toBe(true);
    await render({ stagedCount: 1 });
    await act(async () => {
      button('gitView.commit.generateAria').click();
      button('gitView.commit.commitAria').click();
      button('gitView.commit.pushAria').click();
      button('gitView.commit.addGitmoji').click();
    });
    expect(props.onGenerateMessage).toHaveBeenCalledOnce();
    expect(props.onCommit).toHaveBeenCalledOnce();
    expect(props.onCommitAndPush).toHaveBeenCalledOnce();
    expect(props.onOpenGitmojiPicker).toHaveBeenCalledOnce();
    await render({ hasPendingIndexMutation: true });
    expect(button('gitView.commit.commitAria').disabled).toBe(true);
    expect(button('gitView.commit.pushAria').disabled).toBe(true);
    expect(button('gitView.commit.generateAria').disabled).toBe(true);
    await render({ hasPendingIndexMutation: false, commitAction: 'commit' });
    expect(host.querySelector('textarea')!.disabled).toBe(true);
    expect(button('gitView.commit.commitAria').disabled).toBe(true);
  });

  test('keeps the noncompact mobile baseline and larger controls unchanged', async () => {
    fixture.mobile = true;
    await render({ compact: false });
    expect(host.querySelector('h3')?.classList.contains('typography-ui-header')).toBe(true);
    expect(host.querySelector('textarea')!.style.height).toBe('38px');
    expect(host.querySelector('textarea')!.classList.contains('resize-none')).toBe(true);
    expect(resizeHandle()).toBeNull();
    expect(button('gitView.commit.commitAria').classList.contains('h-8')).toBe(true);
    expect(host.querySelector('textarea')!.parentElement?.classList.contains('pb-3')).toBe(true);
  });
});

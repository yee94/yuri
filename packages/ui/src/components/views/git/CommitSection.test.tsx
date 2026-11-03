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
  test('uses a small title, three-line textarea and shared xs actions with a small bottom inset', async () => {
    await render();
    expect(host.querySelector('h3')?.classList.contains('text-xs')).toBe(true);
    const input = host.querySelector('textarea')!;
    expect(input.getAttribute('rows')).toBe('3');
    expect(input.style.height).toBe('64px');
    expect(input.style.minHeight).toBe('64px');
    expect(input.classList.contains('text-xs')).toBe(true);
    expect(input.classList.contains('focus:ring-1')).toBe(true);
    expect(input.parentElement?.classList.contains('pb-1')).toBe(true);
    expect(button('gitView.commit.commitAria').classList.contains('h-6')).toBe(true);
    expect(button('gitView.commit.generateAria').classList.contains('bg-interactive-hover')).toBe(false);
  });

  test('matches search input edge, hover and focus treatment without adding a second border', async () => {
    await act(async () => root.render(<><CommitSection {...props} /><Input className="rounded-md focus:ring-1" /></>));
    const textarea = host.querySelector('textarea')!;
    const search = host.querySelector('input')!;
    for (const className of [
      'rounded-md', 'ring-1', 'ring-inset', 'ring-border/60',
      'transition', 'duration-200', 'ease-out',
      'hover:[&:not(:focus)]:ring-transparent',
      'focus:ring-1', 'focus:ring-[var(--interactive-focus-ring)]',
    ]) {
      expect(textarea.classList.contains(className)).toBe(true);
      expect(search.classList.contains(className)).toBe(true);
    }
    expect(textarea.classList.contains('bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--background))]')).toBe(true);
    expect(textarea.classList.contains('hover:[&:not(:focus)]:bg-[color-mix(in_srgb,var(--surface-foreground)_4%,var(--background))]')).toBe(true);
    expect(textarea.classList.contains('border')).toBe(false);
  });

  test('retains multiline growth and the same focused input when editing', async () => {
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
    expect(button('gitView.commit.commitAria').classList.contains('h-8')).toBe(true);
    expect(host.querySelector('textarea')!.parentElement?.classList.contains('pb-3')).toBe(true);
  });
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GitBranchDetails } from '@/lib/api/types';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div data-dropdown>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-dropdown-content className={className}>{children}</div>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string }>(
    ({ children, className }, ref) => <div ref={ref} className={className}>{children}</div>,
  ),
}));

import { BranchSelector } from './BranchSelector';

describe('BranchSelector', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  test('caps large branch lists, ranks multi-token recent matches first, and supports keyboard navigation', async () => {
    const now = Date.now();
    const onCheckout = vi.fn();
    const localBranches = [
      'main',
      ...Array.from({ length: 400 }, (_, i) => `archive/old-${i}`),
      'feat/sidebar-legacy',
      'feat/sidebar-recent',
    ];
    const branchInfo: Record<string, GitBranchDetails> = {
      'feat/sidebar-legacy': { current: false, name: 'feat/sidebar-legacy', commit: '1', label: 'feat/sidebar-legacy', lastUsedAt: now - 90 * 24 * 60 * 60 * 1000 },
      'feat/sidebar-recent': { current: false, name: 'feat/sidebar-recent', commit: '2', label: 'feat/sidebar-recent', lastUsedAt: now - 30_000 },
    };

    await act(async () => {
      root.render(
        <BranchSelector
          open
          directory="/repo"
          currentBranch="main"
          localBranches={localBranches}
          remoteBranches={['origin/feat/sidebar-remote']}
          branchInfo={branchInfo}
          onCheckout={onCheckout}
          onCreate={vi.fn(async () => {})}
        />,
      );
    });

    const content = host.querySelector('[data-dropdown-content]');
    expect(content?.className).toContain('yuri-composer-picker');

    // Empty query caps DOM items instead of mounting all 403 branches.
    const initialItems = host.querySelectorAll('[data-branch-item]');
    expect(initialItems.length).toBeLessThanOrEqual(105);

    const input = host.querySelector<HTMLInputElement>('[data-branch-search-input]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'feat sidebar');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const matchedItems = [...host.querySelectorAll<HTMLButtonElement>('[data-branch-item]')].map(
      (item) => item.dataset.branchItem,
    );
    expect(matchedItems[0]).toBe('match:local:feat/sidebar-recent');
    expect(matchedItems).toContain('match:local:feat/sidebar-legacy');
    expect(matchedItems).toContain('match:remote:origin/feat/sidebar-remote');

    // ArrowDown moves to second match, Enter checks it out.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-branch-item="match:local:feat/sidebar-legacy"]')?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onCheckout).toHaveBeenCalledWith('feat/sidebar-legacy');
  });

  test('supports ArrowRight drill-down and ArrowLeft handoff to previous picker', async () => {
    const onCheckout = vi.fn();
    const onNavigatePrevPicker = vi.fn();

    await act(async () => {
      root.render(
        <BranchSelector
          open
          directory="/repo"
          currentBranch="main"
          localBranches={['main', 'feat/next']}
          remoteBranches={[]}
          branchInfo={{}}
          keepOpenOnCheckout
          onNavigatePrevPicker={onNavigatePrevPicker}
          onCheckout={onCheckout}
          onCreate={vi.fn(async () => {})}
        />,
      );
    });

    const input = host.querySelector<HTMLInputElement>('[data-branch-search-input]')!;
    // ArrowDown from 'main' to 'feat/next', then ArrowRight drills into checkout/follow-up.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(onCheckout).toHaveBeenCalledWith('feat/next');

    // ArrowLeft when search is empty hands off to previous picker.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(onNavigatePrevPicker).toHaveBeenCalledTimes(1);
  });

  test('renders existing worktree badge on non-current local branches and clear create-worktree footer label', async () => {
    await act(async () => {
      root.render(
        <BranchSelector
          open
          directory="/repo"
          currentBranch="main"
          localBranches={['main', 'feat/with-wt', 'feat/no-wt']}
          remoteBranches={[]}
          branchInfo={{}}
          existingWorktreeBranches={new Set(['main', 'feat/with-wt'])}
          onCreateWorktree={vi.fn()}
          onCheckout={vi.fn()}
          onCreate={vi.fn(async () => {})}
        />,
      );
    });

    const mainItem = host.querySelector('[data-branch-item="local:main"]');
    const withWtItem = host.querySelector('[data-branch-item="local:feat/with-wt"]');
    const noWtItem = host.querySelector('[data-branch-item="local:feat/no-wt"]');
    const createWtFooter = host.querySelector('[data-branch-item="action:create-worktree"]');

    expect(mainItem?.textContent).toContain('gitView.branch.currentBadge');
    expect(mainItem?.textContent).not.toContain('gitView.branch.worktreeBadge');
    expect(withWtItem?.textContent).toContain('gitView.branch.worktreeBadge');
    expect(noWtItem?.textContent).not.toContain('gitView.branch.worktreeBadge');
    expect(createWtFooter?.textContent).toContain('chat.chatInput.branchSwitch.createWorktree');
  });

  test('supports inline multi-level followUpStep navigation with Tab, Arrow keys, Enter, and ArrowLeft/Escape', async () => {
    const onCheckoutHere = vi.fn();
    const onCreateWorktree = vi.fn();
    const onBack = vi.fn();

    await act(async () => {
      root.render(
        <BranchSelector
          open
          directory="/repo"
          currentBranch="main"
          localBranches={['main', 'feat/next']}
          remoteBranches={[]}
          branchInfo={{}}
          onCheckout={vi.fn()}
          onCreate={vi.fn(async () => {})}
          followUpStep={{
            title: 'feat/next',
            onBack,
            actions: [
              { id: 'checkout-here', icon: 'arrow-left-right', label: 'Checkout here', onSelect: onCheckoutHere },
              { id: 'create-worktree', icon: 'git-branch', label: 'Create worktree', onSelect: onCreateWorktree },
            ],
          }}
        />,
      );
    });

    const menu = host.querySelector<HTMLDivElement>('[data-branch-followup-step]')!;
    expect(menu).toBeTruthy();
    expect(host.querySelector('[data-branch-followup-action="checkout-here"]')?.getAttribute('data-selected')).toBe('true');

    // Tab moves to second action; Enter runs it.
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-branch-followup-action="create-worktree"]')?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onCreateWorktree).toHaveBeenCalledTimes(1);
    expect(onCheckoutHere).not.toHaveBeenCalled();

    // Shift+Tab moves back to first action; ArrowLeft calls onBack.
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-branch-followup-action="checkout-here"]')?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

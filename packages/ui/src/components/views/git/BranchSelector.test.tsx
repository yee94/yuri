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
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-dropdown-content>{children}</div>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/command', () => ({
  Command: ({ shouldFilter, children }: { shouldFilter?: boolean; children: React.ReactNode }) => (
    <div data-command data-should-filter={String(shouldFilter ?? true)}>
      {children}
    </div>
  ),
  CommandInput: ({ value, onValueChange, placeholder }: { value?: string; onValueChange?: (v: string) => void; placeholder?: string }) => (
    <input
      data-command-input
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onValueChange?.(e.target.value)}
    />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div data-command-list>{children}</div>,
  CommandGroup: ({ heading, children }: { heading?: React.ReactNode; children: React.ReactNode }) => (
    <section data-command-group={String(heading ?? '')}>{children}</section>
  ),
  CommandItem: ({ value, onSelect, children }: { value?: string; onSelect?: () => void; children: React.ReactNode }) => (
    <button type="button" data-command-item={value} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandSeparator: () => <hr />,
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

  test('disables cmdk double-filtering, caps large branch lists, and ranks multi-token recent matches first', async () => {
    const now = Date.now();
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
          onCheckout={vi.fn(async () => {})}
          onCreate={vi.fn(async () => {})}
        />,
      );
    });

    const command = host.querySelector('[data-command]');
    expect(command?.getAttribute('data-should-filter')).toBe('false');

    // Empty query caps DOM items instead of mounting all 403 branches.
    const initialItems = host.querySelectorAll('[data-command-item]');
    expect(initialItems.length).toBeLessThanOrEqual(105);

    const input = host.querySelector<HTMLInputElement>('[data-command-input]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'feat sidebar');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const matchedItems = [...host.querySelectorAll<HTMLButtonElement>('[data-command-item]')].map(
      (item) => item.dataset.commandItem,
    );
    expect(matchedItems[0]).toBe('match:local:feat/sidebar-recent');
    expect(matchedItems).toContain('match:local:feat/sidebar-legacy');
    expect(matchedItems).toContain('match:remote:origin/feat/sidebar-remote');
  });

  test('renders existing worktree badge on non-current local branches with local worktrees', async () => {
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
          onCheckout={vi.fn()}
          onCreate={vi.fn(async () => {})}
        />,
      );
    });

    const mainItem = host.querySelector('[data-command-item="local:main"]');
    const withWtItem = host.querySelector('[data-command-item="local:feat/with-wt"]');
    const noWtItem = host.querySelector('[data-command-item="local:feat/no-wt"]');

    expect(mainItem?.textContent).toContain('gitView.branch.currentBadge');
    expect(mainItem?.textContent).not.toContain('gitView.branch.worktreeBadge');
    expect(withWtItem?.textContent).toContain('gitView.branch.worktreeBadge');
    expect(noWtItem?.textContent).not.toContain('gitView.branch.worktreeBadge');
  });

  test('supports inline multi-level followUpStep navigation with Tab, Arrow keys, Enter, and Escape', async () => {
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

    // Shift+Tab moves back to first action; Escape calls onBack.
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-branch-followup-action="checkout-here"]')?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

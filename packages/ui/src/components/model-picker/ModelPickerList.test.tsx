import { describe, expect, test, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const { persistedCollapsedSections, copyText, copyToast } = vi.hoisted(() => ({
  persistedCollapsedSections: { 'provider:anthropic': true },
  copyText: vi.fn(async (_text: string): Promise<{ ok: boolean }> => ({ ok: true })),
  copyToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: copyText }));
vi.mock('@/components/ui/toast', () => ({ toast: copyToast }));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores/useModelPickerSectionsStore', () => ({
  useModelPickerSectionsStore: (selector: (state: {
    collapsedSections: Record<string, boolean>;
    toggleSection: (key: string) => void;
  }) => unknown) => selector({
    collapsedSections: persistedCollapsedSections,
    toggleSection: () => {},
  }),
}));

vi.mock('@/components/ui/ModelLogo', () => ({
  ModelLogo: () => <span />,
}));

vi.mock('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: () => <span />,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div role="tooltip">{children}</div>,
}));

const { ModelPickerList } = await import('./ModelPickerList');

const renderPicker = (searchQuery: string) => renderToStaticMarkup(
  <ModelPickerList
    providers={[{
      id: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
    }]}
    favoriteModels={[]}
    recentModels={[]}
    searchQuery={searchQuery}
    onSearchQueryChange={() => {}}
    onSelect={() => {}}
    labels={{
      searchPlaceholder: 'Search models',
      noResults: 'No models found',
      favorites: 'Favorites',
      recent: 'Recent',
      keyboardHint: 'Navigate',
    }}
  />,
);

describe('ModelPickerList section collapse state', () => {
  test('expands a persisted-collapsed provider during search', () => {
    expect(renderPicker('')).not.toContain('Claude Sonnet 4');
    expect(renderPicker('sonnet')).toContain('Claude Sonnet 4');
    expect(persistedCollapsedSections['provider:anthropic']).toBe(true);
  });

  test('marks headers and search for popup-only transparent material', () => {
    const markup = renderPicker('');
    expect(markup).toContain('model-picker-section-header');
    expect(markup).toContain('model-picker-search');
  });
});

describe('ModelPickerList model identity', () => {
  test.each(['Custom Provider', undefined])('shows the full ID only in every model popup with provider %s', async (providerName) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const modelID = `Namespace/${'Long-Model-ID-'.repeat(8)}2026`;
    const model = { id: modelID, name: 'Friendly name' };
    const entry = { providerID: 'custom-provider', modelID, model };
    const onSelect = vi.fn();
    try {
      await React.act(async () => root.render(
        <ModelPickerList
          providers={[{ id: 'custom-provider', name: providerName, models: [model, { id: 'second-model', name: 'Second model' }] }]}
          favoriteModels={[entry]}
          recentModels={[entry]}
          searchQuery=""
          onSearchQueryChange={() => {}}
          onSelect={onSelect}
          labels={{ searchPlaceholder: 'Search models', noResults: 'No models found', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'Navigate', provider: 'Provider' }}
        />,
      ));

      const rows = container.querySelectorAll('[role="option"]');
      expect(rows).toHaveLength(4);
      for (const [index, row] of Array.from(rows).entries()) {
        expect(row.textContent).not.toContain('id: ');
        await React.act(async () => {
          row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: index * 30 }));
        });
        await React.act(async () => {
          vi.advanceTimersByTime(450);
        });
        const tooltip = container.querySelector('[role="tooltip"]');
        const copyButton = tooltip?.querySelector('button');
        const identifier = `custom-provider/${index === 3 ? 'second-model' : modelID}`;
        expect(copyButton?.textContent).toBe(identifier);
        expect(copyButton?.className).toContain('cursor-copy');
        expect(copyButton?.className).toContain('h-auto');
        expect(copyButton?.className).toContain('p-0');
        expect(copyButton?.parentElement?.lastElementChild).toBe(copyButton);
        expect(copyButton?.querySelector('span')?.className).toContain('text-right');
        expect(copyButton?.querySelector('span')?.className).toContain('w-full');
        expect(copyButton?.querySelector('span')?.className).toContain('text-[10px]');
        expect(copyButton?.querySelector('span')?.className).toContain('truncate');
        expect(copyButton?.title).toBe(identifier);
        await React.act(async () => copyButton?.click());
        expect(copyText).toHaveBeenLastCalledWith(identifier);
        expect(copyToast.success).toHaveBeenLastCalledWith('contextSidebar.actions.copied');
        expect(onSelect).not.toHaveBeenCalled();
        expect(tooltip?.textContent).toContain(`Provider${providerName || 'custom-provider'}`);
      }
      copyToast.success.mockClear();
      copyToast.error.mockClear();
      copyText.mockResolvedValueOnce({ ok: false });
      await React.act(async () => container.querySelector<HTMLButtonElement>('[role="tooltip"] button')?.click());
      expect(copyToast.error).toHaveBeenCalledWith('filesView.toast.copyFailed');
      expect(copyToast.success).not.toHaveBeenCalled();
      copyText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
      await React.act(async () => container.querySelector<HTMLButtonElement>('[role="tooltip"] button')?.click());
      expect(copyToast.error).toHaveBeenCalledTimes(2);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

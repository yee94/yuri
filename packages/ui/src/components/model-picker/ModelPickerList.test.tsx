import { describe, expect, test, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const { persistedCollapsedSections, copyText, copyToast, tooltipRoots } = vi.hoisted(() => ({
  persistedCollapsedSections: { 'provider:anthropic': true },
  copyText: vi.fn(async (_text: string): Promise<{ ok: boolean }> => ({ ok: true })),
  copyToast: { success: vi.fn(), error: vi.fn() },
  tooltipRoots: vi.fn(),
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
  Tooltip: ({ children }: { children: React.ReactNode }) => { tooltipRoots(); return <>{children}</>; },
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
  test('bounds desktop row work while preserving all 300 entries and offscreen keyboard selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    const models = Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, limit: { context: 400000 } }));
    const getMetadata = vi.fn();
    const onSelect = vi.fn();
    try {
      await React.act(async () => root.render(<div className="yuri-composer-picker"><ModelPickerList
        virtualize stickyHeaders={false} autoFocus={false} tooltipsEnabled={false}
        providers={[{ id: 'custom', models: models.slice(0, 299) }, { id: 'other', models: [models[299]] }]}
        favoriteModels={models.slice(0, 2).map((model) => ({ providerID: 'custom', modelID: model.id, model }))} recentModels={[]} getMetadata={getMetadata}
        onReorderFavorite={() => {}} onReorderProvider={() => {}}
        searchQuery="" onSearchQueryChange={() => {}} onSelect={onSelect}
        labels={{ searchPlaceholder: 'Search', noResults: 'Empty', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'Navigate' }}
      /></div>));
      const rows = container.querySelectorAll('[role="option"]');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(40);
      expect(getMetadata.mock.calls.length).toBeLessThan(80);
      expect(rows.length + container.querySelectorAll('.model-picker-row-placeholder').length).toBe(302);
      expect(rows[0].getAttribute('aria-setsize')).toBe('302');
      expect(container.querySelectorAll('.model-picker-row[data-model-section="provider"]').length).toBeGreaterThan(0);
      expect(container.querySelector('[data-model-section="provider"] .model-picker-row-provider')).toBeNull();
      const input = container.querySelector('input')!;
      await React.act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
      await React.act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(onSelect).toHaveBeenCalledWith({ providerID: 'other', modelID: 'model-299', model: models[299] });
    } finally {
      await React.act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  test('mounts only the delayed active tooltip without replacing row DOM in a 300-model catalog', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      tooltipRoots.mockClear();
      await React.act(async () => root.render(<ModelPickerList
        providers={[{ id: 'custom', models: Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })) }]}
        favoriteModels={[]} recentModels={[]} searchQuery="" onSearchQueryChange={() => {}} onSelect={() => {}} autoFocus={false}
        labels={{ searchPlaceholder: 'Search', noResults: 'Empty', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'Navigate' }}
      />));
      const row = container.querySelector('[role="option"]');
      expect(container.querySelectorAll('[role="option"]')).toHaveLength(300);
      expect(tooltipRoots).not.toHaveBeenCalled();
      await React.act(async () => vi.advanceTimersByTime(450));
      expect(tooltipRoots).toHaveBeenCalledOnce();
      expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
      expect(container.querySelector('[role="option"]')).toBe(row);
      const secondRow = container.querySelectorAll('[role="option"]')[1];
      await React.act(async () => secondRow.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 40 })));
      expect(container.querySelector('[role="tooltip"]')).toBeNull();
      await React.act(async () => vi.advanceTimersByTime(450));
      expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
      expect(container.querySelectorAll('[role="option"]')[1]).toBe(secondRow);
    } finally {
      await React.act(async () => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test('does not construct per-row number formatters across 50 searches in a 300-model catalog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    const providers = [{ id: 'custom', name: 'Custom', models: Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, limit: { context: 400000 + index } })) }];
    const numberFormat = vi.fn();
    vi.stubGlobal('Intl', Object.create(Intl, { NumberFormat: { value: new Proxy(Intl.NumberFormat, {
      construct(target, args) { numberFormat(); return Reflect.construct(target, args); },
    }) } }));
    const render = (searchQuery: string) => root.render(<ModelPickerList
      providers={providers} favoriteModels={[]} recentModels={[]}
      searchQuery={searchQuery} onSearchQueryChange={() => {}} onSelect={() => {}}
      tooltipsEnabled={false} autoFocus={false}
      labels={{ searchPlaceholder: 'Search', noResults: 'Empty', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'Navigate' }}
    />);
    try {
      await React.act(async () => render('m'));
      expect(container.querySelectorAll('[role="option"]')).toHaveLength(300);
      numberFormat.mockClear();
      for (let index = 0; index < 50; index++) await React.act(async () => render(index % 2 ? 'm' : 'mo'));
      expect(numberFormat.mock.calls.length).toBeLessThanOrEqual(1);
      expect(container.querySelectorAll('[role="option"]')).toHaveLength(300);
    } finally {
      await React.act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  test('keeps metadata, thinking and favorite actions independent from keyboard selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    const onThinking = vi.fn();
    const onFavorite = vi.fn();
    const model = { id: 'model-a', name: 'A long model name', limit: { context: 400000 } };
    const entry = { providerID: 'custom', modelID: model.id, model, variant: 'high' };
    try {
      await React.act(async () => root.render(
        <div className="yuri-composer-picker">
          <ModelPickerList
            providers={[{ id: 'custom', name: 'Custom provider', models: [model] }]}
            favoriteModels={[entry]}
            recentModels={[]}
            searchQuery=""
            onSearchQueryChange={() => {}}
            onSelect={onSelect}
            selectedModel={entry}
            stickyHeaders={false}
            isFavorite={() => true}
            onToggleFavorite={onFavorite}
            renderRowEnd={() => <button onClick={(event) => { event.stopPropagation(); onThinking(); }}>High</button>}
            labels={{ searchPlaceholder: 'Search', noResults: 'Empty', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'Navigate', unfavorite: 'Unfavorite' }}
          />
        </div>,
      ));
      const row = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(row.querySelector('.model-picker-row-name')?.textContent).toBe(model.name);
      expect(row.querySelector('.model-picker-row-provider')?.textContent).toBe('Custom provider');
      expect(row.querySelector('.model-picker-row-context')?.textContent).not.toBe('');
      expect(row.getAttribute('aria-selected')).toBe('true');
      expect(row.querySelector('.model-picker-row-selection svg')).not.toBeNull();
      expect(container.querySelector('.model-picker-section-header.sticky')).toBeNull();
      await React.act(async () => row.querySelector<HTMLButtonElement>('button')!.click());
      await React.act(async () => row.querySelector<HTMLButtonElement>('.model-favorite-button')!.click());
      expect(onThinking).toHaveBeenCalledOnce();
      expect(onFavorite).toHaveBeenCalledWith(entry);
      expect(onSelect).not.toHaveBeenCalled();
      await React.act(async () => container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(onSelect).toHaveBeenCalledWith(entry);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

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

import { describe, expect, test, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { persistedCollapsedSections } = vi.hoisted(() => ({
  persistedCollapsedSections: { 'provider:anthropic': true },
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

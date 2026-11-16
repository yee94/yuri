import { beforeEach, describe, expect, test } from 'vitest';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({
    favoriteModels: [],
    recentModels: [],
    providerOrder: [],
  });
});

describe('useUIStore provider order', () => {
  test('addRecentModel promotes the used provider to the front of the persisted order', () => {
    useUIStore.setState({ providerOrder: ['openai', 'anthropic', 'google'] });

    useUIStore.getState().addRecentModel('google', 'gemini-pro');
    expect(useUIStore.getState().providerOrder).toEqual(['google', 'openai', 'anthropic']);

    useUIStore.getState().addRecentModel('cursor', 'claude');
    expect(useUIStore.getState().providerOrder).toEqual(['cursor', 'google', 'openai', 'anthropic']);
  });
});

describe('useUIStore recent/favorite model variant prefs', () => {
  test('addRecentModel records variant, dedupes by identity, and keeps newest first', () => {
    useUIStore.getState().addRecentModel('openai', 'gpt-4.1', 'high');
    useUIStore.getState().addRecentModel('anthropic', 'claude-opus-4', 'medium');
    useUIStore.getState().addRecentModel('openai', 'gpt-4.1', 'low');

    expect(useUIStore.getState().recentModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4.1', variant: 'low' },
      { providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'medium' },
    ]);
  });

  test('addRecentModel omits unset variant for a clean persist shape', () => {
    useUIStore.getState().addRecentModel('openai', 'gpt-4.1');

    expect(useUIStore.getState().recentModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4.1' },
    ]);
    expect('variant' in useUIStore.getState().recentModels[0]).toBe(false);
  });

  test('addRecentModel updates a matching favorite variant without reordering favorites', () => {
    useUIStore.setState({
      favoriteModels: [
        { providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'high' },
        { providerID: 'openai', modelID: 'gpt-4.1', variant: 'medium' },
      ],
    });

    useUIStore.getState().addRecentModel('openai', 'gpt-4.1', 'low');

    expect(useUIStore.getState().favoriteModels).toEqual([
      { providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'high' },
      { providerID: 'openai', modelID: 'gpt-4.1', variant: 'low' },
    ]);
    expect(useUIStore.getState().recentModels[0]).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4.1',
      variant: 'low',
    });
  });

  test('addRecentModel clears a favorite variant when the latest selection has none', () => {
    useUIStore.setState({
      favoriteModels: [{ providerID: 'openai', modelID: 'gpt-4.1', variant: 'high' }],
    });

    useUIStore.getState().addRecentModel('openai', 'gpt-4.1');

    expect(useUIStore.getState().favoriteModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4.1' },
    ]);
    expect('variant' in useUIStore.getState().favoriteModels[0]).toBe(false);
  });

  test('legacy entries without variant remain compatible', () => {
    useUIStore.setState({
      favoriteModels: [{ providerID: 'openai', modelID: 'gpt-4.1' }],
      recentModels: [{ providerID: 'anthropic', modelID: 'claude-opus-4' }],
    });

    expect(useUIStore.getState().isFavoriteModel('openai', 'gpt-4.1')).toBe(true);
    useUIStore.getState().addRecentModel('anthropic', 'claude-opus-4', 'high');

    expect(useUIStore.getState().recentModels).toEqual([
      { providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'high' },
    ]);
    expect(useUIStore.getState().favoriteModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4.1' },
    ]);
  });

  test('toggleFavoriteModel records the current variant when favoriting', () => {
    useUIStore.getState().toggleFavoriteModel('openai', 'gpt-4.1', 'high');

    expect(useUIStore.getState().favoriteModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4.1', variant: 'high' },
    ]);
  });
});

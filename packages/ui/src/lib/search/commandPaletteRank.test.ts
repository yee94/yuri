import { describe, expect, test, vi } from 'vitest';
import fuzzysort from 'fuzzysort';
import { rankCommandPaletteResults } from './commandPaletteRank';

describe('global search mixed relevance', () => {
  test('ranks individual rows across types with the mention title tiers', () => {
    const results = [
      { id: 'body', title: 'Other conversation', detail: 'login' },
      { id: 'session', title: 'Fix login' },
      { id: 'command', title: 'login-helper' },
      { id: 'file', title: 'login' },
    ];
    expect(rankCommandPaletteResults(results, 'LOGIN').map(({ id }) => id))
      .toEqual(['file', 'command', 'session', 'body']);
  });

  test('retains source recency for tied titles and never drops authoritative matches', () => {
    const results = [{ title: 'login', id: 'new' }, { title: 'login', id: 'old' }, { title: 'Unrelated', id: 'indexed-hit' }];
    expect(rankCommandPaletteResults(results, 'login')).toEqual(results);
    expect(rankCommandPaletteResults(results, '')).toEqual(results);
  });

  test('fuzzy titles outrank detail-only matches', () => {
    expect(rankCommandPaletteResults([
      { title: 'Other', detail: 'CommandPalette' }, { title: 'CommandPalette.tsx' },
    ], 'CP').map(({ title }) => title)).toEqual(['CommandPalette.tsx', 'Other']);
  });

  test('scores each bounded candidate once per field, never in the sort comparator', () => {
    const single = vi.spyOn(fuzzysort, 'single');
    try {
      const results = Array.from({ length: 1000 }, (_, index) => ({ title: `login-${index}`, detail: 'body', id: index }));
      expect(rankCommandPaletteResults(results, 'login')).toHaveLength(1000);
      expect(single).toHaveBeenCalledTimes(2000);
    } finally {
      single.mockRestore();
    }
  });
});

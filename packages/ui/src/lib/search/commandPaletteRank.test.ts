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

  test('orders rows of the same title tier by recency regardless of snippet fuzziness', () => {
    const results = [
      { id: 'old-strong', title: 'Run', detail: 'apple', time: 1 },
      { id: 'new-weak', title: 'Run', detail: 'a long unrelated lead-in before the word apple appears somewhere', time: 3 },
      { id: 'mid', title: 'Run', detail: 'some apple text', time: 2 },
    ];
    expect(rankCommandPaletteResults(results, 'apple').map(({ id }) => id)).toEqual(['new-weak', 'mid', 'old-strong']);
  });

  test('recency never lifts a row above a better title tier', () => {
    const results = [
      { id: 'stale-title', title: 'apple', time: 1 },
      { id: 'fresh-body', title: 'Other', detail: 'apple', time: 9 },
    ];
    expect(rankCommandPaletteResults(results, 'apple').map(({ id }) => id)).toEqual(['stale-title', 'fresh-body']);
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

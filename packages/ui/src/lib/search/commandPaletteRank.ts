import fuzzysort from 'fuzzysort';
import { scoreMentionTitle } from '@/lib/composer-autocomplete/mention-rank';

/** Rank already-recalled results without discarding authoritative content/path hits. */
export function rankCommandPaletteResults<T extends { title: string; detail?: string }>(
  results: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...results];
  return results.map((item, index) => ({
    item,
    index,
    score: Math.max(
      scoreMentionTitle(trimmed, item.title, fuzzysort.single(trimmed, item.title)?.score ?? 0),
      fuzzysort.single(trimmed, item.detail ?? '')?.score ?? 0,
    ),
  })).sort((a, b) => b.score - a.score || a.index - b.index).map(({ item }) => item);
}

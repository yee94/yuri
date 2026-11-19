import fuzzysort from 'fuzzysort';
import { scoreMentionTitle } from '@/lib/composer-autocomplete/mention-rank';

/** Fuzzy snippet scores are noisy for guaranteed content hits, so recency outweighs them inside a tier. */
const RELEVANCE_WEIGHT = 0.25;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Rank already-recalled results without discarding authoritative content/path hits.
 * Title tiers stay authoritative; within a tier, rows carrying a `time` are ordered
 * by recency (newest first, relative to the other timed rows) blended with relevance.
 */
export function rankCommandPaletteResults<T extends { title: string; detail?: string; time?: number }>(
  results: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...results];
  const times = results.flatMap((item) => (isTime(item.time) ? [item.time] : [])).sort((a, b) => a - b);
  const recency = (time: number | undefined) => {
    if (!isTime(time) || times.length < 2) return 0;
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (times[middle] < time) low = middle + 1;
      else high = middle;
    }
    return low / (times.length - 1);
  };
  return results.map((item, index) => {
    const titleScore = scoreMentionTitle(trimmed, item.title, fuzzysort.single(trimmed, item.title)?.score ?? 0);
    const detailScore = fuzzysort.single(trimmed, item.detail ?? '')?.score ?? 0;
    const tier = Math.floor(titleScore);
    const relevance = tier > 0 ? titleScore - tier : detailScore;
    return { item, index, tier, score: relevance * RELEVANCE_WEIGHT + recency(item.time) };
  }).sort((a, b) => b.tier - a.tier || b.score - a.score || a.index - b.index).map(({ item }) => item);
}

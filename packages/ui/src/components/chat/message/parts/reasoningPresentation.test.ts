import { expect, it } from 'vitest';
import { cleanReasoningText, getReasoningSummary, initialReasoningExpansion, reconcileReasoningExpansion } from './reasoningPresentation';

it('shares the exact quote cleanup and bounded plain Markdown summary', () => {
  const cleaned = cleanReasoningText('> # **Plan**\n> Read `example.ts`\n\n> [Source](https://example.test) <!-- -->');
  expect(cleaned).toBe('# **Plan**\nRead `example.ts`\n[Source](https://example.test) <!-- -->');
  expect(getReasoningSummary(cleaned)).toBe('Plan Read example.ts Source');
  expect(getReasoningSummary('word '.repeat(40)).length).toBeLessThanOrEqual(81);
  expect(getReasoningSummary('word '.repeat(40))).toMatch(/word…$/);
});
it('cold sorted reasoning is collapsed, live opens automatically, and neither settle nor later streaming revokes user choice', () => {
  const cold = initialReasoningExpansion(undefined, false);
  expect(cold.expanded).toBe(false);
  const live = reconcileReasoningExpansion(cold, true);
  expect(live).toEqual({ expanded: true, source: 'auto' });
  expect(reconcileReasoningExpansion(live, false)).toBe(live);
  const explicit = { expanded: false, source: 'user' as const };
  expect(reconcileReasoningExpansion(explicit, true)).toBe(explicit);
  expect(initialReasoningExpansion(true, false)).toEqual({ expanded: true, source: 'user' });
});

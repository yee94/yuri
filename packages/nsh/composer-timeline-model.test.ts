import { expect, test } from 'vitest';
import { nativeTimelineRows } from './composer-timeline-model';
import { messageFrom } from './model';

test('timeline preserves actual conversation order, user-only rows and every text part in full-text search', () => {
  const messages = [messageFrom({ id: 'z', type: 'user', content: [{ type: 'text', text: 'first' }, { type: 'file', text: 'not text' }, { type: 'text', text: 'needle at the end' }] })!,
    messageFrom({ id: 'a', type: 'assistant', text: 'needle assistant' })!, messageFrom({ id: 'b', type: 'user', text: 'last', time: { created: 5 } })!];
  expect(nativeTimelineRows(messages, '').map(row => row.id)).toEqual(['z', 'b']);
  const rows = nativeTimelineRows(messages, 'NEEDLE'); expect(rows).toHaveLength(1); expect(rows[0].fullText).toBe('first\nneedle at the end');
  expect(rows[0].snippet).toBe('first needle at the end'); expect(rows[0].index).toBe(0);
});

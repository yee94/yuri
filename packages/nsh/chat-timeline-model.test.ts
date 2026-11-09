import { expect, it } from 'vitest';
import { nativeTimelineDate, nativeTimelineEntries, nativeTimelineTime } from './chat-timeline-model';
import type { Message } from './model';

const message = (id: string, role: string, text: string, created: number): Message => ({ id, role, text, time: { created }, reasoning: '', tools: [], cards: [], files: [], error: '' });
it('uses authoritative user order/source/time and all text parts with no history or body truncation', () => {
  const long = '全文'.repeat(6000), first = message('z-first', 'user', 'ignored fallback', 3000);
  first.content = [{ type: 'text', text: long }, { type: 'text', text: 'needle at the end' }];
  const last = message('a-last', 'user', 'last', 1000);
  const source = [first, message('assistant', 'assistant', 'needle', 2000), last];
  expect(nativeTimelineEntries(source, '').map(entry => [entry.id, entry.created])).toEqual([['z-first', 3000], ['a-last', 1000]]);
  expect(nativeTimelineEntries(source, '  NEEDLE at the END  ')).toMatchObject([{ id: first.id, message: first, text: long + '\nneedle at the end' }]);
  const many = Array.from({ length: 240 }, (_, index) => message(String(index), 'user', String(index), index));
  expect(nativeTimelineEntries(many, '')).toHaveLength(240);
  expect(nativeTimelineEntries(source, 'missing')).toEqual([]);
});
it('formats authoritative timestamps with Web timeline Intl options in every supported locale', () => {
  const timestamp = Date.UTC(2026, 10, 8, 14, 7);
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) {
    expect(nativeTimelineDate(timestamp, locale)).toBe(new Date(timestamp).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }));
    expect(nativeTimelineTime(timestamp, locale)).toBe(new Date(timestamp).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }));
  }
});

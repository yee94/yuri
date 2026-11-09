import { describe, expect, it } from 'vitest';
import { createContactTimeFormatter, getContactTimeSeparators } from '../ui/src/components/assistants/contactMessageTime';
import { parseAssistantContactPage, type AssistantContactMessage } from '../ui/src/queries/assistantDTO';
import { desktopContactMessageRows } from './desktop-assistant-message-model';
import { contactMessageFrom, messageFrom, type Row } from './model';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const options = { locale: 'zh-CN', todayLabel: '今天', now: new Date(2026, 10, 8, 16) };
const wire = (messageID: string, role: AssistantContactMessage['role'], turnID: string, createdAt: number, extra: Row = {}) => ({
  messageID, assistantID: 'bot', role, turnID, createdAt, bubbleIndex: 0, ordinal: 0, status: 'complete',
  fromAssistantID: null, fromAssistantName: null, parts: [{ type: 'text', text: messageID }], ...extra,
});
const message = (raw: Row) => contactMessageFrom(raw)!;

describe('desktop contact row presentation', () => {
  it('gives self right bubbles, peer left bubbles and only the first bubble in an assistant run an avatar', () => {
    const messages = [
      wire('self', 'user', 'one', at(8, 10)), wire('first', 'assistant', 'one', at(8, 10, 1)), wire('continuation', 'assistant', 'one', at(8, 10, 2)),
      wire('next-turn', 'assistant', 'two', at(8, 10, 3)), wire('peer', 'peer', 'dm', at(8, 10, 4), { fromAssistantID: 'other', fromAssistantName: 'Other' }),
      wire('after-peer', 'assistant', 'dm', at(8, 10, 5)), wire('gap', 'assistant', 'dm', at(8, 10, 11)),
    ].map(message);
    const rows = desktopContactMessageRows(messages, options);
    expect(rows.map(row => row.message)).toEqual(messages);
    expect(rows.map(row => row.alignment)).toEqual(['right', 'left', 'left', 'left', 'left', 'left', 'left']);
    expect(rows.map(row => row.showAvatar)).toEqual([false, true, false, true, true, true, true]);
    expect(rows.map(row => row.sameAssistantRun)).toEqual([false, false, true, false, false, false, false]);
    expect(rows[4]?.message.contact).toMatchObject({ kind: 'peer', fromAssistantID: 'other' });
    expect(rows[3]?.startsTurn).toBe(true); expect(rows[2]?.startsTurn).toBe(false);
  });
  it('uses exactly Web separators and locale/local-time formatter, including midnight and year boundaries', () => {
    const raw = [wire('old-year', 'user', 'a', new Date(2025, 11, 31, 23, 59).getTime()),
      wire('yesterday', 'assistant', 'b', at(7, 23, 59)), wire('midnight', 'assistant', 'b', at(8, 0, 0)),
      wire('near', 'assistant', 'b', at(8, 0, 5)), wire('gap', 'assistant', 'b', at(8, 0, 11))];
    const dto = parseAssistantContactPage({ messages: raw, complete: true, nextCursor: null, generation: 4, revision: 17 });
    const expected = getContactTimeSeparators(dto.messages);
    for (const locale of ['zh-CN', 'en-US', 'de-DE']) {
      const format = createContactTimeFormatter(locale, options.todayLabel, options.now);
      const rows = desktopContactMessageRows(raw.map(message), { ...options, locale });
      expect(rows.flatMap(row => row.separatorTimestamp === undefined ? [] : [[row.message.id, row.separatorTimestamp]])).toEqual([...expected]);
      for (const row of rows) expect(row.separatorLabel).toBe(row.separatorTimestamp === undefined ? undefined : format(row.separatorTimestamp));
    }
  });
  it('recomputes the first separator from the actually loaded sequence when an earlier page arrives', () => {
    const current = message(wire('current', 'assistant', 't', at(8, 10, 1)));
    expect(desktopContactMessageRows([current], options)[0]?.separatorTimestamp).toBe(at(8, 10, 1));
    const previous = message(wire('previous', 'assistant', 't', at(8, 10)));
    const rows = desktopContactMessageRows([previous, current], options);
    expect(rows[0]?.separatorTimestamp).toBe(at(8, 10)); expect(rows[1]?.separatorTimestamp).toBeUndefined(); expect(rows[1]?.showAvatar).toBe(false);
  });
  it('skips internal-only/admitted rows and superseded errors, but preserves trailing real errors and original bodies', () => {
    const messages = [message(wire('first', 'assistant', 'a', at(8, 10))),
      message(wire('hidden', 'assistant', 'a', at(8, 10, 1), { parts: [{ type: 'text', text: 'oc.settle.internal' }] })),
      message(wire('old-error', 'assistant', 'a', at(8, 10, 2), { status: 'error', text: 'Old error' })),
      message(wire('next', 'assistant', 'a', at(8, 10, 3))),
      message(wire('preview:preview:admitted', 'user', 'b', at(8, 10, 4), { status: 'admitted' })),
      message(wire('last-error', 'assistant', 'a', at(8, 10, 4), { status: 'error', text: 'Real error' }))];
    const rows = desktopContactMessageRows(messages, options);
    expect(rows.map(row => row.visible)).toEqual([true, false, false, true, false, true]);
    expect(rows[3]?.sameAssistantRun).toBe(true); expect(rows[5]).toMatchObject({ errorRow: true, showAvatar: false });
    rows.forEach((row, index) => expect(row.message).toBe(messages[index]));
  });
  it('keeps ordinary Session rows outside contact presentation and handles top-level content without a fake clock', () => {
    const session = messageFrom({ id: 'session', type: 'assistant', text: 'Session answer', time: { created: at(8, 10) } })!;
    expect(desktopContactMessageRows([session], options)).toEqual([]);
    const top = message({ messageID: 'top', role: 'peer', text: 'top text', fromAssistantID: 'sender' });
    const rows = desktopContactMessageRows([session, top], options);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: 'peer', visible: true, showAvatar: true });
    expect(rows[0]?.separatorTimestamp).toBeUndefined();
    const unscoped = desktopContactMessageRows([message({ messageID: 'first', role: 'assistant', text: 'a' }), message({ messageID: 'second', role: 'assistant', text: 'b' })], options);
    expect(unscoped.map(row => row.showAvatar)).toEqual([true, true]);
    expect(desktopContactMessageRows([message({ messageID: 'malformed-text', role: 'assistant', createdAt: 1, parts: [{ type: 'text', text: 42 }] })], options)[0]?.separatorTimestamp).toBeUndefined();
  });
});

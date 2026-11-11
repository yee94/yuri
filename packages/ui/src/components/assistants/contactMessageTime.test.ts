import { describe, expect, test } from 'vitest'
import type { AssistantContactMessage } from '@/queries/assistantDTO'
import { createContactDateFormatter, createContactTimeFormatter, getContactTimeSeparators } from './contactMessageTime'

const at = (day: number, hour: number, minute: number, year = 2026) => new Date(year, 9, day, hour, minute).getTime()
const message = (messageID: string, createdAt: number, patch: Partial<AssistantContactMessage> = {}): AssistantContactMessage => ({
  messageID, createdAt, assistantID: 'assistant', turnID: 'turn', role: 'assistant',
  bubbleIndex: 0, ordinal: 0, status: 'complete', fromAssistantID: null, fromAssistantName: null,
  parts: [{ type: 'text', text: 'hello' }], text: 'hello', cards: [], ...patch,
})

describe('contact time separators', () => {
  test('groups all messages on the same local day regardless of gaps and splits at midnight', () => {
    const messages = [
      message('first', at(17, 23, 50)),
      message('five-minutes', at(17, 23, 55)),
      message('midnight', at(18, 0, 0)),
      message('gap', at(18, 0, 6)),
      message('reply', at(18, 0, 7)),
      message('evening', at(18, 23, 59)),
    ]
    expect([...getContactTimeSeparators(messages).keys()]).toEqual(['first', 'midnight'])
  })

  test('hidden settle markers and processing previews do not consume a day boundary', () => {
    expect([...getContactTimeSeparators([
      message('first', at(17, 10, 0)),
      message('hidden', at(18, 10, 8), { parts: [{ type: 'text', text: 'yuri.settle.complete' }] }),
      message('processing', at(18, 10, 9), { status: 'admitted', parts: [] }),
      message('reply', at(18, 10, 10)),
    ]).keys()]).toEqual(['first', 'reply'])
  })

  test('cards, files and errors participate; invalid timestamps never produce a separator', () => {
    expect([...getContactTimeSeparators([
      message('invalid', NaN),
      message('file', at(18, 10, 0), { parts: [{ type: 'file', url: 'https://example.com/image.png', mime: 'image/png' }] }),
      message('card', at(19, 10, 10), { parts: [{ type: 'card', cardType: 'schedule', taskID: 'task', projectID: 'project', name: 'Reminder', kind: 'daily', time: '10:00', timezone: null, prompt: '' }] }),
      message('error', at(20, 10, 20), { status: 'error', parts: [] }),
    ]).keys()]).toEqual(['file', 'card', 'error'])
  })

  test('prepending history recalculates the old first row without duplicate boundaries', () => {
    const latest = [message('latest', at(18, 10, 3)), message('reply', at(18, 10, 4))]
    expect([...getContactTimeSeparators(latest).keys()]).toEqual(['latest'])
    expect([...getContactTimeSeparators([message('older', at(18, 10, 0)), ...latest]).keys()]).toEqual(['older'])
  })

  test('uses local dates, localized labels, 24-hour time, and a year only across years', () => {
    const format = createContactTimeFormatter('zh-CN', '今天', new Date(at(21, 12, 0)))
    expect(format(at(21, 10, 59))).toBe('今天 10:59')
    expect(format(at(17, 21, 22))).toBe('10月17日 21:22')
    expect(format(at(17, 21, 22, 2025))).toBe('2025年10月17日 21:22')
    const english = createContactTimeFormatter('en', 'Today', new Date(at(21, 12, 0)))
    expect(english(at(21, 0, 5))).toBe('Today 00:05')
    expect(english(at(17, 21, 22))).toBe('October 17 21:22')
  })

  test('day separators show today, yesterday or a localized date without a time', () => {
    const format = createContactDateFormatter('zh-CN', '今天', '昨天', new Date(at(21, 12, 0)))
    expect(format(at(21, 10, 59))).toBe('今天')
    expect(format(at(20, 23, 59))).toBe('昨天')
    expect(format(at(17, 21, 22))).toBe('10月17日')
    expect(format(at(17, 21, 22, 2025))).toBe('2025年10月17日')
    const english = createContactDateFormatter('en', 'Today', 'Yesterday', new Date(at(21, 12, 0)))
    expect(english(at(21, 0, 5))).toBe('Today')
    expect(english(at(20, 23, 59))).toBe('Yesterday')
    expect(english(at(17, 21, 22))).toBe('October 17')
  })

  test('yesterday follows the local calendar across month and year boundaries', () => {
    const format = createContactDateFormatter('zh-CN', '今天', '昨天', new Date(2026, 0, 1, 0, 1))
    expect(format(new Date(2025, 11, 31, 23, 59).getTime())).toBe('昨天')
    expect(format(new Date(2025, 11, 30, 12).getTime())).toBe('2025年12月30日')
  })
})

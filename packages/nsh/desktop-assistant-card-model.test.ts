import { describe, expect, test } from 'vitest';
import { desktopAssistantCardNavigable, desktopAssistantCardProvider, desktopAssistantCardStatus, desktopAssistantCardStatusKey, desktopAssistantScheduleCard, desktopAssistantSessionCard } from './desktop-assistant-card-model';

const translate = (key: string) => key;
describe('contact receipt pure projection (actual Web helpers)', () => {
  test('complete status mapping, persisted cancellation and errors survive stale live idle', () => {
    for (const status of ['cancelled', 'busy', 'retry', 'idle', 'complete', 'error', 'question']) expect(desktopAssistantCardStatusKey(status)).toBe(`assistants.contact.card.session.status.${status}`);
    expect(desktopAssistantCardStatus('busy', 'cancelled')).toBe('cancelled');
    expect(desktopAssistantCardStatus('retry', 'error')).toBe('retry');
    for (const status of ['error', 'question', 'complete', 'busy', 'retry']) expect(desktopAssistantCardStatus('idle', status)).toBe(status);
    expect(desktopAssistantCardStatus('idle', null)).toBe('complete');
    expect(desktopAssistantCardStatus(undefined, 'idle')).toBe('idle');
    expect(desktopAssistantCardStatus(undefined, undefined)).toBeNull();
    expect(desktopAssistantCardStatusKey('future')).toBeNull();
  });
  test('live title and actual directory win, branch only from owner, Web summary/model formats retained', () => {
    const card = Object.freeze({ title: 'Receipt title', directory: '/old/folder', branch: 'stale', status: 'complete' });
    const session = Object.freeze({ title: ' Live title ', directory: ' C:\\Work\\Actual ', model: { provider: 'openai', id: 'gpt-5' }, summary: { additions: 12.9, deletions: 3, diffCount: 2 } });
    expect(desktopAssistantSessionCard(card, session, null, ' main ')).toMatchObject({ title: 'Live title', directory: 'C:\\Work\\Actual', project: 'Actual', branch: 'main', model: 'openai/gpt-5', changes: { additions: 12, deletions: 3, files: 2 } });
    expect(desktopAssistantSessionCard(card).branch).toBeNull();
    expect(desktopAssistantSessionCard({ directory: '/source', title: 'Fallback' }, { title: ' ', directory: ' ' }).title).toBe('Fallback');
    expect(desktopAssistantSessionCard(card, session, { type: 'busy' }).changes).toBeNull();
    expect(desktopAssistantSessionCard(card, { summary: { additions: 0, deletions: -1, files: NaN } }).changes).toBeNull();
    expect(desktopAssistantSessionCard({}).model).toBeNull();
    expect(desktopAssistantSessionCard({}).status).toBeNull();
  });
  test('daily/weekly/cron/once and missing clocks use shared pure schedule presentation', () => {
    expect(desktopAssistantScheduleCard({ kind: 'daily', times: ['18:30', '09:00', '09:00'] }, null, translate)).toMatchObject({ value: '09:00, 18:30', clock: false });
    expect(desktopAssistantScheduleCard({ kind: 'weekly', times: ['09:00'], weekdays: [5, 1, 1] }, null, translate)).toMatchObject({ clock: true, cadence: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.mon, sessions.scheduledTasks.dialog.schedule.weekdayShort.fri' });
    expect(desktopAssistantScheduleCard({ kind: 'cron', cron: ' 0 9 * * 1 ' }, null, translate)).toMatchObject({ value: '0 9 * * 1', clock: false });
    expect(desktopAssistantScheduleCard({ kind: 'once', date: '2026-11-09', time: '09:00' }, null, translate)).toMatchObject({ value: '2026-11-09 09:00', clock: false });
    expect(desktopAssistantScheduleCard({}, null, translate).value).toBe('assistants.contact.card.schedule.timeUnavailable');
  });
  test('only legacy missing fields resolve from injected task; complete snapshots and raw parts stay untouched', () => {
    const legacy = Object.freeze({ kind: 'daily', time: '08:00' });
    const task = Object.freeze({ schedule: { kind: 'weekly', times: ['15:30'], weekdays: [2], timezone: 'UTC' } });
    expect(desktopAssistantScheduleCard(legacy, task, translate)).toMatchObject({ value: '15:30', timezone: 'UTC' });
    expect(desktopAssistantScheduleCard({ ...legacy, times: null }, task, translate).value).toBe('08:00');
    expect(desktopAssistantScheduleCard(legacy, { schedule: { kind: 'daily', times: ['bad'] } }, translate).value).toBe('08:00');
    expect(legacy).toEqual({ kind: 'daily', time: '08:00' });
  });
  test('no invented navigation or provider brand matching', () => {
    expect(desktopAssistantCardNavigable({ cardType: 'session', sessionID: 's', directory: '' })).toBe(false);
    expect(desktopAssistantCardNavigable({ cardType: 'session', sessionID: 's' }, { directory: '/actual' })).toBe(true);
    expect(desktopAssistantCardNavigable({ cardType: 'assistant', assistantID: 'a' })).toBe(true);
    expect(desktopAssistantCardNavigable({ cardType: 'schedule', taskID: 't' })).toBe(false);
    expect(desktopAssistantCardNavigable({ cardType: 'schedule', taskID: 't', projectID: 'p' })).toBe(true);
    expect(desktopAssistantCardProvider('magpie/anthropic/model')).toBe('magpie');
    expect(desktopAssistantCardProvider('arbitrary human model name')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { messageFrom, messagesFrom, type Message } from './model';
import { nativeTurnPresentation } from './transcript-tools-turn-model';
import { createNativePendingHeaders, nativeTurnHeaderMessage, nativePendingHeader, nativeUserActionsVisible, nativeTurnModelName, nativeTurnErrorPresentation } from './transcript-tools-turn-model';
import { nativeBodyRows, nativeMessageEntry } from './transcript-body-model';
import { createHost } from './tests/transcript-host.js';
const message = (raw: Record<string, unknown>) => messageFrom(raw)!;

describe('authoritative native turn identity and settle metadata', () => {
  it('shows historical metrics from the production transcript fixture wire records', () => {
    const response = createHost().call('runtime.request', { path: '/api/session/ses_1/message?', method: 'GET' });
    const rows = messagesFrom(response.body, false).messages;
    const presentation = nativeTurnPresentation(rows);
    expect(presentation.get(rows.at(-1)!.id)).toMatchObject({ footer: true, tps: '7.5 tok/s', duration: '4.3s' });
    expect([...presentation.values()].filter(row => row.header)).toHaveLength(1);
    expect([...presentation.values()].filter(row => row.footer)).toHaveLength(1);
    const assistant = nativeBodyRows(rows).find(row => row.head.role === 'assistant')!;
    expect(assistant.head.id).toBe('history-answer');
    expect(assistant.tail.id).toBe('history-final-answer');
    expect(assistant.turn).toMatchObject({ completionDisposition: 'normal', hasConfirmedFinalBody: true, durationMs: 4300 });
    expect(nativeTurnPresentation(rows.slice(0, -1)).get('history-answer')).toEqual({ header: true, footer: false, tps: '', duration: '' });
  });
  it('projects persisted model/variant/agent without reading current session selections', () => {
    expect(message({ id: 'a', type: 'assistant', model: { id: 'gpt-6.1-sol', providerID: 'aggregator', variant: 'high', name: 'GPT-6.1 Sol' }, agent: 'build', time: { created: 10, streamed: 20, completed: 30 }, tokens: { output: 2, reasoning: 3 } })).toMatchObject({ modelID: 'gpt-6.1-sol', providerID: 'aggregator', modelName: 'GPT-6.1 Sol', variant: 'high', agent: 'build', time: { created: 10, streamed: 20, completed: 30 }, tokens: { output: 2, reasoning: 3 } });
    const unknown = message({ id: 'unknown', type: 'assistant', metadata: { model: { id: 'not-assistant-authority' }, agent: 'not-assistant-authority' } });
    expect(unknown.modelID).toBeUndefined(); expect(unknown.agent).toBeUndefined();
    expect(message({ id: 'u', type: 'user', metadata: { model: { id: 'old', providerID: 'provider', variant: 'low' }, agent: 'plan' } })).toMatchObject({ modelID: 'old', variant: 'low', agent: 'plan' });
  });
  it('aggregates all assistant provider intervals and only emits settled footer at the last step', () => {
    const rows = [
      message({ id: 'z-user', type: 'user', time: { created: 1000 } }),
      message({ id: 'z-step', type: 'assistant', modelID: 'old', agent: 'build', time: { created: 1100, streamed: 2100, completed: 2200 }, tokens: { output: 10, reasoning: 5 } }),
      message({ id: 'a-step', type: 'assistant', modelID: 'old', agent: 'build', time: { created: 2300, streamed: 4300, completed: 5300 }, tokens: { output: 15 }, finish: 'stop' }),
    ];
    const result = nativeTurnPresentation(rows);
    expect(result.get('z-step')).toEqual({ header: true, footer: false, tps: '', duration: '' });
    expect(result.get('a-step')).toEqual({ header: false, footer: true, tps: '10.0 tok/s', duration: '4.3s' });
  });
  it('does not invent missing throughput clocks, elapsed start, or active footer', () => {
    const row = message({ id: 'a', type: 'assistant', modelID: 'one', tokens: { output: 10 }, time: { created: 10 } });
    expect(nativeTurnPresentation([row]).get('a')).toEqual({ header: true, footer: false, tps: '', duration: '' });
    expect(nativeTurnPresentation([{ ...row, finish: 'stop' }]).get('a')).toEqual({ header: true, footer: false, tps: '', duration: '' });
    expect(nativeTurnPresentation([{ ...row, finish: 'tool-calls' }], true).get('a')?.footer).toBe(false);
  });
  it('keeps one turn header when actual historical model/agent/variant changes mid-turn', () => {
    const first = message({ id: 'one', type: 'assistant', model: { id: 'gpt', variant: 'high' }, agent: 'build' });
    const next: Message = { ...first, id: 'two', variant: 'low' };
    expect(nativeTurnPresentation([first, next]).get('two')?.header).toBe(false);
  });
  it('does not settle a completed tool step, including with a queued user', () => {
    const step = message({ id: 'step', type: 'assistant', time: { completed: 30 } });
    const queued = message({ id: 'queued', type: 'user', text: 'next' });
    expect(nativeTurnPresentation([step]).get('step')?.footer).toBe(false);
    expect(nativeTurnPresentation([step, queued]).get('step')?.footer).toBe(false);
    expect(nativeTurnPresentation([step, queued, message({ id: 'next', type: 'assistant', finish: 'stop' })]).get('step')?.footer).toBe(true);
  });
  it.each([false, true])('keeps stop plus completed ordinary tools unconfirmed even with idle/busy=%s', live => {
    const user = message({ id: 'user', type: 'user', time: { created: 1000 } });
    const step = message({ id: 'step', type: 'assistant', finish: 'stop', time: { created: 1100, streamed: 3100, completed: 5300 }, tokens: { output: 10, reasoning: 5 }, content: [
      { type: 'text', text: 'Intermediate text' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'done' } },
    ] });
    expect(nativeTurnPresentation([user, step], live).get('step')).toEqual({ header: true, footer: false, tps: '', duration: '' });
    expect(nativeBodyRows([user, step]).at(-1)!.turn).toMatchObject({ completionDisposition: 'active', hasConfirmedFinalBody: false });
  });
  it('shows a confirmed final footer despite delayed busy status', () => {
    const final = message({ id: 'final', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Answer' }] });
    expect(nativeTurnPresentation([final], true).get('final')?.footer).toBe(true);
  });
  it('never adds a model header for user shell turns or checkpoint notices', () => {
    const shell = message({ id: 'shell', type: 'shell', command: 'pwd' });
    const assistant = message({ id: 'answer', type: 'assistant', finish: 'stop' });
    const checkpoint = message({ id: 'checkpoint', type: 'compaction', status: 'completed', reason: 'auto' });
    expect(nativeTurnPresentation([shell, assistant, checkpoint]).get('answer')?.header).toBe(false);
    expect(nativeTurnPresentation([shell, assistant, checkpoint]).get('checkpoint')?.header).not.toBe(true);
  });
  it('uses a complete assistant identity, then user identity, never a hybrid provider/model pair', () => {
    const user = message({ id: 'u', type: 'user', metadata: { model: { providerID: 'user-provider', modelID: 'user-model', variant: 'high' }, agent: 'plan' } });
    const assistant = message({ id: 'a', type: 'assistant', model: { id: 'partial-only' } });
    const rows = nativeBodyRows([user, assistant]);
    expect(nativeTurnHeaderMessage(rows[1]!)).toMatchObject({ providerID: 'user-provider', modelID: 'user-model', variant: 'high', agent: 'plan' });
    const complete = message({ id: 'a', type: 'assistant', mode: 'review', agent: 'build', model: { id: 'wire-model', providerID: 'wire-provider', variant: 'low' } });
    const row = nativeBodyRows([user, complete])[1]!;
    expect(nativeTurnHeaderMessage(row)).toMatchObject({ providerID: 'wire-provider', modelID: 'wire-model', agent: 'review', variant: 'low' });
  });
  it('restricts composer and agent fallback to an active header while allowing session selection for history', () => {
    const row = nativeBodyRows([message({ id: 'a', type: 'assistant', finish: 'stop' })])[0]!;
    const fallback = { composer: { providerId: 'composer', modelId: 'current' }, session: { providerId: 'saved', modelId: 'saved-model' }, agent: 'build' };
    expect(nativeTurnHeaderMessage(row, fallback)).toMatchObject({ providerID: 'saved', modelID: 'saved-model' });
    expect(nativeTurnHeaderMessage(row, fallback).agent).toBeUndefined();
    expect(nativeTurnHeaderMessage(row, { ...fallback, active: true })).toMatchObject({ providerID: 'composer', modelID: 'current', agent: 'build' });
    const metadataOnly = message({ id: 'm', type: 'assistant', metadata: { model: { providerID: 'wrong', id: 'wrong' }, agent: 'wrong' } });
    expect(nativeTurnHeaderMessage(nativeBodyRows([metadataOnly])[0]!).modelID).toBeUndefined();
  });
  it('shares pending-header gates, hides compact commands, and preserves native synthetic identity', () => {
    const user = message({ id: 'u', type: 'user', text: 'Question' });
    const row = nativeBodyRows([user])[0]!;
    expect(nativePendingHeader(row, true, false)).toBe(true);
    expect(nativePendingHeader(row, true, true)).toBe(false);
    expect(nativePendingHeader(row, false, false)).toBe(false);
    const compact = nativeBodyRows([message({ id: 'compact', type: 'user', text: '/compact' })])[0]!;
    expect(nativePendingHeader(compact, true, false)).toBe(false);
    expect(nativeUserActionsVisible(compact)).toBe(false);
    const notice = message({ id: 'n', type: 'synthetic', description: 'Continuing after restart' });
    expect(nativeMessageEntry(notice).info).toMatchObject({ nativeType: 'synthetic', role: 'user', description: 'Continuing after restart' });
  });
  it('labels array/dictionary catalogs with the shared formatter instead of trusting stale wire names', () => {
    const row = message({ id: 'a', type: 'assistant', model: { id: 'some-custom-model', providerID: 'p', name: 'Stale wire label' } });
    expect(nativeTurnModelName(row, [{ id: 'p', models: [{ id: 'some-custom-model', name: 'Array label' }] }])).toBe('Array label');
    expect(nativeTurnModelName(row, [{ id: 'p', models: { 'some-custom-model': { name: 'Dictionary label' } } }])).toBe('Dictionary label');
    expect(nativeTurnModelName(row, [])).toBe('Some Custom Model');
  });
  it('retains a shown pending header across busy/idle gaps but releases it when the assistant arrives or the turn leaves', () => {
    const project = createNativePendingHeaders();
    const user = message({ id: 'u', type: 'user', text: 'Question' });
    const rows = nativeBodyRows([user]);
    expect([...project(rows, false, false)]).toEqual([]);
    expect([...project(rows, true, false)]).toEqual(['u']);
    expect([...project(rows, false, true)]).toEqual(['u']);
    expect([...project(nativeBodyRows([user, message({ id: 'a', type: 'assistant' })]), true, false)]).toEqual([]);
    expect([...project(rows, false, false)]).toEqual([]);
    project(rows, true, false); project([], false, false);
    expect([...project(rows, false, false)]).toEqual([]);
  });
  it('failures own their feedback while stopped turns may keep completion chrome', () => {
    const fatal = message({ id: 'failed', type: 'assistant', error: { type: 'provider.auth', message: 'Authentication failed' }, time: { completed: 20 } });
    const stopped = message({ id: 'stopped', type: 'assistant', error: { type: 'aborted', message: 'Session interrupted by user' }, time: { completed: 20 } });
    expect(nativeTurnPresentation([fatal]).get('failed')?.footer).toBe(false);
    expect(nativeTurnPresentation([stopped]).get('stopped')?.footer).toBe(true);
  });
  it('suppresses a recovered attempt even across a visible notice and retains diagnostics for the final failure', () => {
    const failed = message({ id: 'failed', type: 'assistant', error: { type: 'provider.auth', message: 'Provider diagnostic', status: 401 } });
    const notice = message({ id: 'notice', type: 'synthetic', description: 'Continuing after restart' });
    const final = message({ id: 'final', type: 'assistant', content: [{ type: 'text', text: 'Recovered' }], finish: 'stop' });
    const rows = nativeBodyRows([failed, notice, final]);
    expect(nativeTurnErrorPresentation(rows[0]!, key => key)).toBeUndefined();
    expect(nativeTurnErrorPresentation(nativeBodyRows([failed])[0]!, key => key)).toMatchObject({ text: 'chat.response.auth', rawMessage: 'Provider diagnostic', detail: 'provider.auth · 401', variant: 'error' });
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeSessionProjectionMessage } from '../../../../sync/session-projection-api';
import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import { projectTurnRecords } from './projectTurnRecords';
import type { TurnRecord } from './types';
import { messageFrom, type Row } from '../../../../../../nsh/model';
import { nativeBodyPlan, nativeBodyRows, nativeRowTurns } from '../../../../../../nsh/transcript-body-model';

const text = (value: string): Row => ({ type: 'text', text: value });
const tool = (id: string): Row => ({ type: 'tool', id, name: 'read', state: { status: 'completed', input: { filePath: 'example.ts' } } });
const user = (id = 'u'): Row => ({ type: 'user', id, text: 'Question', time: { created: 100 } });
const step = (id: string, content: Row[], finish?: string): Row => ({ type: 'assistant', id, content, finish, time: { created: 200, streamed: 300, completed: 400 } });
const signature = (turn: TurnRecord) => ({
  user: turn.userMessageId, assistants: turn.assistantMessageIds, disposition: turn.completionDisposition,
  final: turn.hasConfirmedFinalBody, duration: turn.durationMs, summary: turn.summaryText,
  segments: turn.activitySegments.map(segment => segment.parts.map(part => [part.messageId, part.kind, part.part.type])),
});

describe('Native consumes the Web turn/activity projection rather than a parallel grouping algorithm', () => {
  const cases: [string, Row[]][] = [
    ['model changes and recovered errors', [user(), step('a', [text('Before'), tool('call')], 'tool-calls'), { ...step('retry', [], 'error'), error: { type: 'provider.transport', message: 'Temporary' } }, { ...step('final', [text('Answer')], 'stop'), model: { id: 'different', providerID: 'other', variant: 'high' } }]],
    ['hidden synthetic instruction', [user(), step('a', [tool('first')], 'tool-calls'), { type: 'synthetic', id: 'hidden', text: '<system-reminder>Instruction only</system-reminder>' }, step('b', [tool('second'), text('Answer')], 'stop')]],
    ['visible restart notice', [user(), step('a', [tool('first')], 'tool-calls'), { type: 'synthetic', id: 'restart', description: 'Continuing after restart' }, step('b', [tool('second'), text('Answer')], 'stop')]],
    ['automatic checkpoint boundary', [user(), step('a', [text('Before'), tool('first')], 'tool-calls'), { type: 'compaction', id: 'checkpoint', reason: 'auto', status: 'completed' }, step('b', [tool('second'), text('Answer')], 'stop')]],
    ['checkpoint after terminal step keeps the loop open', [user(), step('a', [text('Answer')], 'stop'), { type: 'compaction', id: 'checkpoint', reason: 'auto', status: 'completed' }]],
    ['queue admission is not a completed turn', [user(), step('a', [tool('first')], 'tool-calls'), user('queued')]],
    ['answered later turn settles an abandoned step', [user(), step('a', [tool('first')]), user('next'), step('b', [text('Answer')], 'stop')]],
    ['manual compact summary', [{ ...user(), text: '/compact' }, step('summary', [text('Summary')], 'stop')]],
    ['shell owns no ordinary model header', [{ type: 'shell', id: 'shell', command: 'pwd', status: 'exited', exit: 0, time: { created: 100 } }, step('a', [text('Answer')], 'stop')]],
  ];
  it.each(cases)('%s matches after every received record', (_name, raw) => {
    let nativeRows: ReturnType<typeof nativeBodyRows> = [];
    let web: ReturnType<typeof projectTurnRecords> | undefined;
    for (let length = 1; length <= raw.length; length++) {
      const source = raw.slice(0, length);
      const webMessages = source.map(item => normalizeSessionProjectionMessage('session', item)!).map(getNormalizedMessageForDisplay);
      web = projectTurnRecords(webMessages, { showTextJustificationActivity: true, previousProjection: web });
      nativeRows = nativeBodyRows(source.map(item => messageFrom(item)!), nativeRows);
      expect(nativeRowTurns(nativeRows).map(signature)).toEqual(web.turns.map(signature));
    }
  });
  it('keeps hidden notices transparent but visible notices/checkpoints in source order with separate Activities', () => {
    const raw = cases.find(([name]) => name === 'visible restart notice')![1];
    const rows = nativeBodyRows(raw.map(item => messageFrom(item)!));
    expect(rows.map(row => row.head.id)).toEqual(['u', 'a', 'restart', 'b']);
    expect(rows.filter(row => nativeBodyPlan(row).hasActivity).map(row => row.head.id)).toEqual(['a', 'b']);
    const hidden = nativeBodyRows(cases.find(([name]) => name === 'hidden synthetic instruction')![1].map(item => messageFrom(item)!));
    expect(hidden.map(row => row.head.id)).toEqual(['u', 'a']);
    expect(nativeBodyPlan(hidden[1]!).activity.flatMap(node => node.kind === 'process' ? node.parts : node.kind === 'part' ? [node.part] : []).filter(part => part.source.type === 'tool')).toHaveLength(2);
  });
  it('gives compact summaries one disclosure even with no tools, and live mode keeps the inline path', () => {
    const rows = nativeBodyRows(cases.find(([name]) => name === 'manual compact summary')![1].map(item => messageFrom(item)!));
    expect(nativeBodyPlan(rows[0]!).inline).toHaveLength(0);
    expect(nativeBodyPlan(rows[1]!)).toMatchObject({ hasActivity: true, foldInline: true, defaultExpanded: false, compaction: true });
    expect(nativeBodyPlan(rows[1]!, { mode: 'live' })).toMatchObject({ hasActivity: false, foldInline: false });
  });
});

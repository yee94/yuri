import { describe, expect, test } from 'vitest';
import type { AssistantContactMessage } from '@/queries/assistantDTO';
import { compactReplyExcerpt, findLateReplyOrigin, getQueuedContactTurnIDs } from './contactTurnProvenance';

const msg = (
  messageID: string,
  role: 'user' | 'assistant' | 'peer',
  turnID: string,
  text: string,
  ordinal: number,
  status = 'complete',
): AssistantContactMessage => ({
  messageID,
  assistantID: 'asst_1',
  role,
  turnID,
  bubbleIndex: 0,
  createdAt: ordinal * 1000,
  ordinal,
  status,
  fromAssistantID: null,
  fromAssistantName: null,
  parts: text ? [{ type: 'text', text }] : [],
  text,
  cards: [],
});

describe('contactTurnProvenance', () => {
  test('marks only non-head queued turns as queued', () => {
    expect([...getQueuedContactTurnIDs([], null)]).toEqual([]);
    // Single queued turn at head of idle lane is about to run; do not show queued badge.
    expect([...getQueuedContactTurnIDs(
      [{ turnID: 'turn_1', messageID: 'turn_1', status: 'queued', admittedAt: 1 }],
      { turnID: 'turn_1', messageID: 'turn_1', status: 'queued', admittedAt: 1 },
    )]).toEqual([]);

    const queued = getQueuedContactTurnIDs(
      [
        { turnID: 'turn_c', messageID: 'turn_c', status: 'running', admittedAt: 1 },
        { turnID: 'turn_d', messageID: 'turn_d', status: 'queued', admittedAt: 2 },
        { turnID: 'turn_e', messageID: 'turn_e', status: 'queued', admittedAt: 3 },
      ],
      { turnID: 'turn_c', messageID: 'turn_c', status: 'running', admittedAt: 1 },
    );
    expect([...queued]).toEqual(['turn_d', 'turn_e']);
  });

  test('identifies late assistant replies appearing below newer user turns', () => {
    const transcript: AssistantContactMessage[] = [
      msg('C', 'user', 'C', 'You seem stuck; please continue.', 1),
      msg('D', 'user', 'D', 'Correction: keep architecture in main agent.', 2),
      msg('E', 'user', 'E', 'Any update?', 3),
      msg('C:bubble:1', 'assistant', 'C', 'Reporting earlier step.', 4),
      msg('E:bubble:1', 'assistant', 'E', 'Latest reply.', 5),
    ];

    expect(findLateReplyOrigin(transcript, 3)).toEqual({
      turnID: 'C',
      messageID: 'C',
      excerpt: 'You seem stuck; please continue.',
      hasText: true,
    });
    // Adjacent reply to nearest user turn E needs no provenance header.
    expect(findLateReplyOrigin(transcript, 4)).toBeNull();
  });

  test('skips background notification turns and supports attachment-only origin messages', () => {
    const transcript: AssistantContactMessage[] = [
      msg('attach_turn', 'user', 'attach_turn', '', 1),
      msg('newer', 'user', 'newer', 'Follow up', 2),
      msg('attach_turn:b1', 'assistant', 'attach_turn', 'Checked your file.', 3),
      msg('sched:b1', 'assistant', 'scheduled_asst_1_run_1', 'Daily report', 4),
    ];

    expect(findLateReplyOrigin(transcript, 2)).toEqual({
      turnID: 'attach_turn',
      messageID: 'attach_turn',
      excerpt: '',
      hasText: false,
    });
    expect(findLateReplyOrigin(transcript, 3)).toBeNull();
  });

  test('compacts whitespace and truncates long excerpts', () => {
    expect(compactReplyExcerpt('  hello\n\tworld  ', 20)).toBe('hello world');
    expect(compactReplyExcerpt('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
  });
});

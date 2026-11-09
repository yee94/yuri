import { describe, expect, test, vi } from 'vitest';
import { createDesktopWorkStatusSourceProjection } from './desktop-work-status-source-projection';
import * as generated from './desktop-work-status-helpers.generated';
import { nativeMessageEntry } from './transcript-body-model';
import type { Message, Row } from './model';

const task = (extra: Row = {}): Row => ({ type: 'tool', name: 'task', state: { status: 'pending', input: { description: 'Inspect source', subagent_type: 'explore' }, metadata: { sessionID: 'child' } }, ...extra });
const message = (extra: Partial<Message>): Message => ({ id: 'parent-message', role: 'assistant', text: '', reasoning: '', tools: [], cards: [], files: [], error: '', ...extra });

describe('narrow WorkStatus transcript adaptation', () => {
  test.each([
    message({ content: [{ type: 'text', text: 'before' }, task({ id: 'exact' }), task({ ordinal: 8 }), { type: 'subtask', agent: 'explore', description: 'Subtask', status: 'pending' }] }),
    message({ text: 'legacy body', reasoning: 'legacy thought', tools: [task(), task({ ordinal: 8 })] }),
    message({ content: [], text: 'legacy body', tools: [task()] }),
  ])('faces and exact part IDs match nativeMessageEntry: %j', value => {
    const changed = vi.fn(), tasks = [], source = createDesktopWorkStatusSourceProjection(changed, tasks);
    source.commitTranscript([value], tasks);
    const entry = nativeMessageEntry(value);
    expect(source.snapshot().taskFaces).toEqual(generated.projectTranscriptSubagents({ messageOrder: [value.id], partsByMessageID: { [value.id]: entry.parts } }));
    const prior = source.snapshot(); source.commitTranscript([value], tasks);
    expect(source.snapshot()).toBe(prior); expect(changed).toHaveBeenCalledTimes(1);
    expect(source.snapshot().liveTaskPartIDs.size).toBe(0);
  });
});

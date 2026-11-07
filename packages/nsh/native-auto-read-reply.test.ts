import { expect, test } from 'vitest';
import { messageFrom, type Row } from './model';
import { nativeBodyRows, nativeBodyPlan } from './transcript-body-model';
import { nativeAutoReadBody } from './native-auto-read-reply';

const message = (id: string, content: Row[], extra: Row = {}) => messageFrom({ id, type: 'assistant', content, finish: 'stop', time: { created: 30, completed: 40 }, ...extra })!;
const txt = (text: string): Row => ({ type: 'text', text });
test('final input uses the actual trailing inline model reply, never intermediate narration/tool output/reasoning', () => {
  const row = nativeBodyRows([
    message('step', [txt('Inspecting files.'), { type: 'tool', name: 'bash', state: { status: 'completed', output: 'Secret tool output.' } }], { finish: 'tool-calls' }),
    message('tail', [{ type: 'reasoning', text: 'Private reasoning.' }, txt('Narration.'), txt('Final rendered answer.')]),
  ])[0]!;
  const value = nativeAutoReadBody({ scope: 'host/epoch', sessionID: 's', row, plan: nativeBodyPlan(row), streaming: false, mode: 'final' });
  expect(value).toMatchObject({ completed: true, streaming: false, reply: { messageID: 'tail', created: 30, text: 'Final rendered answer.' } });
});
test('streamed, failed, user, compaction and continuation-only rows never become completed reply admission', () => {
  for (const source of [
    message('stream', [txt('Partial.')], { finish: undefined, time: { created: 30 } }),
    message('error', [txt('Partial.')], { error: { message: 'Private error.' } }),
    message('user', [txt('Question.')], { type: 'user' }),
    message('checkpoint', [{ type: 'compaction', text: 'Not a reply.' }]),
    message('tools', [txt('Inspecting.'), { type: 'tool', name: 'bash', state: { status: 'completed' } }], { finish: 'tool-calls' }),
  ]) {
    const row = nativeBodyRows([source])[0]!;
    const value = nativeAutoReadBody({ scope: 'scope', sessionID: 's', row, plan: nativeBodyPlan(row), streaming: false, mode: 'final' });
    expect(value.completed && !!value.reply.text).toBe(false);
  }
});
test('non-final input keeps ordered model text for the tail, not aggregate tools or prior steps', () => {
  const row = nativeBodyRows([message('tail', [txt('First.'), { type: 'reasoning', text: 'Hidden.' }, txt('Second.')])])[0]!;
  const value = nativeAutoReadBody({ scope: 'scope', sessionID: 's', row, plan: nativeBodyPlan(row), streaming: false, mode: 'sanitized' });
  expect(value.reply.text).toBe('First.\n\nSecond.');
});

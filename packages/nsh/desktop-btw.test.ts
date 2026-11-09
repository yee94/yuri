import { expect, test } from 'vitest';
import { createNativeBtwStore, type NativeBtwRuntime, type NativeBtwSelection } from './desktop-btw';

const scope = { sessionId: 'session-a', directory: '/workspace' };
function fixture() {
  let runtime: NativeBtwRuntime = { transport: 'fixture', generation: 1 };
  let selected: NativeBtwSelection | null = { providerID: 'fixture', modelID: 'first', variant: 'low', agent: 'agent-a' };
  const calls: Array<{ sessionID: string; prompt: string; signal: AbortSignal }> = [], applied: NativeBtwSelection[] = [];
  const replies: Array<(value: { text: string }) => void> = [];
  let apply: (() => Promise<void>) | undefined;
  const store = createNativeBtwStore({ runtime: () => runtime, resolveSelection: () => selected, rememberSelection: () => {},
    applySelection: async (_scope, value) => { applied.push(value); await apply?.(); },
    generate: async (captured, body, request) => {
      expect(captured.sessionID).toBe(body.sessionID); expect(captured.runtime).toEqual(runtime);
      calls.push({ ...body, signal: request.signal }); return new Promise(resolve => replies.push(resolve));
    }, now: () => 1000, elapsed: () => 500 });
  return { store, calls, replies, applied, setRuntime: (next: NativeBtwRuntime) => { runtime = next; }, setSelection: (next: NativeBtwSelection | null) => { selected = next; },
    setApply: (next: () => Promise<void>) => { apply = next; }, flush: async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); } };
}
test('opening/observing/quotes do zero requests; generate receives only sessionID/prompt and a request signal after captured selection', async () => {
  const f = fixture(); let notices = 0; const stop = f.store.observe(scope, () => { notices++; });
  f.store.entry(scope); f.store.addQuote(scope, 'first\nsecond'); expect(f.calls).toEqual([]); expect(f.applied).toEqual([]);
  const flight = f.store.ask(scope, ' question '); expect(f.store.entry(scope).turns[0].pending).toBe(true); expect(f.store.entry(scope).quotes).toEqual([]);
  f.setSelection({ providerID: 'fixture', modelID: 'later' }); await f.flush();
  expect(f.applied[0]).toEqual({ providerID: 'fixture', modelID: 'first', variant: 'low', agent: 'agent-a' });
  expect(f.calls[0].prompt).toContain('Quoted from the conversation:\n\n> first\n> second\n\nquestion');
  f.replies[0]({ text: ' answer ' }); await flight;
  expect(f.store.entry(scope).turns[0]).toMatchObject({ question: 'question', answer: 'answer', quotes: ['first\nsecond'], pending: false, completedAt: 1000, durationMs: 0 });
  expect(notices).toBeGreaterThan(0); stop();
});
test('cancel, supersede, clear and reset use exact controller ownership; late replies never revive turns', async () => {
  const f = fixture(); const first = f.store.ask(scope, 'first'); await f.flush();
  const second = f.store.ask(scope, 'second'); await f.flush(); expect(f.calls[0].signal.aborted).toBe(true);
  f.replies[0]({ text: 'stale first' }); await first; expect(f.store.entry(scope).turns[0].answer).toBe('');
  f.store.cancel(scope); expect(f.store.entry(scope).turns[1].pending).toBe(false);
  f.replies[1]({ text: 'stale second' }); await second; expect(f.store.entry(scope).turns[1].answer).toBe('');
  const third = f.store.ask(scope, 'third'); await f.flush(); f.store.clear(scope); f.replies[2]({ text: 'cleared' }); await third;
  expect(f.store.entry(scope).turns).toEqual([]);
  const fourth = f.store.ask(scope, 'fourth'); await f.flush(); f.store.reset(); f.replies[3]({ text: 'reset' }); await fourth;
  expect(f.store.entry(scope).turns).toEqual([]);
});
test('runtime change while applying selection stops before generate; change during generate drops payload and clears pending', async () => {
  const f = fixture(); let release!: () => void;
  f.setApply(() => new Promise(resolve => { release = resolve; }));
  const flight = f.store.ask(scope, 'question'); f.setRuntime({ transport: 'fixture', generation: 2 }); release(); await flight;
  expect(f.calls).toEqual([]); expect(f.store.entry(scope).turns[0].pending).toBe(false);
  f.setApply(async () => {}); const next = f.store.ask(scope, 'second'); await f.flush();
  f.setRuntime({ transport: 'fixture', generation: 3 }); f.replies[0]({ text: 'stale generation' }); await next;
  expect(f.store.entry(scope).turns[1].answer).toBe(''); expect(f.store.entry(scope).turns[1].pending).toBe(false);
});
test('empty replies and selection failures retain retryable turns; retry is explicit and in-place', async () => {
  const f = fixture(); const first = f.store.ask(scope, 'question'); await f.flush(); f.replies[0]({ text: ' ' }); await first;
  const id = f.store.entry(scope).turns[0].id; expect(f.store.entry(scope).turns[0].error).toBe('empty response');
  const retry = f.store.retry(scope); await f.flush(); f.replies[1]({ text: 'answer' }); await retry;
  expect(f.store.entry(scope).turns).toHaveLength(1); expect(f.store.entry(scope).turns[0]).toMatchObject({ id, answer: 'answer', error: null });
  f.setApply(async () => { throw new Error('selection failed'); }); await f.store.ask(scope, 'next');
  expect(f.calls).toHaveLength(2); expect(f.store.entry(scope).turns[1]).toMatchObject({ error: 'selection failed', pending: false });
});
test('retention matches Web: 40 entries, 50 turns, 12 answered prompt turns, 10 deduplicated quotes', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.store.addQuote(scope, `quote-${i}`);
  f.store.addQuote(scope, 'quote-11'); expect(f.store.entry(scope).quotes).toHaveLength(10); expect(f.store.entry(scope).quotes[0]).toBe('quote-2');
  f.store.removeQuote(scope, 0); expect(f.store.entry(scope).quotes).toHaveLength(9);
  for (let i = 0; i < 55; i++) { const flight = f.store.ask(scope, `question-${i}`); await f.flush(); f.replies[i]({ text: `answer-${i}` }); await flight; }
  expect(f.store.entry(scope).turns).toHaveLength(50); const prompt = f.calls[54].prompt;
  expect(prompt).not.toContain('Assistant: answer-41\n'); expect(prompt).toContain('Assistant: answer-42\n');
  for (let i = 0; i < 40; i++) f.store.addQuote({ sessionId: `other-${i}`, directory: '/workspace' }, 'quote');
  expect(f.store.entry(scope).turns).toEqual([]);
});
test('completed turns refresh Web LRU order rather than evicting a newly completed old request', async () => {
  const f = fixture(), flight = f.store.ask(scope, 'question'); await f.flush();
  for (let i = 0; i < 39; i++) f.store.addQuote({ sessionId: `other-${i}`, directory: '/workspace' }, 'quote');
  f.replies[0]({ text: 'recently completed' }); await flight;
  f.store.addQuote({ sessionId: 'other-39', directory: '/workspace' }, 'quote');
  expect(f.store.entry(scope).turns[0].answer).toBe('recently completed');
  expect(f.store.entry({ sessionId: 'other-0', directory: '/workspace' }).quotes).toEqual([]);
});
test('captured cleanup cannot clear/cancel the new runtime, including a new generation of the same transport', async () => {
  const f = fixture(), old = f.store.captureScope(scope);
  const first = f.store.ask(old, 'old'); await f.flush();
  f.setRuntime({ transport: 'fixture', generation: 2 });
  const current = f.store.captureScope(scope), second = f.store.ask(current, 'new'); await f.flush();
  f.store.cancel(old); f.store.clear(old);
  expect(f.calls[1].signal.aborted).toBe(false); expect(f.store.entry(current).turns[1].question).toBe('new');
  f.replies[0]({ text: 'stale' }); await first;
  f.replies[1]({ text: 'new answer' }); await second;
  expect(f.store.entry(current).turns[1].answer).toBe('new answer');
  expect(await f.store.ask(old, 'retired')).toBe(false); expect(f.calls).toHaveLength(2);
});

import { expect, test } from 'vitest';
import { createNativeBtwStore } from './desktop-btw';
import { createNativeDesktopBtwHandle } from './desktop-btw-panel-core';

test('one real store, exact-entry close, hidden retention, and core-level interaction fences', async () => {
  let visible = true, active = true, interactive = true, current = true, closed = 0, calls = 0;
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'host', generation: 1 }), resolveSelection: () => null,
    rememberSelection: () => {}, applySelection: async () => {}, generate: async () => { calls++; return { text: 'answer' }; } });
  const a = { sessionId: 'a', directory: '/workspace' }, b = { sessionId: 'b', directory: '/workspace' };
  await store.ask(a, 'keep a'); await store.ask(b, 'clear b');
  const handle = createNativeDesktopBtwHandle({ store, scope: b, current: () => current, active: () => active,
    interactive: () => interactive, visible: () => visible, onClose: () => { closed++; } });
  visible = false; expect(handle.ask('hidden')).toBe(false); expect(handle.addQuote('retained')).toBe(true);
  visible = true; interactive = false; expect(handle.ask('modal')).toBe(false); expect(handle.setSelection({ providerID: 'x', modelID: 'y' })).toBe(false); expect(handle.close()).toBe(false);
  interactive = true; active = false; expect(handle.retry()).toBe(false); active = true; current = false; expect(handle.cancel()).toBe(false);
  current = true; expect(handle.close()).toBe(true); expect(handle.close()).toBe(false); expect(closed).toBe(1);
  expect(store.entry(a).turns[0].answer).toBe('answer'); expect(store.entry(b).turns).toHaveLength(0); expect(store.entry(b).quotes).toHaveLength(0); expect(calls).toBe(2);
  expect(handle.ask('closed')).toBe(false); handle.dispose(); store.dispose();
});

test('missing generate is rejected by the actual store API itself, not only button visibility', async () => {
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'host', generation: 1 }), resolveSelection: () => null,
    rememberSelection: () => {}, applySelection: async () => { throw new Error('must not apply without generate'); } });
  const scope = { sessionId: 'session', directory: '/workspace' };
  store.addQuote(scope, 'keep quote'); expect(store.available()).toBe(false);
  expect(await store.ask(scope, 'question')).toBe(false); expect(await store.retry(scope)).toBe(false);
  expect(store.entry(scope)).toEqual({ turns: [], quotes: ['keep quote'] });
});

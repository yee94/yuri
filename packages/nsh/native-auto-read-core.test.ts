import { expect, test, vi } from 'vitest';
import { createNativeAutoReadController, createNativeAutoReadPreference, type NativeAutoReadSnapshot } from './native-auto-read-core';
import { createSpeechController } from './speech-core';

const history = { id: 'history', role: 'assistant', time: { created: 10, completed: 20 } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(work?: (name: string, value: Record<string, unknown>) => Promise<unknown>) {
  const values = new Map<string, string>();
  const storage = { getItem: vi.fn(async (key: string) => values.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }) };
  const preference = createNativeAutoReadPreference(storage);
  const call = vi.fn(async (name: string, value: Record<string, unknown>) => work ? work(name, value) : name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : undefined);
  const speech = createSpeechController({ owner: 'fixture', current: () => true, call, changed: () => {} });
  const controller = createNativeAutoReadController({ speech, preference, changed: () => {} });
  const snapshot: NativeAutoReadSnapshot = { scope: 'host/session/epoch', sessionID: 'session', active: true, foreground: true, resolved: true, recognizing: false, messages: [history] };
  controller.update(snapshot);
  const rendered = (messageID: string, created = 30, text = 'A rendered reply.') => controller.rendered({ scope: snapshot.scope, sessionID: snapshot.sessionID, messageID, created, text });
  return { values, storage, preference, speech, controller, snapshot, rendered, call };
}

test('persists the Web preference and reads only newly rendered settled replies once', async () => {
  const x = setup(); await x.preference.ready;
  await x.controller.toggle();
  x.rendered('history', 10); x.rendered('older-page', 5);
  expect(x.call).not.toHaveBeenCalled();
  x.controller.streaming({ scope: x.snapshot.scope, sessionID: 'session', messageID: 'new' });
  expect(x.call).not.toHaveBeenCalled();
  x.rendered('new');
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1));
  x.rendered('new');
  expect(x.values.get('yuri.auto-read')).toBe('true');
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
});

test('a playback failure is visible, drops the queue and never retries on further rendered events', async () => {
  const x = setup(async name => {
    if (name === 'speech.prepare') return { visible: true, provider: 'browser', mode: 'final' };
    if (name === 'speech.segment') throw new Error('Private failure must not leak');
  });
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.controller.state().error).toBe('playback'));
  x.rendered('three', 50); x.controller.update({ ...x.snapshot });
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
  expect(x.controller.state()).toMatchObject({ preferred: true, running: false, playingMessageID: null });
});

test('manual stop on the shared owner disables auto-read and fences late audio without draining', async () => {
  const segment = deferred();
  const x = setup(async name => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' ? segment.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1));
  await x.speech.stop(); segment.resolve();
  await vi.waitFor(() => expect(x.controller.state().preferred).toBe(false));
  expect(x.controller.state()).toMatchObject({ running: false, playingMessageID: null });
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
});

test('recognition fences before permission awaits, stops the same owner, and resumes only future replies', async () => {
  const segment = deferred();
  const x = setup(async name => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' ? segment.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.speech.state().status).toBe('loading'));
  await x.controller.beginRecognition();
  x.rendered('permission-gap', 50);
  segment.resolve();
  x.controller.update({ ...x.snapshot, messages: [history, { id: 'permission-gap', role: 'assistant', time: { created: 50, completed: 60 } }] });
  x.controller.endRecognition();
  x.rendered('permission-gap', 50);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
  expect(x.controller.state()).toMatchObject({ preferred: true, running: true, playingMessageID: null });
  x.rendered('after-recognition', 70);
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(2));
});

test('queue order follows committed replies, waits for audio completion, and skips wrong scopes', async () => {
  const first = deferred();
  let segments = 0;
  const x = setup(async name => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' && ++segments === 1 ? first.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.controller.rendered({ scope: 'old-host', sessionID: 'session', messageID: 'wrong', created: 40, text: 'Not current.' });
  x.rendered('z-first'); x.rendered('a-second', 40, 'Second committed reply.');
  await vi.waitFor(() => expect(x.speech.state().status).toBe('loading'));
  expect(x.controller.state().playingMessageID).toBe('z-first');
  expect(segments).toBe(1);
  first.resolve();
  await vi.waitFor(() => expect(segments).toBe(2));
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment').map(([, value]) => value.text)).toEqual(['A rendered reply.', 'Second committed reply.']);
});

test.each(['scope', 'active', 'foreground', 'resolved'] as const)('%s lifecycle clears queued audio without disabling preference or replaying resumed history', async field => {
  const first = deferred();
  const x = setup(async name => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' ? first.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.speech.state().status).toBe('loading'));
  const settled = { id: 'while-away', role: 'assistant', time: { created: 80, completed: 90 } };
  const next = { ...x.snapshot, messages: field === 'scope' ? [history, settled] : [history], [field]: field === 'scope' ? 'host/another-generation' : false };
  x.controller.update(next); first.resolve();
  x.snapshot.scope = next.scope;
  x.controller.update({ ...x.snapshot, messages: [history, settled] });
  x.rendered('while-away', 80);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(x.controller.state().preferred).toBe(true);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
});

test('old-created replies require an actually observed stream; no-op updates never scan the baseline again', async () => {
  const x = setup(); await x.preference.ready; await x.controller.toggle();
  const messages = new Proxy(x.snapshot.messages, { get(target, key, receiver) { if (key === Symbol.iterator) throw new Error('Unexpected history rescan'); return Reflect.get(target, key, receiver); } });
  for (let i = 0; i < 100; i++) x.controller.update({ ...x.snapshot, messages });
  x.rendered('late-unknown', 1);
  x.controller.streaming({ scope: x.snapshot.scope, sessionID: 'session', messageID: 'observed' });
  x.rendered('observed', 1, 'Observed live body.');
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1));
});

test('preference restores only literal true, failed writes preserve committed value and require explicit retry', async () => {
  const x = setup(); await x.preference.ready;
  x.storage.setItem.mockRejectedValueOnce(new Error('Private disk error'));
  await x.controller.toggle();
  expect(x.controller.state()).toMatchObject({ preferred: false, running: false, error: 'preference-write' });
  for (let i = 0; i < 50; i++) x.controller.update({ ...x.snapshot });
  expect(x.storage.setItem).toHaveBeenCalledTimes(1);
  await x.controller.toggle();
  expect(x.controller.state()).toMatchObject({ preferred: true, running: true, error: null });
  const restored = createNativeAutoReadPreference(x.storage); await restored.ready;
  expect(restored.state().preferred).toBe(true);
  for (const raw of ['"true"', '1', '{}', 'garbage', 'false']) {
    const pref = createNativeAutoReadPreference({ getItem: async () => raw, setItem: async () => {} });
    await pref.ready; expect(pref.state().preferred).toBe(false);
  }
});

test('dispose fences in-flight completion, does not release the shared speech owner or accept more work', async () => {
  const first = deferred();
  const x = setup(async name => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' ? first.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.speech.state().status).toBe('loading'));
  await x.controller.dispose(); first.resolve();
  await x.controller.toggle(); x.rendered('three', 50);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1);
  expect(x.call.mock.calls.some(([name]) => name === 'speech.release')).toBe(false);
});

test('a failed preference read is explicit, not an empty success, and retry and rapid toggles are serialized', async () => {
  const storage = { getItem: vi.fn(async () => 'true'), setItem: vi.fn(async () => {}) };
  storage.getItem.mockRejectedValueOnce(new Error('Private storage failure'));
  const preference = createNativeAutoReadPreference(storage);
  const speech = createSpeechController({ owner: 'fixture', current: () => true, call: async () => undefined, changed: () => {} });
  const controller = createNativeAutoReadController({ speech, preference, changed: () => {} });
  controller.update({ scope: 'scope', sessionID: 'session', active: true, foreground: true, resolved: true, recognizing: false, messages: [history] });
  await preference.ready;
  expect(controller.state()).toMatchObject({ preferred: false, running: false, error: 'preference-read' });
  await controller.toggle(); expect(storage.setItem).not.toHaveBeenCalled();
  await preference.retry(); expect(controller.state()).toMatchObject({ preferred: true, running: true, error: null });
  await controller.toggle();
  await Promise.all([controller.toggle(), controller.toggle()]);
  expect(controller.state().preferred).toBe(false);
  expect(storage.setItem.mock.calls).toEqual([['yuri.auto-read', 'false'], ['yuri.auto-read', 'true'], ['yuri.auto-read', 'false']]);
});

test('native lifecycle stop before the foreground update does not permanently disable subsequent replies', async () => {
  const x = setup(); await x.preference.ready; await x.controller.toggle();
  await x.speech.stop('lifecycle');
  x.controller.update({ ...x.snapshot, foreground: false });
  x.controller.update({ ...x.snapshot, foreground: true });
  expect(x.controller.state()).toMatchObject({ preferred: true, running: true });
  x.rendered('after-foreground');
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1));
});

test('a failed stop blocks recognition instead of allowing capture and auto speech to overlap', async () => {
  const x = setup(async name => {
    if (name === 'speech.stop') throw new Error('Private stop failure');
  });
  await x.preference.ready; await x.controller.toggle();
  await expect(x.controller.beginRecognition()).rejects.toThrow('Unable to stop speech before recognition');
  x.controller.endRecognition(); x.rendered('must-not-play');
  expect(x.controller.state()).toMatchObject({ preferred: true, running: false, error: 'playback' });
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(0);
});

test('preference is shared across page owners without touching inactive owners speech', async () => {
  const x = setup(); await x.preference.ready;
  const call = vi.fn(async (name: string) => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : undefined);
  const speech = createSpeechController({ owner: 'second', current: () => true, call, changed: () => {} });
  const other = createNativeAutoReadController({ speech, preference: x.preference, changed: () => {} });
  other.update({ ...x.snapshot, scope: 'inactive/other', active: false });
  await x.controller.toggle();
  expect(other.state()).toMatchObject({ preferred: true, running: false });
  await x.controller.toggle();
  expect(other.state().preferred).toBe(false);
  expect(call).not.toHaveBeenCalled();
});

test('Host invalidation and manual playback retire automatic queues and ignore stale completions', async () => {
  const first = deferred();
  const x = setup(async (name, value) => name === 'speech.prepare' ? { visible: true, provider: 'browser', mode: 'final' } : name === 'speech.segment' && value.text === 'A rendered reply.' ? first.promise : undefined);
  await x.preference.ready; await x.controller.toggle();
  x.rendered('one'); x.rendered('two', 40);
  await vi.waitFor(() => expect(x.speech.state().status).toBe('loading'));
  x.speech.event('speech.invalidated', { owner: 'fixture' }); first.resolve();
  await x.speech.play('manual', 'Explicit manual reading.');
  expect(x.controller.state()).toMatchObject({ preferred: true, running: false, playingMessageID: null });
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment').map(([, value]) => value.text)).toEqual(['A rendered reply.', 'Explicit manual reading.']);
});

test('native background invalidation releases the run without permanently halting future foreground replies', async () => {
  const x = setup(); await x.preference.ready; await x.controller.toggle();
  x.speech.event('speech.invalidated', { owner: 'fixture' });
  x.controller.update({ ...x.snapshot, foreground: false });
  x.controller.update({ ...x.snapshot, foreground: true });
  expect(x.controller.state()).toMatchObject({ preferred: true, running: true });
  x.rendered('future-after-native-invalidation');
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(1));
});

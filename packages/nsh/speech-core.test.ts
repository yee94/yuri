import { expect, test, vi } from 'vitest';
import { createSpeechController, speechSettings, type SpeechState } from './speech-core';

const settings = { visible: true, provider: 'openai-compatible', mode: 'sanitized' };
function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(work?: (name: string, value: Record<string, unknown>) => Promise<unknown>) {
  let state: SpeechState = { status: 'unloaded' }, valid = true;
  const call = vi.fn(async (name: string, value: Record<string, unknown>) => work ? work(name, value) : name === 'speech.prepare' ? settings : undefined);
  const controller = createSpeechController({ owner: 'neutral-owner', current: () => valid, call, changed: value => { state = value; } });
  return { controller, call, state: () => state, invalidate: () => { valid = false; } };
}
test('one settings read per page; unknown provider and failures do not become defaults', async () => {
  const x = setup();
  await Promise.all([x.controller.prepare(), x.controller.prepare()]);
  await x.controller.play('one', 'A neutral response.');
  await x.controller.play('two', 'Another neutral response.');
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.prepare')).toHaveLength(1);
  expect(() => speechSettings({ ...settings, provider: 'invented' })).toThrow();
  const bad = setup(async () => { throw new Error('Fixture failure'); });
  await bad.controller.prepare();
  expect(bad.state()).toEqual({ status: 'error', failed: true });
});
test('shared cleanup strips code/markup/URL; long Unicode is bounded and sequential', async () => {
  const x = setup();
  await x.controller.play('one', '# Header\n```js\nsecretCode()\n```\n**Neutral** https://example.invalid\n\n' + '你好🙂。 '.repeat(220));
  const chunks = x.call.mock.calls.filter(([name]) => name === 'speech.segment').map(([, value]) => value.text as string);
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.every(value => value.length <= 280)).toBe(true);
  expect(chunks.join(' ')).not.toMatch(/secretCode|https:|\*\*|```|#/);
  expect(chunks.join(' ')).not.toContain('\uFFFD');
  expect(x.state().status).toBe('idle');
});
test('stop and switching messages fence a late completion without replaying old chunks', async () => {
  const first = deferred();
  const x = setup(async (name, value) => name === 'speech.prepare' ? settings : name === 'speech.segment' && String(value.text).startsWith('First') ? first.promise : undefined);
  const playing = x.controller.play('old', 'First. ' + 'Neutral. '.repeat(100));
  await vi.waitFor(() => expect(x.state().status).toBe('loading'));
  await x.controller.play('new', 'Second response.');
  first.resolve(); await playing;
  expect(x.state().status).toBe('idle');
  const texts = x.call.mock.calls.filter(([name]) => name === 'speech.segment').map(([, v]) => v.text);
  expect(texts).toHaveLength(2);
  expect(texts[1]).toBe('Second response.');
});
test('two rapid play gestures cannot share an operation after asynchronous stop acknowledgement', async () => {
  const stop = deferred();
  let stops = 0;
  const x = setup(async name => name === 'speech.prepare' ? settings : name === 'speech.stop' && ++stops === 1 ? stop.promise : undefined);
  const first = x.controller.play('old', 'First response.');
  await x.controller.play('new', 'Second response.');
  stop.resolve(); await first;
  const segments = x.call.mock.calls.filter(([n]) => n === 'speech.segment');
  expect(segments).toHaveLength(1);
  expect(segments[0][1].text).toBe('Second response.');
});
test('failure retains interrupted segment for retry, explicit restart starts from beginning', async () => {
  let count = 0;
  const x = setup(async name => {
    if (name === 'speech.prepare') return settings;
    if (name === 'speech.segment' && ++count === 2) throw new Error('Fixture failure');
  });
  const text = 'Neutral sentence. '.repeat(70);
  await x.controller.play('one', text);
  expect(x.state().status).toBe('error');
  expect(x.controller.canResume('one', text)).toBe(true);
  const before = x.call.mock.calls.filter(([n]) => n === 'speech.segment').map(([, v]) => v.text);
  await x.controller.play('one', text);
  const all = x.call.mock.calls.filter(([n]) => n === 'speech.segment').map(([, v]) => v.text);
  expect(all[2]).toBe(before[1]);
  expect(x.controller.canResume('one', text)).toBe(false);
});
test('Host/background invalidation discards config and resume; stale events and disposal are harmless', async () => {
  const pending = deferred();
  const x = setup(async name => name === 'speech.prepare' ? settings : name === 'speech.segment' ? pending.promise : undefined);
  const play = x.controller.play('one', 'Neutral response.');
  await vi.waitFor(() => expect(x.state().status).toBe('loading'));
  const segment = x.call.mock.calls.find(([name]) => name === 'speech.segment')![1];
  x.controller.event('speech.playing', { owner: 'wrong', revision: segment.revision });
  expect(x.state().status).toBe('loading');
  x.controller.event('speech.playing', segment);
  expect(x.state().status).toBe('playing');
  x.controller.event('speech.invalidated', { owner: 'neutral-owner' });
  expect(x.state()).toEqual({ status: 'unloaded' });
  pending.resolve(); await play;
  expect(x.state().status).toBe('unloaded');
  await x.controller.dispose();
  await x.controller.play('two', 'Do not start.');
  expect(x.call.mock.calls.at(-1)?.[0]).toBe('speech.release');
});
test('summarized mode only invokes the injected model for long replies and cleans its output', async () => {
  const summarize = vi.fn(async () => '**A neutral summary.**');
  const call = vi.fn(async (name: string) => name === 'speech.prepare' ? { ...settings, mode: 'summarized' } : undefined);
  const x = createSpeechController({ owner: 'neutral', current: () => true, call, changed: () => {}, summarize });
  await x.play('one', 'A neutral sentence. '.repeat(80));
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith('speech.segment', expect.objectContaining({ text: 'A neutral summary.' }));
});

test('hidden manual controls do not authorize manual playback but explicit auto-read uses the same owner', async () => {
  const x = setup(async name => name === 'speech.prepare' ? { ...settings, visible: false } : undefined);
  expect(await x.controller.play('manual', 'Manual request.')).toBe('unavailable');
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toHaveLength(0);
  expect(await x.controller.play('automatic', 'Automatic request.', true, 'auto-read')).toBe('completed');
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.segment')).toEqual([
    ['speech.segment', expect.objectContaining({ owner: 'neutral-owner', source: 'auto-read', text: 'Automatic request.' })],
  ]);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.prepare')).toHaveLength(1);
});

test('screen-awake uses the speech owner, reports unsupported, and has independent monotonic revisions', async () => {
  const x = setup(async name => name === 'speech.prepare' ? settings : name === 'speech.awake' ? { supported: false, enabled: false } : undefined);
  expect(await x.controller.awake(true)).toBe(false);
  await x.controller.play('one', 'Neutral reply.', true, 'auto-read');
  expect(await x.controller.awake(false)).toBe(false);
  const calls = x.call.mock.calls.filter(([name]) => name === 'speech.awake').map(([, value]) => value);
  expect(calls).toEqual([
    { owner: 'neutral-owner', revision: 1, enabled: true },
    { owner: 'neutral-owner', revision: 2, enabled: false },
  ]);
  expect(x.state().status).toBe('idle');
});

test('disabling awake before prepare completes cannot acquire a late screen assertion', async () => {
  const preparation = deferred();
  const x = setup(async name => name === 'speech.prepare' ? preparation.promise : { supported: true, enabled: true });
  const pending = x.controller.awake(true);
  expect(await x.controller.awake(false)).toBe(false);
  preparation.resolve(settings);
  expect(await pending).toBe(false);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.awake')).toHaveLength(0);
});

test('late awake acquisition, invalidation and disposal cannot revive an old owner request', async () => {
  const pending = deferred();
  const x = setup(async (name, value) => name === 'speech.prepare' ? settings : name === 'speech.awake' && value.enabled ? pending.promise : { supported: true, enabled: false });
  const first = x.controller.awake(true);
  await vi.waitFor(() => expect(x.call.mock.calls.filter(([name]) => name === 'speech.awake')).toHaveLength(1));
  expect(await x.controller.awake(false)).toBe(false);
  pending.resolve({ supported: true, enabled: true });
  expect(await first).toBe(false);
  x.controller.event('speech.invalidated', { owner: 'neutral-owner' });
  await x.controller.dispose();
  expect(await x.controller.awake(true)).toBe(false);
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.awake').map(([, value]) => value.revision)).toEqual([1, 2]);
  expect(x.call.mock.calls.at(-1)?.[0]).toBe('speech.release');
});

test('awake transport and response failures stay explicit without changing playback state or retrying', async () => {
  const x = setup(async name => name === 'speech.prepare' ? settings : { supported: true, enabled: 'not-a-boolean' });
  await expect(x.controller.awake(true)).rejects.toThrow('Invalid speech awake response');
  expect(x.state().status).toBe('idle');
  expect(x.call.mock.calls.filter(([name]) => name === 'speech.awake')).toHaveLength(1);
  const bad = setup(async name => {
    if (name === 'speech.prepare') return settings;
    throw new Error('Synthetic awake failure');
  });
  await expect(bad.controller.awake(true)).rejects.toThrow('Synthetic awake failure');
  expect(bad.call.mock.calls.filter(([name]) => name === 'speech.awake')).toHaveLength(1);
});

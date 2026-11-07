import { describe, expect, test, vi } from 'vitest';
import { createSettingsVoiceRecognitionAdapter } from './settings-voice-recognition';
import { createSettingsVoiceTestController } from './settings-voice-test-core';
import { speechDefaults } from '../ui/src/lib/voice/speechSettings';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const expectedHost = { hostID: 'synthetic-host', lease: '00000000-0000-4000-8000-000000000001' };
  const handlers = new Map<string, (value: unknown) => void>();
  let valid = true;
  const start = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => input);
  const finish = vi.fn(async (): Promise<unknown> => ({ text: '' }));
  const cancel = vi.fn(async () => null);
  const call = vi.fn(async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    if (name === 'voiceRecognition.capabilities') return { providers: ['local', 'openai-compatible', 'volcengine'], maximumSeconds: 60, maximumBytes: 1_920_000 };
    if (name === 'voiceRecognition.start') return start(input);
    if (name === 'voiceRecognition.finish') return finish();
    if (name === 'voiceRecognition.cancel') return cancel();
    throw new Error('unknown bridge method');
  });
  const invalidated = vi.fn();
  return { start, finish, cancel, call, handlers, invalidated, invalidate: () => { valid = false; }, input: { call, expectedHost, invalidated, current: () => valid,
    on: (name: string, callback: (value: unknown) => void) => { handlers.set(name, callback); return () => { handlers.delete(name); }; } } };
}
const args = (partial = vi.fn()) => ({ owner: 'settings-voice-1', revision: 1, provider: 'volcengine' as const, partial });

describe('configured Host native ASR adapter (no NSH engine or network)', () => {
  test('capabilities are authoritative; no unknown provider fallback or secret/config payload', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input);
    expect(adapter.supports('volcengine')).toBe(true);
    const session = await adapter.start(args());
    expect(f.start).toHaveBeenCalledWith({ owner: 'settings-voice-1', revision: 1, provider: 'volcengine', expectedHost: f.input.expectedHost });
    expect(await session.finish()).toEqual({ text: '' });
    expect(f.cancel).not.toHaveBeenCalled();
    await session.cancel(); await adapter.dispose();
    expect(f.handlers.size).toBe(0);
    const bad = fixture(); bad.call.mockResolvedValueOnce({ providers: ['browser'], maximumSeconds: 60, maximumBytes: 1_920_000 });
    await expect(createSettingsVoiceRecognitionAdapter(bad.input)).rejects.toThrow('capabilities');
  });
  test('the adapter captures its Host lease before asynchronous capability discovery', async () => {
    const f = fixture(), pending = deferred<unknown>();
    f.call.mockImplementationOnce(() => pending.promise);
    const original = { ...f.input.expectedHost };
    const acquiring = createSettingsVoiceRecognitionAdapter(f.input);
    f.input.expectedHost.lease = '00000000-0000-4000-8000-000000000002';
    pending.resolve({ providers: ['local', 'openai-compatible', 'volcengine'], maximumSeconds: 60, maximumBytes: 1_920_000 });
    const adapter = await acquiring;
    const session = await adapter.start(args());
    expect(f.start.mock.calls[0][0].expectedHost).toEqual(original);
    expect(f.start.mock.calls[0][0].expectedHost).not.toBe(f.input.expectedHost);
    await session.cancel(); await adapter.dispose();
  });
  test('an old Native snapshot without a lease cannot start ASR or acquire an audio owner', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter({ ...f.input, expectedHost: null });
    expect(adapter.supports('volcengine')).toBe(false);
    await expect(adapter.start(args())).rejects.toThrow('scope_required');
    expect(f.start).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    await adapter.dispose();
  });
  test('partial and final are exact owner/revision scoped; late final cannot land in a new form', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input), partial = vi.fn();
    const session = await adapter.start(args(partial));
    f.handlers.get('voiceRecognition.partial')?.({ owner: 'other', revision: 1, text: 'wrong' });
    f.handlers.get('voiceRecognition.partial')?.({ owner: args().owner, revision: 2, text: 'wrong' });
    f.handlers.get('voiceRecognition.partial')?.({ owner: args().owner, revision: 1, text: 'partial' });
    expect(partial.mock.calls).toEqual([['partial']]);
    const pending = deferred<unknown>(); f.finish.mockImplementationOnce(() => pending.promise);
    const final = session.finish(); expect(session.finish()).toBe(final);
    await session.cancel();
    const next = await adapter.start({ ...args(partial), revision: 2 });
    pending.resolve({ text: 'late' });
    await expect(final).rejects.toThrow('stale');
    await next.cancel(); await adapter.dispose();
  });
  test('cancelStart retires a late native acquisition without cancelling a newer revision', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input), pending = deferred<unknown>();
    f.start.mockImplementationOnce(() => pending.promise);
    const started = adapter.start(args());
    await adapter.cancelStart(args());
    const next = await adapter.start({ ...args(), revision: 2 });
    pending.resolve({ owner: args().owner, revision: 1, provider: 'volcengine' });
    await expect(started).rejects.toThrow('stale');
    expect(f.call.mock.calls.filter(([name]) => name === 'voiceRecognition.cancel').map(([, input]) => input.revision)).toEqual([1, 1]);
    await next.cancel(); await adapter.dispose();
  });
  test('failed finish retries same audio; Host change and native invalidation suppress text', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input), session = await adapter.start(args());
    f.finish.mockRejectedValueOnce(new Error('fixture failure'));
    await expect(session.finish()).rejects.toThrow('fixture failure');
    await expect(session.finish()).resolves.toEqual({ text: '' });
    expect(f.start).toHaveBeenCalledTimes(1);
    f.handlers.get('voiceRecognition.invalidated')?.({ owner: args().owner, revision: 1 });
    expect(f.invalidated).toHaveBeenCalledTimes(1);
    await expect(session.finish()).rejects.toThrow('stale');
    f.invalidate(); await session.cancel(); await adapter.dispose();
  });
  test('cleanup errors remain retryable and invalid start ACK cancels its lease', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input), session = await adapter.start(args());
    f.cancel.mockRejectedValueOnce(new Error('cleanup'));
    await expect(session.cancel()).rejects.toThrow('cleanup');
    await session.cancel();
    f.start.mockResolvedValueOnce({ ...args(), provider: 'local' });
    await expect(adapter.start({ ...args(), revision: 2 })).rejects.toThrow('stale');
    await adapter.dispose();
  });
  test('production tester save/readback + draftRevision authority fences the native adapter', async () => {
    const f = fixture(), adapter = await createSettingsVoiceRecognitionAdapter(f.input);
    let draftRevision = 1, dirty = false;
    const confirm = vi.fn(async () => ({ settings: { ...speechDefaults, sttProvider: 'volcengine' as const, configured: true }, draftRevision }));
    const controller = createSettingsVoiceTestController({ owner: 'controller-fixture', current: () => true, dirty: () => dirty,
      draftRevision: () => draftRevision, disabled: () => false, allowed: () => true, confirm, call: f.call,
      asr: adapter, previewText: () => '', changed: () => {} });
    controller.activate(true); await controller.openAsr(); await controller.startAsr();
    expect(controller.snapshot().asr).toBe('recording');
    expect(confirm).toHaveBeenCalledTimes(2);
    const pending = deferred<unknown>(); f.finish.mockImplementationOnce(() => pending.promise);
    const completing = controller.finishAsr();
    dirty = true; draftRevision++; controller.activate(true);
    pending.resolve({ text: 'old form result' }); await completing;
    expect(controller.snapshot().transcript).toBe('');
    expect(controller.snapshot().asrOpen).toBe(false);
    await controller.dispose(); await adapter.dispose();
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { SpeechSettings } from '../ui/src/lib/voice/speechSettings';
import { createSettingsVoiceTestController } from './settings-voice-test-core';
import { createVoiceTestHost, deferred } from './tests/settings-voice-test-host';

const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
function setup(overrides: Partial<SpeechSettings> = {}) {
  const host = createVoiceTestHost(overrides);
  let current = true, dirty = false, revision = 1;
  const confirm = vi.fn(async () => ({ settings: { ...host.settings }, draftRevision: revision }));
  const changed = vi.fn();
  const controller = createSettingsVoiceTestController({ owner: 'settings-test', current: () => current, dirty: () => dirty,
    draftRevision: () => revision, disabled: () => false, allowed: () => true, call: host.call, asr: host.asr,
    confirm, previewText: () => 'Synthetic preview', changed });
  host.onEvent(controller.event); controller.activate(true);
  return { host, controller, confirm, changed,
    change: () => { dirty = true; revision++; controller.activate(true); },
    switchHost: () => { current = false; controller.activate(true); },
  };
}

test('a failed save cannot preview with the previously configured provider or an old secret', async () => {
  const call = vi.fn();
  const controller = createSettingsVoiceTestController({ owner: 'settings-test', current: () => true, dirty: () => true,
    draftRevision: () => 1, disabled: () => false, allowed: () => true, call, asr: null,
    confirm: async () => null, previewText: () => 'Synthetic preview', changed: () => {} });
  controller.activate(true);
  await controller.preview();
  expect(call).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'save-failed' });
});

test('a stale read-back receipt cannot bypass a concurrent edit even when configured was true', async () => {
  const h = setup({ voiceProvider: 'volcengine', configured: true });
  const saved = deferred<Awaited<ReturnType<typeof h.confirm>>>(); h.confirm.mockReturnValueOnce(saved.promise);
  const playing = h.controller.preview(); await flush();
  h.change(); saved.resolve({ settings: h.host.settings, draftRevision: 1 }); await playing;
  expect(h.host.calls).toEqual([]);
  expect(h.controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'changed' });
});

describe('settings playback uses the one native bridge, independently from Chat visibility/mode', () => {
  test.each([
    ['browser', null], ['local', '/api/dictation/tts/speak'], ['say', '/api/tts/say/speak'],
    ['openai', '/api/tts/speak'], ['openai-compatible', '/api/tts/speak'], ['volcengine', '/api/tts/speak'],
  ] as const)('preserves the configured %s provider and exact route', async (voiceProvider, route) => {
    const h = setup({ voiceProvider, configured: true, showMessageTTSButtons: false, ttsInputMode: 'summarized', openaiCompatibleUrl: 'https://synthetic.example.invalid/v1' });
    const playing = h.controller.preview(); await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith('tts');
    expect(h.controller.snapshot().tts).toBe('playing');
    expect(h.host.routes).toEqual([route]);
    expect(h.host.calls.map(call => call.name)).toEqual(['speech.prepare', 'speech.segment']);
    expect(h.host.calls[1].input).toMatchObject({ source: 'settings-preview', text: 'Synthetic preview' });
    h.host.completeAudio(); await playing;
    expect(h.controller.snapshot()).toMatchObject({ tts: 'idle', ttsError: null });
    expect(h.host.calls.slice(-2).map(call => call.name)).toEqual(['speech.stop', 'speech.release']);
  });
  test('stop during playback releases audio, fences completion, and the next preview owns a new lease', async () => {
    const h = setup(); const playing = h.controller.preview(); await flush();
    const owner = h.host.calls[0].input.owner;
    await h.controller.stopPreview(); await playing;
    expect(h.controller.snapshot().tts).toBe('idle');
    const next = h.controller.preview(); await flush();
    expect(h.host.calls.filter(call => call.name === 'speech.prepare').at(-1)!.input.owner).not.toBe(owner);
    h.controller.event('speech.playing', { owner, revision: 1 });
    h.host.completeAudio(); await next;
    expect(h.controller.snapshot().tts).toBe('idle');
  });
  test('stop and rapid reopen retire an in-flight settings preparation without starting its stale audio', async () => {
    const h = setup(); const gate = h.host.holdPrepare();
    const playing = h.controller.preview(); await flush();
    const stop = h.controller.stopPreview(); await flush();
    expect(h.host.calls.some(call => call.name === 'speech.segment')).toBe(false);
    gate.resolve(null); await stop; await playing;
    const next = h.controller.preview(); await flush();
    expect(h.host.calls.filter(call => call.name === 'speech.segment')).toHaveLength(1);
    h.host.completeAudio(); await next;
  });
  test('cancellation during save never reaches prepare, audio, models, or HTTP', async () => {
    const h = setup(); const saved = deferred<Awaited<ReturnType<typeof h.confirm>>>(); h.confirm.mockReturnValueOnce(saved.promise);
    const playing = h.controller.preview(); await flush();
    await h.controller.stopPreview(); saved.resolve({ settings: h.host.settings, draftRevision: 1 }); await playing;
    expect(h.host.calls).toEqual([]); expect(h.controller.snapshot().tts).toBe('idle');
  });
  test('provider failure is not swallowed or rendered as a raw sensitive error', async () => {
    const h = setup(); const playing = h.controller.preview(); await flush(); h.host.failAudio(); await playing;
    expect(h.controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'playback-failed' });
    expect(JSON.stringify(h.controller.snapshot())).not.toContain('private');
    expect(h.host.calls.at(-1)!.name).toBe('speech.release');
  });
  test('the native prepared provider must match the confirmed settings; never silently fall back to browser speech', async () => {
    const h = setup({ voiceProvider: 'browser' });
    h.confirm.mockResolvedValueOnce({ settings: { ...h.host.settings, voiceProvider: 'volcengine', configured: true }, draftRevision: 1 });
    await h.controller.preview();
    expect(h.controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'playback-failed' });
    expect(h.host.routes).toEqual([]);
    expect(h.host.calls.at(-1)!.name).toBe('speech.release');
  });
  test('failed release remains observable and is retried before acquiring another audio lease', async () => {
    const h = setup(); const playing = h.controller.preview(); await flush(); h.host.failNext('speech.release');
    h.host.completeAudio(); await playing;
    expect(h.controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'cleanup-failed' });
    const callCount = h.host.calls.length;
    const next = h.controller.preview(); await flush();
    expect(h.host.calls.slice(callCount, callCount + 3).map(call => call.name)).toEqual(['speech.stop', 'speech.release', 'speech.prepare']);
    h.host.completeAudio(); await next;
  });
  test.each(['background', 'host', 'dirty', 'dispose'] as const)('%s stops the same audio owner and rejects late playing events', async reason => {
    const h = setup(); const playing = h.controller.preview(); await flush(); const segment = h.host.calls[1].input;
    if (reason === 'background') h.controller.activate(false);
    if (reason === 'host') h.switchHost();
    if (reason === 'dirty') h.change();
    if (reason === 'dispose') await h.controller.dispose();
    await playing; await flush();
    const changes = h.changed.mock.calls.length;
    h.controller.event('speech.playing', { owner: segment.owner, revision: segment.revision });
    expect(h.changed).toHaveBeenCalledTimes(changes);
    expect(h.host.calls.at(-1)!.name).toBe('speech.release');
  });
});

describe('configured-provider ASR test, not system Speech success', () => {
  test.each(['local', 'openai-compatible', 'volcengine'] as const)('%s records partials, waits for an authoritative final and releases capture', async sttProvider => {
    const h = setup({ sttProvider, configured: true });
    await h.controller.openAsr(); expect(h.controller.snapshot()).toMatchObject({ asrOpen: true, asr: 'idle', asrProvider: sttProvider });
    await h.controller.startAsr(); expect(h.host.provider()).toBe(sttProvider);
    h.host.emitPartial('Synthetic partial'); expect(h.controller.snapshot().partial).toBe('Synthetic partial');
    const finishing = h.controller.finishAsr(); await flush(); expect(h.controller.snapshot().asr).toBe('processing');
    h.host.final('Synthetic final'); await finishing;
    expect(h.controller.snapshot()).toMatchObject({ asr: 'finished', partial: '', transcript: 'Synthetic final' });
    expect(h.host.asrCalls).toEqual(['start', 'finish', 'cancel']);
    expect(h.host.calls).toEqual([]);
    expect(h.confirm.mock.calls).toEqual([['asr'], ['asr']]);
  });
  test('without a configured-provider capture bridge, the dialog reports unsupported and does not substitute NSH Speech', async () => {
    const call = vi.fn(), confirm = vi.fn(async () => ({ settings: createVoiceTestHost({ sttProvider: 'volcengine', configured: true }).settings, draftRevision: 1 }));
    const c = createSettingsVoiceTestController({ owner: 'settings-asr', current: () => true, dirty: () => false, draftRevision: () => 1, disabled: () => false, allowed: () => true,
      confirm, call, asr: null, previewText: () => 'Synthetic preview', changed: () => {} });
    c.activate(true); await c.openAsr(); await c.startAsr();
    expect(c.snapshot()).toMatchObject({ asrOpen: true, asr: 'unsupported', transcript: '' }); expect(call).not.toHaveBeenCalled();
  });
  test('an unconfigured Volcengine snapshot cannot test either direction', async () => {
    const h = setup({ voiceProvider: 'volcengine', sttProvider: 'volcengine', configured: false });
    await h.controller.preview(); expect(h.controller.snapshot().ttsError).toBe('not-configured');
    await h.controller.openAsr(); await h.controller.startAsr();
    expect(h.controller.snapshot()).toMatchObject({ asrError: 'not-configured', asrOpen: false });
    expect(h.host.calls).toEqual([]); expect(h.host.asrCalls).toEqual([]);
  });
  test('a terminal failure retains the same session for explicit retry, never partial-as-final success', async () => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr(); h.host.emitPartial('Only partial');
    const finishing = h.controller.finishAsr(); h.host.failFinal(); await finishing;
    expect(h.controller.snapshot()).toMatchObject({ asr: 'failed', asrError: 'asr-failed', transcript: '' });
    h.host.retryFinal(); const retry = h.controller.retryAsr(); h.host.final('Retried final'); await retry;
    expect(h.controller.snapshot()).toMatchObject({ asr: 'finished', transcript: 'Retried final', asrError: null });
    expect(h.host.asrCalls).toEqual(['start', 'finish', 'finish', 'cancel']);
  });
  test('silence is an authoritative empty final, not an upload failure', async () => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr();
    const finishing = h.controller.finishAsr(); h.host.final(''); await finishing;
    expect(h.controller.snapshot()).toMatchObject({ asr: 'finished', asrError: null, transcript: '' });
  });
  test.each(['cancel', 'background', 'host', 'dirty', 'dispose'] as const)('%s clears recording/final results and retires the captured provider', async reason => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr();
    const finishing = h.controller.finishAsr();
    if (reason === 'cancel') await h.controller.closeAsr();
    if (reason === 'background') h.controller.activate(false);
    if (reason === 'host') h.switchHost();
    if (reason === 'dirty') h.change();
    if (reason === 'dispose') await h.controller.dispose();
    await flush(); h.host.emitPartial('Late private partial'); h.host.final('Late private final'); await finishing;
    expect(h.controller.snapshot().transcript).toBe(''); expect(h.controller.snapshot().partial).toBe('');
    expect(h.host.asrCalls).toContain('cancel');
  });
  test('a late capture acquisition after closing is cancelled, and cannot reopen the test', async () => {
    const h = setup(); const gate = h.host.holdAsrStart(); await h.controller.openAsr();
    const recording = h.controller.startAsr(); await flush(); const closing = h.controller.closeAsr(); await flush();
    expect(h.host.asrCalls).toEqual(['start', 'cancel-start']);
    gate.resolve(); await closing; await recording;
    expect(h.host.asrCalls).toEqual(['start', 'cancel-start', 'cancel']); expect(h.controller.snapshot()).toMatchObject({ asrOpen: false, asr: 'closed', transcript: '' });
  });
  test('a cleanup failure after the final result retries cleanup only, never another transcription', async () => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr();
    h.host.failNext('asr.cancel'); const finishing = h.controller.finishAsr(); h.host.final('Confirmed final'); await finishing;
    expect(h.controller.snapshot()).toMatchObject({ asr: 'failed', asrError: 'cleanup-failed', transcript: '' });
    await h.controller.retryAsr();
    expect(h.controller.snapshot()).toMatchObject({ asr: 'finished', asrError: null, transcript: 'Confirmed final' });
    expect(h.host.asrCalls).toEqual(['start', 'finish', 'cancel', 'cancel']);
  });
  test('a mismatched adapter provider fails closed and cancels instead of accepting a transcript', async () => {
    const h = setup({ sttProvider: 'volcengine', configured: true }); h.host.returnAsrProvider('local');
    await h.controller.openAsr(); await h.controller.startAsr();
    expect(h.controller.snapshot()).toMatchObject({ asr: 'failed', asrError: 'asr-failed', transcript: '' });
    expect(h.host.asrCalls).toEqual(['start', 'cancel']);
  });
  test('a quick close/reopen waits for the previous pending capture to be cancelled before showing a fresh test', async () => {
    const h = setup(); const gate = h.host.holdAsrStart(); await h.controller.openAsr();
    const recording = h.controller.startAsr(); await flush();
    const closing = h.controller.closeAsr(), reopening = h.controller.openAsr(); await flush();
    expect(h.host.asrCalls).toEqual(['start', 'cancel-start']);
    gate.resolve(); await Promise.all([recording, closing, reopening]);
    expect(h.controller.snapshot()).toMatchObject({ asrOpen: true, asr: 'idle', partial: '', transcript: '' });
    expect(h.host.asrCalls).toEqual(['start', 'cancel-start', 'cancel']);
  });
  test('a delayed close from the old native presentation cannot dismiss a reopened dialog or stop a new preview', async () => {
    const h = setup(); await h.controller.openAsr(); const old = h.controller.snapshot().asrRevision;
    await h.controller.closeAsr(old); await h.controller.openAsr();
    const next = h.controller.snapshot().asrRevision;
    expect(next).not.toBe(old); await h.controller.closeAsr(old);
    expect(h.controller.snapshot()).toMatchObject({ asrOpen: true, asrRevision: next });
    const playing = h.controller.preview(); await flush();
    await h.controller.closeAsr(next);
    expect(h.controller.snapshot().tts).toBe('playing');
    h.host.completeAudio(); await playing;
  });
  test('a stale stop-preview action cannot retire the independently opened ASR session', async () => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr(); await h.controller.stopPreview();
    expect(h.controller.snapshot().asr).toBe('recording'); expect(h.host.asrCalls).toEqual(['start']);
    await h.controller.closeAsr();
  });
  test('ASR and preview never overlap, including a failed cancellation that must be retried first', async () => {
    const h = setup(); await h.controller.openAsr(); await h.controller.startAsr(); h.host.failNext('asr.cancel');
    await h.controller.preview();
    expect(h.controller.snapshot()).toMatchObject({ tts: 'failed', ttsError: 'cleanup-failed' });
    expect(h.host.calls).toEqual([]);
    const playing = h.controller.preview(); await flush();
    expect(h.host.asrCalls).toEqual(['start', 'cancel', 'cancel']);
    expect(h.controller.snapshot()).toMatchObject({ asrOpen: false, tts: 'playing' });
    h.host.completeAudio(); await playing;
  });
});

test('synthetic provider boundary rejects unknown capabilities, extra fields and non-preview audio sources', async () => {
  const host = createVoiceTestHost();
  await expect(host.call('speech.prepare', { owner: 'test', apiKey: 'not-a-credential' })).rejects.toThrow('Unexpected');
  await expect(host.call('runtime.request', { path: '/api/tts/speak' })).rejects.toThrow('Unexpected');
  await host.call('speech.prepare', { owner: 'test' });
  await expect(host.call('speech.segment', { owner: 'test', revision: 1, text: 'Synthetic', source: 'auto-read' })).rejects.toThrow('Invalid');
});

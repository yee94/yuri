import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceModelManager, voiceLocalModels, voiceModelSnapshot, type VoiceModelStatus } from './settings-voice-models-core';

const id = 'parakeet-tdt-0.6b-v2-int8';
const model = (patch: Partial<VoiceModelStatus> = {}): VoiceModelStatus => ({ id, installed: false, downloading: false, downloadProgress: null, downloadError: null, ...patch });
const status = (models = [model()], ttsModels = [model({ id: 'kokoro-en-v0_19' })]) => ({ provider: 'local', available: false, reasonCode: 'models_missing', models, ttsModels });
const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('Host voice model authority', () => {
  it('parses STT and TTS even when selected model is not available', () => {
    expect(voiceModelSnapshot(status())).toHaveLength(2);
    expect(voiceLocalModels.map(entry => entry.id)).toEqual([id, 'parakeet-tdt-0.6b-v3-int8', 'whisper-base-int8', 'whisper-tiny-int8', 'kokoro-en-v0_19']);
    for (const bad of [{}, { ...status(), models: null }, status([model({ downloadProgress: NaN })]), status([model(), model()]), status([model({ installed: undefined as unknown as boolean })])]) expect(() => voiceModelSnapshot(bad)).toThrow();
  });
  it('does no reads while hidden; activation reads once, no idle polling', async () => {
    vi.useFakeTimers(); const send = vi.fn(async () => status());
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    await manager.refresh(); expect(send).not.toHaveBeenCalled();
    manager.activate(true); await drain(); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000); expect(send).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
  it('download ACK is not installation and polls only through Host progress', async () => {
    vi.useFakeTimers(); let reads = 0;
    const send = vi.fn(async (_path: string, method = 'GET') => method === 'POST' ? { ok: true, installed: false } : ++reads === 1 ? status() : reads === 2 ? status([model({ downloading: true, downloadProgress: 25 })]) : status([model({ installed: true })]));
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    manager.activate(true); await drain(); await manager.mutate(id, 'POST');
    expect(send.mock.calls[1]).toEqual([`/api/dictation/models/${id}/download`, 'POST']);
    expect(manager.snapshot().models[0]).toMatchObject({ installed: false, downloading: true, downloadProgress: 25 });
    await vi.advanceTimersByTimeAsync(2000); expect(manager.snapshot().models[0].installed).toBe(true);
    await vi.advanceTimersByTimeAsync(10000); expect(send).toHaveBeenCalledTimes(4); manager.dispose();
  });
  it('preserves snapshot on refresh failure; explicit read retry never replays accepted mutation', async () => {
    let fail = false; const send = vi.fn(async (_path: string, method = 'GET') => {
      if (method !== 'GET') { fail = true; return { ok: true }; }
      if (fail) throw new Error('offline'); return status([model({ installed: true })]);
    });
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    manager.activate(true); await drain(); const previous = manager.snapshot().models;
    await manager.mutate(id, 'DELETE'); expect(manager.snapshot().error).toBe('offline'); expect(manager.snapshot().models).toBe(previous);
    await manager.mutate(id, 'DELETE'); expect(send.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1);
    fail = false; await manager.refresh(); expect(send.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1); manager.dispose();
  });
  it('retains failed download, retries its action and refreshes; failed action never fakes success', async () => {
    const send = vi.fn(async (_path: string, method = 'GET') => method === 'POST' ? { ok: false, error: 'denied' } : status([model({ downloadError: 'network lost' })]));
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    manager.activate(true); await drain(); await manager.mutate(id, 'POST');
    expect(manager.snapshot().operationError).toEqual({ id, message: 'denied' });
    expect(manager.snapshot().models[0]).toMatchObject({ installed: false, downloadError: 'network lost' });
    await manager.mutate(id, 'POST'); expect(send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(2); manager.dispose();
  });
  it('blocks unknown/missing/downloading models and duplicate operations', async () => {
    let finish!: (value: unknown) => void;
    const send = vi.fn((_path: string, method = 'GET'): Promise<unknown> => method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(status()));
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    manager.activate(true); await drain();
    await manager.mutate('unknown', 'POST'); await manager.mutate('whisper-tiny-int8', 'POST'); await manager.mutate(id, 'DELETE'); expect(send).toHaveBeenCalledTimes(1);
    const flight = manager.mutate(id, 'POST'); await manager.mutate(id, 'POST'); expect(send).toHaveBeenCalledTimes(2);
    finish({ ok: true }); await flight; expect(manager.snapshot().models[0].installed).toBe(false); manager.dispose();
  });
  it('hiding stops timers, late results do not apply; resume refreshes Host state', async () => {
    vi.useFakeTimers(); let resolve!: (value: unknown) => void;
    const send = vi.fn((): Promise<unknown> => new Promise(done => { resolve = done; }));
    const manager = createVoiceModelManager({ send, current: () => true, changed: () => {} });
    manager.activate(true); manager.activate(false); resolve(status([model({ installed: true })])); await drain();
    expect(manager.snapshot().models).toEqual([]); await vi.advanceTimersByTimeAsync(4000); expect(send).toHaveBeenCalledTimes(1);
    manager.activate(true); resolve(status([model({ downloading: true, downloadProgress: null })])); await drain();
    expect(manager.snapshot().models[0].downloading).toBe(true); manager.activate(false);
    await vi.advanceTimersByTimeAsync(4000); expect(send).toHaveBeenCalledTimes(2); manager.dispose();
  });
  it('Host change and disposal fence results, timers and mutations', async () => {
    let current = true, resolve!: (value: unknown) => void;
    const send = vi.fn((): Promise<unknown> => new Promise(done => { resolve = done; }));
    const manager = createVoiceModelManager({ send, current: () => current, changed: () => {} });
    manager.activate(true); current = false; resolve(status()); await drain();
    expect(manager.snapshot().models).toEqual([]); await manager.mutate(id, 'POST'); expect(send).toHaveBeenCalledTimes(1);
    manager.dispose(); current = true; manager.activate(true); await manager.refresh(); expect(send).toHaveBeenCalledTimes(1);
  });
});

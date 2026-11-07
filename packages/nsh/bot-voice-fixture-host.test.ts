import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
type Reply = { status: number; body: Record<string, unknown> };
function fixtureHost() {
  const source = readFileSync(path.join(directory, 'bot-voice-native.fixture-host.js'), 'utf8');
  const context = vm.createContext({ URL: undefined, URLSearchParams: undefined });
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const factory = vm.runInContext(source.replace('export function createHost', 'function createHost') + '\ncreateHost;', context) as () => { call(name: string, input: Record<string, unknown>): Reply };
  const host = factory();
  return (path: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) });
}
describe('isolated Bot/Voice fake bridge with no URL globals (not QuickJS)', () => {
  it('accepts only exact route/query/method and supplied real directory', () => {
    const send = fixtureHost();
    expect(send('/api/config?location%5Bdirectory%5D=%2Fworkspace%2Factual').body).toEqual([{ type: 'document', info: { model: 'not-used/model' } }]);
    expect(send('/api/config/catalog/providers').status).toBe(200);
    expect(send('/api/config/catalog/providers?directory=%2Fworkspace%2Factual').status).toBe(200);
    expect(send('/api/dictation/status?provider=local').body.provider).toBe('local');
    for (const path of ['https://host.example/api/config/settings', '/api/config/settings?x=1', '/api/config/settings?', '/api/config/settings#x', '/api/config?directory=%2Fworkspace%2Factual', '/api/config?location%5Bdirectory%5D=%2Fwrong', '/api/dictation/status?provider=local&provider=local', '/api/dictation/status?provider=%ZZ', '/api/dictation/status?provider=local?x=1', '/api/dictation/status?provider', '/api/config/catalog/providers?directory=%2Ffirst-project']) expect(() => send(path)).toThrow();
    expect(() => send('/api/config/settings', 'PUT', {})).toThrow();
    expect(() => send('/api/voice/settings', 'PUT', {})).toThrow();
    expect(() => send('/api/dictation/tts/speak', 'POST', { text: 'forbidden' })).toThrow();
  });
  it('download ACK/read failure/read-only retry and fake delete are deterministic without browser globals', () => {
    const send = fixtureHost();
    expect(send('/api/dictation/status?provider=local').status).toBe(200);
    expect(send('/api/dictation/models/parakeet-tdt-0.6b-v2-int8/download', 'POST').body).toEqual({ ok: true, installed: false });
    expect(send('/api/dictation/status?provider=local').status).toBe(503);
    expect(send('/api/dictation/status?provider=local').body.models).toContainEqual(expect.objectContaining({ id: 'parakeet-tdt-0.6b-v2-int8', installed: true }));
    expect(() => send('/api/dictation/models/parakeet-tdt-0.6b-v2-int8/download', 'POST')).toThrow('must not replay');
    expect(send('/api/dictation/models/kokoro-en-v0_19', 'DELETE').body).toEqual({ ok: true });
    expect(send('/api/dictation/status?provider=local').body.ttsModels).toContainEqual(expect.objectContaining({ id: 'kokoro-en-v0_19', installed: false }));
  });
});

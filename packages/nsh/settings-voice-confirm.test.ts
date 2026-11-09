import { expect, test } from 'vitest';
import { parseSpeechSettings, speechDefaults, speechSecretFields, type SpeechSettings } from '../ui/src/lib/voice/speechSettings';
import { createSettingsVoiceConfirmation } from './settings-voice-confirm';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const settings = { ...speechDefaults, configured: true, browserVoice: 'Full authority browser', sayVoice: 'Full authority say' };
  const calls: Array<{ method: string; body?: unknown }> = [];
  let read: (() => Promise<unknown>) | null = null, write: (() => Promise<unknown>) | null = null, current = true, active = true;
  const send = async (path: string, method = 'GET', body?: unknown) => {
    if (path !== '/api/voice/settings' || !['GET', 'PUT'].includes(method)) throw new Error('Unexpected confirmation request');
    calls.push({ method, ...(body === undefined ? {} : { body }) });
    if (method === 'GET') return read ? read() : { ...settings, apiKey: '********' };
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid confirmation patch');
    for (const [key, value] of Object.entries(body)) {
      if (!(key in speechDefaults)) throw new Error('Unexpected confirmation field');
      if (speechSecretFields.has(key)) Object.assign(settings, { [key === 'apiKey' ? 'configured' : `${key}Configured`]: !!String(value).trim() });
      else Object.assign(settings, { [key]: typeof value === 'string' ? value.trim() : value });
    }
    return write ? write() : { ...settings };
  };
  const owner = createSettingsVoiceConfirmation({ send, current: () => current, active: () => active, changed() {} }); owner.activate(true);
  return { owner, settings, calls, read: (next: typeof read) => { read = next; }, write: (next: typeof write) => { write = next; },
    current: (next: boolean) => { current = next; }, active: (next: boolean) => { active = next; owner.activate(next); } };
}

test('the production owner saves the edited local manager values and returns complete parsed authority, not page-field projection', async () => {
  const h = fixture(); await h.owner.load();
  expect(h.owner.snapshot().data.apiKey).toBe('');
  h.owner.update('sttLocalModel', 'fixture-selected-model'); h.owner.update('localTtsVoiceId', '7'); h.owner.update('voiceProvider', 'say');
  const receipt = await h.owner.confirm('tts');
  expect(h.calls).toEqual([{ method: 'GET' }, { method: 'PUT', body: { sttLocalModel: 'fixture-selected-model', localTtsVoiceId: 7, voiceProvider: 'say' } }, { method: 'GET' }]);
  expect(receipt).toEqual({ settings: parseSpeechSettings(h.settings), draftRevision: 3 });
  expect(receipt!.settings).toMatchObject({ sayVoice: 'Full authority say', browserVoice: 'Full authority browser', configured: true, apiKey: '' });
  expect(h.owner.snapshot()).toMatchObject({ changes: {}, data: { sttLocalModel: 'fixture-selected-model', localTtsVoiceId: 7 } });
});

test('ACK followed by failed or incomplete GET can only retry GET; the secret clears only after complete confirmation', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', 'synthetic-new-key');
  h.read(async () => { throw new Error('Synthetic GET failed'); });
  await expect(h.owner.confirm('asr')).rejects.toThrow();
  expect(h.owner.pending()).toBe(true); expect(h.owner.dirty()).toBe(true);
  expect(h.owner.snapshot().data.apiKey).toBe('synthetic-new-key');
  h.read(async () => { const full: Partial<SpeechSettings> = { ...h.settings }; delete full.sttLanguage; return full; });
  await expect(h.owner.confirm('asr')).rejects.toThrow('Invalid speech settings');
  h.read(null); const receipt = await h.owner.confirm('asr');
  expect(h.owner.pending()).toBe(false); expect(h.owner.dirty()).toBe(false);
  expect(receipt!.settings.apiKey).toBe(''); expect(h.owner.snapshot().data.apiKey).toBe('');
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET', 'GET']);
});

test('real navigation dirtiness uses confirmed values, including reverted numeric input and explicit credential clearing', async () => {
  const h = fixture(); await h.owner.load(); expect(h.owner.dirty()).toBe(false);
  h.owner.update('speechRate', '1.25'); expect(h.owner.dirty()).toBe(true);
  h.owner.update('speechRate', String(h.settings.speechRate)); expect(h.owner.dirty()).toBe(false);
  h.owner.update('apiKey', ''); expect(h.owner.dirty()).toBe(true);
});

test.each([null, {}, true, { ok: true }])('unknown PUT ACK %j is never treated as a receipt or blindly replayed', async ack => {
  const h = fixture(); await h.owner.load(); h.owner.update('speechRate', '1.25'); h.write(async () => ack);
  await expect(h.owner.confirm('tts')).rejects.toThrow();
  expect(h.owner.snapshot().changes).toEqual({ speechRate: '1.25' });
  const receipt = await h.owner.confirm('tts');
  expect(receipt!.settings.speechRate).toBe(1.25);
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
});

test('a dropped PUT response with a credential stays unknown: configured:true cannot prove a replacement secret', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', 'synthetic-secret');
  h.write(async () => { throw new Error('Synthetic dropped response'); });
  await expect(h.owner.confirm('asr')).rejects.toThrow();
  await expect(h.owner.confirm('asr')).rejects.toThrow('voice-save-unconfirmed');
  await expect(h.owner.confirm('asr')).rejects.toThrow('voice-save-unconfirmed');
  expect(h.owner.snapshot().changes.apiKey).toBe('synthetic-secret');
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
});

test('a stale read cannot clear or mark clean a new draft, including a retyped identical secret', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', 'synthetic-secret'); h.owner.update('openaiApiKey', 'synthetic-other');
  const gate = deferred<unknown>(); h.read(() => gate.promise);
  const pending = h.owner.confirm('tts'); await flush();
  h.owner.update('apiKey', 'synthetic-secret'); h.owner.update('sttLocalModel', 'new-selection');
  gate.resolve({ ...h.settings }); expect(await pending).toBeNull();
  expect(h.owner.snapshot()).toMatchObject({ draftRevision: 4, changes: { apiKey: 'synthetic-secret', sttLocalModel: 'new-selection' }, data: { apiKey: 'synthetic-secret', openaiApiKey: '', sttLocalModel: 'new-selection' } });
  h.read(null); expect((await h.owner.confirm('asr'))!.draftRevision).toBe(4);
  expect(h.calls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ apiKey: 'synthetic-secret', openaiApiKey: 'synthetic-other' }, { apiKey: 'synthetic-secret', sttLocalModel: 'new-selection' }]);
});

test('editing while an ACK read is failing does not replay the old write or clear the newer secret', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', 'synthetic-old');
  h.read(async () => { throw new Error('Synthetic read failed'); }); await expect(h.owner.confirm('tts')).rejects.toThrow();
  h.owner.update('apiKey', 'synthetic-new'); h.read(null);
  expect(await h.owner.confirm('tts')).toBeNull(); expect(h.owner.snapshot().changes.apiKey).toBe('synthetic-new');
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  expect((await h.owner.confirm('tts'))!.draftRevision).toBe(2); expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(2);
});

test.each(['********', '••••••••', 'sk-****abcd', '<API_KEY>', '[API key]', 'your-api-key'])('mask/help text %s cannot become a real credential', async mask => {
  const h = fixture(); await h.owner.load(); h.owner.update('sttApiKey', mask);
  await expect(h.owner.confirm('asr')).rejects.toThrow('voice-secret-placeholder'); expect(h.calls).toEqual([{ method: 'GET' }]);
});

test('empty secret is an explicit clear, whereas public masks are never loaded into the editor', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', '');
  expect((await h.owner.confirm('tts'))!.settings.configured).toBe(false); expect(h.calls[1].body).toEqual({ apiKey: '' });
});

test.each(['host', 'hidden', 'dispose', 'hidden-resume'] as const)('%s fences late GET and prevents stale draft confirmation', async boundary => {
  const h = fixture(); await h.owner.load(); h.owner.update('speechRate', 1.2);
  const gate = deferred<unknown>(); h.read(() => gate.promise); const pending = h.owner.confirm('tts'); await flush();
  if (boundary === 'host') h.current(false);
  else if (boundary === 'dispose') h.owner.dispose();
  else { h.active(false); if (boundary === 'hidden-resume') h.active(true); }
  gate.resolve({ ...h.settings }); expect(await pending).toBeNull();
  if (boundary !== 'dispose') expect(h.owner.snapshot().changes).toEqual({ speechRate: 1.2 });
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

test('initial GET cannot overwrite a concurrently edited local model choice', async () => {
  const h = fixture(), gate = deferred<unknown>(); h.read(() => gate.promise); const load = h.owner.load();
  h.owner.update('sttLocalModel', 'new-manager-selection'); gate.resolve(h.settings); await load;
  expect(h.owner.snapshot()).toMatchObject({ ready: true, changes: { sttLocalModel: 'new-manager-selection' }, data: { sttLocalModel: 'new-manager-selection' } });
});

test('parallel confirmations cannot submit a duplicate PUT', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('speechRate', 1.2);
  const gate = deferred<unknown>(); h.read(() => gate.promise); const first = h.owner.confirm('tts'); await flush();
  expect(await h.owner.confirm('asr')).toBeNull(); gate.resolve(h.settings); expect(await first).not.toBeNull();
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

test('a known credential ACK received while covered is preserved, but only an active read can confirm it', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('apiKey', 'synthetic-secret');
  const ack = deferred<unknown>(); h.write(() => ack.promise); const pending = h.owner.confirm('asr'); await flush();
  h.active(false); ack.resolve({ ...h.settings }); expect(await pending).toBeNull();
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT']); expect(h.owner.snapshot().changes.apiKey).toBe('synthetic-secret');
  h.active(true); const receipt = await h.owner.confirm('asr'); expect(receipt!.settings.apiKey).toBe('');
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
});

test('late public authority that contradicts the acknowledged snapshot cannot certify or clear it', async () => {
  const h = fixture(); await h.owner.load(); h.owner.update('speechRate', 1.2); h.owner.update('apiKey', 'synthetic-secret');
  h.read(async () => ({ ...h.settings, speechRate: 0.75 }));
  await expect(h.owner.confirm('tts')).rejects.toThrow('voice-save-unconfirmed');
  expect(h.owner.snapshot().changes).toEqual({ speechRate: 1.2, apiKey: 'synthetic-secret' });
  h.read(null); expect(await h.owner.confirm('tts')).not.toBeNull();
  expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
});

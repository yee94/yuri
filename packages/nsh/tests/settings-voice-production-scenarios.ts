import type { App } from '../.nsh/types/nsh/test';

export type VoiceProductionAudit = {
  selected: string; runtimeScope: { hostID: string; lease: string }; requests: Array<{ hostID: string; path: string; resource: string; method: string; sequence: number; body?: unknown; expectedHost?: { hostID: string; lease: string } }>;
  writes: Array<{ hostID: string; path: string; resource: string; method: string; sequence: number; body: unknown }>;
  native: Array<{ name: string; hostID: string; input: Record<string, unknown> }>; nativeCounts: Record<string, number>;
  settings: Record<string, { speechRate: number; sttProvider: string; sttLocalModel: string; voiceProvider: string; showMessageTTSButtons: boolean }>;
  held: Array<{ lane: string; hostID: string }>; captures: Array<{ hostID: string; owner: string; revision: number; provider: string; cancelled: boolean }>;
  playback: Array<{ hostID: string; owner: string; revision: number; released: boolean }>; rejected: unknown[]; configurations: unknown[];
};
type Check = (value: unknown) => { toBe(value: unknown): void; toEqual(value: unknown): void; toHaveLength(value: number): void };
type Audit = () => VoiceProductionAudit;
type Scenario = (mode: 'fail-next-get' | 'placeholder-next-get' | 'hold-next-get' | 'unknown-next-put' | 'hold-segment' | 'hold-finish') => void;
type Release = (lane: 'get' | 'segment' | 'finish') => void;

/** Diagnostics only: public calls retain their original ordering, receivers and
 * assertions. NSH's overall case timeout bounds press/open; documented wait
 * options bound selectors. No timer, sleep, replacement UI or fake success. */
export function traceVoiceProductionApp(app: App, audit: Audit): App {
  let sequence = 0;
  const methods = new Set(['press', 'type', 'clear', 'waitFor', 'waitUntil', 'back', 'setLifecycle']);
  function wrap(target: object, name: string, work: (...args: unknown[]) => unknown) {
    return async (...args: unknown[]) => {
      const step = ++sequence, value = audit();
      const detail = name === 'type' ? [args[0], { characters: String(args[1]).length }] : args.map(item => typeof item === 'function' ? '[condition]' : item);
      console.log('voice-production-step:' + JSON.stringify({ step, event: 'begin', name, args: detail, selected: value.selected,
        requests: value.requests.length, writes: value.writes.length, native: value.native.at(-1)?.name ?? null, held: value.held, rejected: value.rejected }));
      try {
        const result = await work.apply(target, args);
        console.log('voice-production-step:' + JSON.stringify({ step, event: 'end', name }));
        return result;
      } catch (error) {
        console.log('voice-production-step:' + JSON.stringify({ step, event: 'failed', name, audit: audit(), texts: app.texts() }));
        throw error;
      }
    };
  }
  const host = app.host, send = wrap(host, 'host.send', host.send as (...args: unknown[]) => unknown);
  const observedHost = new Proxy(host, { get(target, key) { if (key === 'send') return send; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  return new Proxy(app, { get(target, key) {
    if (key === 'host') return observedHost;
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return typeof key === 'string' && methods.has(key) ? wrap(target, key, value) : value.bind(target);
  } });
}

/** Touch-visible Projects search -> the production command -> Settings -> Voice.
 * No initial Tab, route, Host state, component callback or settings injection. */
export async function openProductionVoice(app: App, check: Check) {
  await app.waitFor('id:projects-open-search');
  await app.press('id:projects-open-search');
  await app.waitFor('id:projects-global-search');
  await app.type('id:projects-global-search', 'Open Settings');
  check(app.value('id:projects-global-search')).toBe('Open Settings');
  await app.waitFor('id:projects-search-command:open-settings');
  await app.press('id:projects-search-command:open-settings');
  await app.waitFor('id:settings-search');
  check(app.texts().filter(text => text === 'Settings')).toHaveLength(0);
  await app.press('text:Voice');
  await app.waitUntil(() => app.enabled('id:settings-voice-preview') && app.enabled('id:settings-voice-asr-open'));
  check(app.count('id:settings-voice-preview')).toBe(1); check(app.count('id:settings-voice-asr-open')).toBe(1);
  for (const key of ['apiKey', 'sttApiKey', 'openaiApiKey', 'openaiCompatibleApiKey']) check(app.value('id:settings-basics-' + key)).toBe('');
}

/** Ordinary character-stream input; never paste, replace editors or invoke callbacks. */
export async function editProductionVoice(app: App, check: Check, key: string, value: string) {
  const selector = 'id:settings-basics-' + key;
  await app.waitUntil(() => app.enabled(selector)); await app.clear(selector); await app.type(selector, value);
  check(app.value(selector)).toBe(value);
}

export function checkVoiceNoExternalWork(app: App, audit: Audit, check: Check) {
  const result = audit();
  check(result.rejected).toEqual([]); check(app.requests()).toEqual([]); check(app.openedUrls()).toEqual([]);
  check(result.requests.filter(row => row.path === '/api/yuri/history-import/job')).toHaveLength(0);
  check(result.requests.filter(row => row.path.startsWith('/api/yuri/history-import/')).every(row => row.path === '/api/yuri/history-import/jobs' && row.resource === row.path && row.method === 'GET' && row.expectedHost?.hostID === row.hostID)).toBe(true);
  check(app.speechRequests()).toEqual([]); check(app.picks()).toEqual([]); check(app.host.posts()).toEqual([]);
  check(result.requests.filter(row => row.method !== 'GET').every(row => row.path === '/api/voice/settings' && row.method === 'PUT' && row.resource === row.path)).toBe(true);
  check(result.requests.filter(row => row.method !== 'GET').every(row => row.expectedHost?.hostID === row.hostID && typeof row.expectedHost.lease === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(row.expectedHost.lease))).toBe(true);
  check(result.native.filter(row => row.name === 'voiceRecognition.start').every(row => (row.input.expectedHost as { hostID?: string } | undefined)?.hostID === row.hostID && Object.keys(row.input).sort().join(',') === 'expectedHost,owner,provider,revision')).toBe(true);
  check(result.requests.filter(row => row.path.startsWith('/api/dictation/')).every(row => row.method === 'GET' && row.resource === '/api/dictation/status?provider=local')).toBe(true);
  check(result.native.every(row => /^(speech\.(prepare|segment|stop|release)|voiceRecognition\.(capabilities|start|finish|cancel))$/.test(row.name))).toBe(true);
  check(Object.keys(result.nativeCounts).some(name => /^(camera\.|notification\.(request|test)|native\.diagnostics\.(append|export|setEnabled)|connection\.connect)/.test(name))).toBe(false);
  check(JSON.stringify(app.storage()).includes('fixture-voice-key')).toBe(false);
  check(JSON.stringify(app.storage()).includes('fixture-old-key')).toBe(false);
  check(JSON.stringify(app.storage()).includes('fixture-new-key')).toBe(false);
  check(JSON.stringify(app.storage()).includes('fixture-unknown-key')).toBe(false);
}

export async function voiceBrowserPreview(app: App, audit: Audit, check: Check, scenario: Scenario) {
  await openProductionVoice(app, check);
  const host = audit().selected;
  check(audit().settings[host].voiceProvider).toBe('browser'); check(audit().settings[host].showMessageTTSButtons).toBe(false);
  await editProductionVoice(app, check, 'speechRate', '1.25'); await editProductionVoice(app, check, 'apiKey', 'fixture-voice-key');
  scenario('hold-segment');
  // NSH serves one handler to completion per public call. Keep this public
  // action live while another public step drives Stop; never resolve the held
  // handler in advance or replace the production controller's pending promise.
  const pressing = app.press('id:settings-voice-preview'); void pressing.catch(() => {});
  await app.waitUntil(() => audit().held.some(row => row.lane === 'segment'));
  const segment = audit().native.filter(row => row.name === 'speech.segment').at(-1)!;
  check(segment.input.source).toBe('settings-preview'); check(segment.input.text).toBe("Hello! I'm Fixture browser authority. This is how I sound.");
  await app.host.send('speech.playing', { owner: segment.input.owner, revision: segment.input.revision });
  await app.waitFor('label:Stop');
  check(audit().writes.map(row => row.body)).toEqual([{ speechRate: 1.25, apiKey: 'fixture-voice-key' }]);
  const wire = audit().requests.filter(row => row.path === '/api/voice/settings');
  check(wire.map(row => row.method)).toEqual(['GET', 'PUT', 'GET']);
  check(app.value('id:settings-basics-apiKey')).toBe(''); check(app.value('id:settings-basics-speechRate')).toBe('1.25');
  await app.press('id:settings-voice-preview'); await app.waitUntil(() => audit().playback.every(row => row.released));
  await pressing;
  check(audit().native.filter(row => row.name.startsWith('speech.')).map(row => row.name)).toEqual(['speech.prepare', 'speech.segment', 'speech.stop', 'speech.release']);
  await app.waitFor('label:Preview'); checkVoiceNoExternalWork(app, audit, check);
  await app.back(); await app.waitFor('id:settings-search'); check(app.shows('id:settings-voice-preview')).toBe(false);
}

export async function voiceAckReadRetry(app: App, audit: Audit, check: Check, scenario: Scenario) {
  await openProductionVoice(app, check); await editProductionVoice(app, check, 'apiKey', 'fixture-old-key');
  scenario('fail-next-get'); await app.press('id:settings-basics-save');
  await app.waitUntil(() => app.enabled('id:settings-basics-save'));
  check(app.value('id:settings-basics-apiKey')).toBe('fixture-old-key');
  check(audit().native.filter(row => row.name === 'speech.prepare')).toHaveLength(0);
  check(audit().requests.filter(row => row.path === '/api/voice/settings').map(row => row.method)).toEqual(['GET', 'PUT', 'GET']);
  await app.press('id:settings-voice-preview'); await app.waitUntil(() => audit().native.some(row => row.name === 'speech.release'));
  check(app.value('id:settings-basics-apiKey')).toBe(''); check(audit().writes.map(row => row.body)).toEqual([{ apiKey: 'fixture-old-key' }]);
  check(audit().requests.filter(row => row.path === '/api/voice/settings').map(row => row.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
  checkVoiceNoExternalWork(app, audit, check);
}

export async function voiceNewEditFence(app: App, audit: Audit, check: Check, scenario: Scenario) {
  await openProductionVoice(app, check); await editProductionVoice(app, check, 'apiKey', 'fixture-old-key');
  scenario('fail-next-get'); await app.press('id:settings-basics-save'); await app.waitUntil(() => app.enabled('id:settings-basics-apiKey'));
  await editProductionVoice(app, check, 'apiKey', 'fixture-new-key');
  // Reconcile the old ACK through the real Preview action. It cannot clear the
  // edited key or produce an audio receipt for this newer draft.
  await app.press('id:settings-voice-preview'); await app.waitFor('id:settings-voice-preview-error');
  check(app.value('id:settings-basics-apiKey')).toBe('fixture-new-key');
  check(audit().native.filter(row => row.name === 'speech.prepare')).toHaveLength(0);
  check(audit().writes.map(row => row.body)).toEqual([{ apiKey: 'fixture-old-key' }]);
  await app.press('id:settings-voice-preview'); await app.waitUntil(() => audit().native.some(row => row.name === 'speech.release'));
  check(audit().writes.map(row => row.body)).toEqual([{ apiKey: 'fixture-old-key' }, { apiKey: 'fixture-new-key' }]);
  check(app.value('id:settings-basics-apiKey')).toBe(''); checkVoiceNoExternalWork(app, audit, check);
}

export async function voiceUnconfirmedReceipt(app: App, audit: Audit, check: Check, scenario: Scenario, unknownAck: boolean) {
  await openProductionVoice(app, check);
  await editProductionVoice(app, check, unknownAck ? 'apiKey' : 'speechRate', unknownAck ? 'fixture-unknown-key' : '1.5');
  scenario(unknownAck ? 'unknown-next-put' : 'placeholder-next-get');
  await app.press('id:settings-voice-preview'); await app.waitFor('id:settings-voice-preview-error');
  check(audit().native.filter(row => row.name === 'speech.prepare')).toHaveLength(0); check(audit().writes).toHaveLength(1);
  await app.press('id:settings-voice-preview');
  if (unknownAck) {
    await app.waitFor('id:settings-voice-preview-error'); check(app.value('id:settings-basics-apiKey')).toBe('fixture-unknown-key');
    check(audit().native.filter(row => row.name === 'speech.prepare')).toHaveLength(0);
    check(audit().requests.filter(row => row.path === '/api/voice/settings').map(row => row.method)).toEqual(['GET', 'PUT', 'GET']);
  } else {
    await app.waitUntil(() => audit().native.some(row => row.name === 'speech.release'));
    check(app.value('id:settings-basics-speechRate')).toBe('1.5');
    check(audit().requests.filter(row => row.path === '/api/voice/settings').map(row => row.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
  }
  check(audit().writes).toHaveLength(1); checkVoiceNoExternalWork(app, audit, check);
}

export async function voiceModelSelection(app: App, audit: Audit, check: Check) {
  await openProductionVoice(app, check); await app.waitUntil(() => app.enabled('id:voice-local-select-whisper-base-int8'));
  await app.press('id:voice-local-select-whisper-base-int8'); await app.press('id:settings-basics-save');
  await app.waitUntil(() => audit().writes.length === 1 && app.enabled('id:settings-basics-save'));
  check(audit().writes.map(row => row.body)).toEqual([{ sttLocalModel: 'whisper-base-int8' }]);
  check(audit().settings[audit().selected].sttLocalModel).toBe('whisper-base-int8');
  await app.back(); await app.waitFor('id:settings-search'); await app.press('text:Voice');
  await app.waitUntil(() => app.enabled('id:settings-voice-preview')); await app.press('id:settings-basics-save');
  check(audit().writes).toHaveLength(1); checkVoiceNoExternalWork(app, audit, check);
}

export async function startProductionAsr(app: App, audit: Audit, check: Check) {
  await app.waitUntil(() => app.enabled('id:settings-voice-asr-open')); await app.press('id:settings-voice-asr-open');
  await app.waitFor('id:settings-voice-asr-dialog'); await app.waitUntil(() => app.enabled('id:settings-voice-asr-primary'));
  const before = audit().native.filter(row => row.name === 'voiceRecognition.start').length;
  await app.press('id:settings-voice-asr-primary');
  await app.waitUntil(() => audit().native.filter(row => row.name === 'voiceRecognition.start').length === before + 1);
  await app.waitFor('label:Stop and transcribe');
  const start = audit().native.filter(row => row.name === 'voiceRecognition.start').at(-1)!;
  check(start.input.provider).toBe(audit().settings[audit().selected].sttProvider); check(app.speechRequests()).toEqual([]);
  return start;
}

export async function voiceLiteralAsr(app: App, audit: Audit, check: Check) {
  await openProductionVoice(app, check); const start = await startProductionAsr(app, audit, check);
  const literal = '**literal**\n<script>not HTML</script> [not a link](https://example.invalid)\n中文 🎤';
  await app.host.send('voiceRecognition.partial', { owner: start.input.owner, revision: start.input.revision, text: literal });
  await app.waitUntil(() => app.texts().join('\n').includes(literal));
  await app.press('id:settings-voice-asr-primary');
  await app.waitUntil(() => app.texts().join('\n').includes('Primary ' + literal));
  check(audit().native.filter(row => row.name.startsWith('voiceRecognition.')).map(row => row.name)).toEqual(['voiceRecognition.capabilities', 'voiceRecognition.start', 'voiceRecognition.finish', 'voiceRecognition.cancel']);
  check(audit().captures.every(row => row.cancelled)).toBe(true); check(audit().writes).toEqual([]);
  await app.back(); await app.waitFor('id:settings-voice-asr-dialog', { state: 'gone' });
  checkVoiceNoExternalWork(app, audit, check);
}

export async function voiceStopCloseInvalidated(app: App, audit: Audit, check: Check) {
  await openProductionVoice(app, check); const first = await startProductionAsr(app, audit, check);
  await app.back(); await app.waitFor('id:settings-voice-asr-dialog', { state: 'gone' });
  await app.waitUntil(() => audit().captures.every(row => row.cancelled));
  const second = await startProductionAsr(app, audit, check);
  await app.host.send('voiceRecognition.partial', { owner: first.input.owner, revision: first.input.revision, text: 'STALE old capture' });
  await app.host.send('voiceRecognition.invalidated', { owner: second.input.owner, revision: Number(second.input.revision) + 1 });
  check(app.shows('id:settings-voice-asr-dialog')).toBe(true); check(app.texts().join('\n').includes('STALE old capture')).toBe(false);
  await app.host.send('voiceRecognition.invalidated', { owner: second.input.owner, revision: second.input.revision });
  await app.waitFor('id:settings-voice-asr-dialog', { state: 'gone' }); await app.waitUntil(() => audit().captures.every(row => row.cancelled));
  await app.press('id:settings-voice-asr-open'); await app.waitFor('id:settings-voice-asr-dialog');
  check(app.shows('id:settings-voice-asr-transcript')).toBe(false);
  await app.back(); check(audit().writes).toEqual([]); checkVoiceNoExternalWork(app, audit, check);
}

export async function voiceLifecycleFence(app: App, audit: Audit, check: Check, scenario: Scenario, release: Release) {
  await openProductionVoice(app, check); scenario('hold-segment');
  const previewing = app.press('id:settings-voice-preview'); void previewing.catch(() => {});
  await app.waitUntil(() => audit().held.some(row => row.lane === 'segment'));
  const segment = audit().native.filter(row => row.name === 'speech.segment').at(-1)!;
  await app.setLifecycle('background'); await app.waitUntil(() => audit().playback.every(row => row.released));
  await previewing;
  await app.host.send('speech.playing', { owner: segment.input.owner, revision: segment.input.revision });
  await app.setLifecycle('active'); await app.waitUntil(() => app.enabled('id:settings-voice-preview'));
  check(audit().native.filter(row => row.name === 'speech.segment')).toHaveLength(1); await app.waitFor('label:Preview');
  const start = await startProductionAsr(app, audit, check); scenario('hold-finish');
  const finishing = app.press('id:settings-voice-asr-primary'); void finishing.catch(() => {});
  await app.waitUntil(() => audit().held.some(row => row.lane === 'finish'));
  await app.setLifecycle('background'); await app.waitUntil(() => audit().captures.every(row => row.cancelled));
  release('finish'); await finishing;
  await app.host.send('voiceRecognition.partial', { owner: start.input.owner, revision: start.input.revision, text: 'STALE background capture' });
  await app.setLifecycle('active'); await app.waitUntil(() => app.enabled('id:settings-voice-asr-open'));
  check(app.shows('id:settings-voice-asr-dialog')).toBe(false); check(app.texts().join('\n').includes('STALE background capture')).toBe(false);
  await app.press('id:settings-voice-asr-open'); await app.waitFor('id:settings-voice-asr-dialog'); check(app.shows('id:settings-voice-asr-transcript')).toBe(false);
  await app.back(); check(audit().writes).toEqual([]); checkVoiceNoExternalWork(app, audit, check);
}

export async function switchProductionVoiceHost(app: App, audit: Audit, check: Check) {
  await app.host.send('connection.link', { url: 'synthetic-voice-cover-only' }); await app.waitFor('id:pairing-link');
  check(app.shows('id:settings-voice-asr-dialog')).toBe(false);
  await app.press('text:Secondary synthetic Voice Host');
  await app.waitUntil(() => audit().selected === 'voice-production-secondary' && app.shows('id:projects-open-search'));
  check(audit().nativeCounts['connection.connect'] ?? 0).toBe(0);
}

export async function voiceHostFence(app: App, audit: Audit, check: Check, scenario: Scenario, release: Release, heldRead: boolean) {
  await openProductionVoice(app, check);
  let old: Record<string, unknown> | null = null;
  let pending: Promise<void>;
  if (heldRead) { scenario('hold-next-get'); pending = app.press('id:settings-voice-preview'); void pending.catch(() => {}); await app.waitUntil(() => audit().held.some(row => row.lane === 'get')); }
  else { old = (await startProductionAsr(app, audit, check)).input; scenario('hold-finish'); pending = app.press('id:settings-voice-asr-primary'); void pending.catch(() => {}); await app.waitUntil(() => audit().held.some(row => row.lane === 'finish')); }
  await switchProductionVoiceHost(app, audit, check);
  release(heldRead ? 'get' : 'finish');
  await pending;
  if (old) await app.host.send('voiceRecognition.partial', { owner: old.owner, revision: old.revision, text: 'STALE retired Host' });
  await openProductionVoice(app, check); check(app.value('id:settings-basics-speechRate')).toBe('0.75');
  check(audit().native.filter(row => row.name === 'speech.prepare')).toHaveLength(0);
  check(app.texts().join('\n').includes('STALE retired Host')).toBe(false);
  if (!heldRead) {
    const next = await startProductionAsr(app, audit, check); check(next.input.provider).toBe('openai-compatible');
    await app.press('id:settings-voice-asr-primary');
    await app.waitUntil(() => app.texts().join('\n').includes('Secondary **literal**'));
    check(app.texts().join('\n').includes('Primary **literal**')).toBe(false); await app.back();
  }
  check(audit().captures.every(row => row.cancelled)).toBe(true); check(audit().writes).toEqual([]); checkVoiceNoExternalWork(app, audit, check);
}

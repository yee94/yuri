import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseSpeechSettings, speechDefaults, speechSecretFields } from '../ui/src/lib/voice/speechSettings';
import { createSettingsVoiceConfirmation } from './settings-voice-confirm';
import { createSettingsVoiceRecognitionAdapter } from './settings-voice-recognition';
import type { RuntimeScope } from './runtime-scope';
import { voiceProductionCapabilities, withVoiceProductionFixture } from './tests/settings-voice-production-runner.mjs';
import { traceVoiceProductionApp, openProductionVoice, editProductionVoice, checkVoiceNoExternalWork, voiceBrowserPreview, voiceAckReadRetry, voiceNewEditFence, voiceUnconfirmedReceipt, voiceModelSelection, startProductionAsr, voiceLiteralAsr, voiceStopCloseInvalidated, voiceLifecycleFence, switchProductionVoiceHost, voiceHostFence, type VoiceProductionAudit } from './tests/settings-voice-production-scenarios';

const root = path.dirname(fileURLToPath(import.meta.url));
type Fixture = { directory: string; entry: string; host: string };
type Host = { call(name: string, input: unknown): unknown };
const primary = 'settings-navigation-production', secondary = 'voice-production-secondary';
const literal = '**literal**\n<script>not HTML</script> [not a link](https://example.invalid)\n中文 🎤';
const owner = 'settings-voice-1', audioOwner = 'settings-voice-1-1';
const previewText = "Hello! I'm Fixture browser authority. This is how I sound.";
function evaluateHost(fixture: Fixture) {
  const artifact = readFileSync(fixture.host, 'utf8');
  const syntax = ts.createSourceFile(fixture.host, artifact, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
  const output = ts.transpileModule(artifact, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
  expect(output.diagnostics ?? []).toEqual([]);
  const context = vm.createContext({}), exports: Record<string, unknown> = {};
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams + ":" + typeof fetch + ":" + typeof require', context)).toBe('undefined:undefined:undefined:undefined');
  vm.runInContext(`(function(exports) { ${output.outputText}\n})`, context)(exports);
  const host = (exports.createHost as () => Host)();
  const audit = () => host.call('voiceProduction.fixture.audit', {}) as VoiceProductionAudit;
  const scenario = (mode: string) => host.call('voiceProduction.fixture.scenario', { mode });
  const release = (lane: string) => host.call('voiceProduction.fixture.release', { lane });
  const expectedHost = Object.freeze({ ...(host.call('connection.list', {}) as { runtimeScope: RuntimeScope }).runtimeScope });
  const bindSend = (scope: RuntimeScope) => {
    const captured = Object.freeze({ ...scope });
    return async (resource: string, method = 'GET', body?: unknown) => {
      const result = await host.call('runtime.request', { path: resource, method, ...(body === undefined ? {} : { body }), expectedHost: captured }) as { status: number; body: unknown };
      if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('Synthetic HTTP ' + result.status), { status: result.status });
      return result.body;
    };
  };
  const send = bindSend(expectedHost);
  return { host, send, bindSend, expectedHost, audit, scenario, release };
}
const isolatedHost = (): ReturnType<typeof evaluateHost> => withVoiceProductionFixture(root, (fixture: Fixture) => evaluateHost(fixture));

describe('Voice production strict synthetic Host (pure VM, not engine navigation evidence)', () => {
  it('serves only the exact scoped read-only background history jobs snapshot once per request on each actual Host', async () => {
    const { host, send, bindSend, expectedHost, audit } = isolatedHost();
    const path = '/api/yuri/history-import/jobs';
    expect(await send(path)).toEqual([]);
    const selected = host.call('connection.select', { id: secondary }) as { runtimeScope: RuntimeScope };
    const other = bindSend(selected.runtimeScope);
    expect(await other(path)).toEqual([]);
    expect(audit().requests.map(row => [row.hostID, row.resource, row.method, row.expectedHost])).toEqual([
      [primary, path, 'GET', expectedHost], [secondary, path, 'GET', selected.runtimeScope],
    ]);
    expect(audit().writes).toEqual([]); expect(audit().native).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it('history monitor reads reject missing/stale/extra scope, queries, bodies, related routes and every import mutation without prefix fallback', async () => {
    const { host, send, expectedHost, audit } = isolatedHost();
    let failures = 0;
    for (const path of ['/api/yuri/history-import/jobs']) {
      for (const scope of [undefined, null, { hostID: secondary, lease: expectedHost.lease }, { hostID: primary, lease: 'retired' }, { ...expectedHost, extra: true }]) {
        expect(() => host.call('runtime.request', { path, method: 'GET', ...(scope === undefined ? {} : { expectedHost: scope }) })).toThrow(); failures++;
      }
      for (const suffix of ['?', '?id=synthetic', '?directory=%2Ffixture%2Fsecond', '?limit=1', '?hostID=' + primary, '/extra']) {
        await expect(send(path + suffix)).rejects.toThrow(); failures++;
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) { await expect(send(path, method, {})).rejects.toThrow(); failures++; }
      for (const body of [undefined, null, {}]) {
        expect(() => host.call('runtime.request', { path, method: 'GET', body, expectedHost })).toThrow(); failures++;
      }
    }
    for (const route of ['scan', 'imported', 'preview', 'start', 'resume', 'dismiss', 'cancel']) {
      await expect(send('/api/yuri/history-import/' + route, 'POST', { confirm: true })).rejects.toThrow(); failures++;
    }
    for (const suffix of ['', '?id=synthetic']) { await expect(send('/api/yuri/history-import/job' + suffix)).rejects.toThrow(); failures++; }
    host.call('connection.select', { id: secondary });
    await expect(send('/api/yuri/history-import/jobs')).rejects.toThrow('scope_mismatch'); failures++;
    expect(audit().rejected).toHaveLength(failures); expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]); expect(audit().native).toEqual([]);
  });

  it('returns complete public settings with configured flags, not editable credentials, and a precise disabled diagnostics v2 response', async () => {
    const { host, send, audit } = isolatedHost();
    const publicSettings = await send('/api/voice/settings') as Record<string, unknown>;
    const parsed = parseSpeechSettings(publicSettings);
    expect(parsed).toMatchObject({ voiceProvider: 'browser', showMessageTTSButtons: false, dictationEnabled: false, sttProvider: 'local', configured: true, sttApiKeyConfigured: true, apiKey: '' });
    for (const key of Object.keys(speechDefaults).filter(key => !speechSecretFields.has(key))) expect(publicSettings).toHaveProperty(key);
    expect(publicSettings.apiKey).toBe('********'); for (const key of speechSecretFields) expect(parsed[key as keyof typeof parsed]).toBe('');
    expect(host.call('native.diagnostics.status', {})).toEqual({ schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 });
    expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it.each([
    { speechRate: 1.25, apiKey: 'fixture-voice-key' }, { apiKey: 'fixture-old-key' }, { apiKey: 'fixture-new-key' },
    { apiKey: 'fixture-unknown-key' }, { speechRate: 1.5 }, { sttLocalModel: 'whisper-base-int8' },
  ])('allows only the exact planned PUT shape %j and returns a full public ACK followed by authority GET', async patch => {
    const { send, audit } = isolatedHost();
    parseSpeechSettings(await send('/api/voice/settings', 'PUT', patch));
    const full = parseSpeechSettings(await send('/api/voice/settings'));
    expect(audit().writes.map(row => [row.hostID, row.method, row.resource, row.body])).toEqual([[primary, 'PUT', '/api/voice/settings', patch]]);
    expect(full.apiKey).toBe(''); expect(audit().rejected).toEqual([]);
  });

  it('uses the production save owner against this actual strict Host: ACK/read failure retries GET only, without helper-save mocks', async () => {
    const { send, audit, scenario } = isolatedHost();
    const controller = createSettingsVoiceConfirmation({ send, current: () => true, active: () => true, changed() {} }); controller.activate(true); await controller.load();
    expect(controller.snapshot().data.apiKey).toBe(''); controller.update('apiKey', 'fixture-old-key'); scenario('fail-next-get');
    await expect(controller.confirm('tts')).rejects.toThrow('Synthetic HTTP 502'); expect(controller.snapshot().changes.apiKey).toBe('fixture-old-key');
    const receipt = await controller.confirm('tts'); expect(receipt!.settings).toEqual(parseSpeechSettings(audit().settings[primary]));
    expect(audit().requests.filter(row => row.path === '/api/voice/settings').map(row => row.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
    expect(controller.snapshot().changes).toEqual({}); expect(audit().rejected).toEqual([]); controller.dispose();
  });

  it('new input after a failed read keeps the old receipt from clearing/certifying the new production draft', async () => {
    const { send, audit, scenario } = isolatedHost();
    const controller = createSettingsVoiceConfirmation({ send, current: () => true, active: () => true, changed() {} }); controller.activate(true); await controller.load();
    controller.update('apiKey', 'fixture-old-key'); scenario('fail-next-get'); await expect(controller.confirm('tts')).rejects.toThrow();
    controller.update('apiKey', 'fixture-new-key'); expect(await controller.confirm('tts')).toBeNull(); expect(controller.snapshot().changes.apiKey).toBe('fixture-new-key');
    expect(audit().writes.map(row => row.body)).toEqual([{ apiKey: 'fixture-old-key' }]);
    expect((await controller.confirm('tts'))!.draftRevision).toBe(2); expect(audit().writes.map(row => row.body)).toEqual([{ apiKey: 'fixture-old-key' }, { apiKey: 'fixture-new-key' }]);
    expect(audit().rejected).toEqual([]); controller.dispose();
  });

  it('unknown credential ACK is not a receipt, even after a full GET says configured:true; no PUT replay', async () => {
    const { send, audit, scenario, host } = isolatedHost();
    const controller = createSettingsVoiceConfirmation({ send, current: () => true, active: () => true, changed() {} }); controller.activate(true); await controller.load();
    controller.update('apiKey', 'fixture-unknown-key'); scenario('unknown-next-put'); await expect(controller.confirm('asr')).rejects.toThrow();
    await expect(controller.confirm('asr')).rejects.toThrow('voice-save-unconfirmed');
    expect(audit().writes).toHaveLength(1); expect(controller.snapshot().changes.apiKey).toBe('fixture-unknown-key');
    expect(audit().native).toEqual([]);
    expect(() => host.call('speech.prepare', { owner: audioOwner })).toThrow('without a complete confirmed GET'); controller.dispose();
  });

  it('a false/configured-only public placeholder never counts as a complete receipt or permits native prepare', async () => {
    const { send, audit, scenario, host } = isolatedHost();
    await send('/api/voice/settings', 'PUT', { speechRate: 1.5 }); scenario('placeholder-next-get');
    expect(() => parseSpeechSettings({ configured: false })).toThrow(); expect(() => host.call('speech.prepare', { owner: audioOwner })).toThrow();
    const placeholder = await send('/api/voice/settings'); expect(() => parseSpeechSettings(placeholder)).toThrow();
    expect(() => host.call('speech.prepare', { owner: audioOwner })).toThrow();
    parseSpeechSettings(await send('/api/voice/settings')); expect(host.call('speech.prepare', { owner: audioOwner })).toMatchObject({ visible: false, provider: 'browser' });
    expect(audit().writes).toHaveLength(1);
  });

  it('speech fake enforces settings-preview source/text/owner/revision, and Stop settles the same held segment before release', async () => {
    const { host, send, audit, scenario } = isolatedHost(); await send('/api/voice/settings');
    expect(host.call('speech.prepare', { owner: audioOwner })).toEqual({ provider: 'browser', visible: false, mode: 'final' });
    scenario('hold-segment'); const held = host.call('speech.segment', { owner: audioOwner, revision: 1, source: 'settings-preview', text: previewText });
    expect(audit().held).toEqual([{ lane: 'segment', hostID: primary }]);
    host.call('speech.stop', { owner: audioOwner, revision: 2 }); await expect(held).resolves.toBeNull(); host.call('speech.release', { owner: audioOwner });
    expect(audit().playback).toEqual([{ hostID: primary, owner: audioOwner, revision: 2, released: true }]); expect(audit().rejected).toEqual([]);
    expect(() => host.call('speech.segment', { owner: audioOwner, revision: 3, source: 'manual', text: previewText })).toThrow();
    expect(() => host.call('speech.stop', { owner: audioOwner, revision: 1 })).toThrow();
  });

  it('the real configured ASR adapter consumes exact capabilities/lease/final literal text and never touches NSH system Speech', async () => {
    const { host, send, audit, expectedHost } = isolatedHost(); await send('/api/voice/settings');
    const adapter = await createSettingsVoiceRecognitionAdapter({ expectedHost, call: async (name, input) => host.call(name, input), current: () => true, on: () => () => {} });
    expect(adapter.supports('local')).toBe(true); const capture = await adapter.start({ owner, revision: 1, provider: 'local', partial() {} });
    expect(await capture.finish()).toEqual({ text: 'Primary ' + literal }); await capture.cancel(); await adapter.dispose();
    expect(audit().native.map(row => row.name)).toEqual(['voiceRecognition.capabilities', 'voiceRecognition.start', 'voiceRecognition.finish', 'voiceRecognition.cancel']);
    expect(audit().captures).toEqual([{ owner, revision: 1, provider: 'local', hostID: primary, cancelled: true }]); expect(audit().rejected).toEqual([]);
  });

  it('held GET/final responses retain their captured old Host and cannot authorize audio for the selected replacement Host', async () => {
    const { host, send, bindSend, expectedHost, audit, scenario, release } = isolatedHost();
    scenario('hold-next-get'); const read = send('/api/voice/settings');
    expect(() => host.call('speech.prepare', { owner: audioOwner })).toThrow();
    release('get'); await read;
    host.call('voiceRecognition.start', { owner, revision: 1, provider: 'local', expectedHost }); scenario('hold-finish');
    const finishing = host.call('voiceRecognition.finish', { owner, revision: 1 });
    scenario('hold-next-get'); const oldRead = send('/api/voice/settings'); host.call('connection.select', { id: secondary });
    release('get'); release('finish');
    expect(parseSpeechSettings(await oldRead).speechRate).toBe(1); await expect(finishing).resolves.toEqual({ text: 'Primary ' + literal });
    expect(() => host.call('speech.prepare', { owner: 'settings-voice-2-1' })).toThrow();
    host.call('voiceRecognition.cancel', { owner, revision: 1 });
    expect(parseSpeechSettings(await bindSend(audit().runtimeScope)('/api/voice/settings')).speechRate).toBe(0.75);
    expect(audit().settings[secondary].sttProvider).toBe('openai-compatible'); expect(audit().writes).toEqual([]);
  });

  it('root bootstrap allows only read-only preferences/diagnostics, and unknown/malformed/scoped calls stay rejected', async () => {
    const { host, send, audit } = isolatedHost(); await send('/api/config/settings');
    expect(host.call('native.diagnostics.status', {})).toMatchObject({ schemaVersion: 2, enabled: false, recordingLease: null });
    const invalid = [
      ['/api/voice/settings?directory=%2Ffixture%2Fsecond', 'GET'], ['/api/voice/settings?', 'GET'], ['/api/voice/settings#fragment', 'GET'],
      ['https://external.example.invalid/api/voice/settings', 'GET'], ['/api/voice/settings', 'GET', {}], ['/api/voice/settings', 'POST', {}],
      ['/api/voice/settings', 'PUT', { speechRate: 1.25 }], ['/api/voice/settings', 'PUT', { apiKey: '********' }],
      ['/api/voice/settings', 'PUT', { apiKey: 'fixture-old-key', configured: true }], ['/api/voice/settings', 'PUT', { apiKey: 'fixture-old-key', directory: '/fixture/second' }],
      ['/api/dictation/status?provider=system', 'GET'], ['/api/dictation/status?provider=local&provider=local', 'GET'],
      ['/api/dictation/models/whisper-base-int8/download', 'POST'], ['/api/tts/speak', 'POST', { text: 'forbidden' }],
      ['/api/config/settings', 'PUT', {}], ['/api/session/ses_actual', 'DELETE'], ['/api/yuri/sessions/ses_actual/archive', 'PUT', { archivedAt: 1 }], ['/api/unknown', 'GET'],
    ] as Array<[string, string, unknown?]>;
    for (const args of invalid) await expect(send(...args)).rejects.toThrow();
    const native = [
      ['native.diagnostics.status', { enabled: false }], ['native.diagnostics.append', {}], ['native.diagnostics.export', {}], ['native.diagnostics.setEnabled', {}],
      ['voiceRecognition.capabilities', { provider: 'local' }], ['voiceRecognition.start', { owner, revision: 1, provider: 'system' }],
      ['voiceRecognition.start', { owner, revision: 1, provider: 'local', apiKey: 'fixture-old-key' }], ['voiceRecognition.cancel', { owner, revision: 99 }],
      ['speech.prepare', { owner: audioOwner, provider: 'browser' }], ['speech.awake', {}], ['Speech.start', {}], ['camera.scan', {}], ['connection.connect', {}], ['notification.request', {}], ['unknown.call', {}],
    ] as Array<[string, unknown]>;
    for (const [name, input] of native) expect(() => host.call(name, input)).toThrow();
    expect(audit().rejected).toHaveLength(invalid.length + native.length); expect(audit().writes).toEqual([]);
  });

  it('test controls cannot inject settings, clear rejected evidence, obtain capabilities or select arbitrary Hosts', () => {
    const { host, audit } = isolatedHost();
    for (const input of [undefined, null, false, [], { reset: true }]) expect(() => host.call('voiceProduction.fixture.audit', input)).toThrow();
    expect(() => host.call('voiceProduction.fixture.scenario', { mode: 'ok', settings: {} })).toThrow();
    expect(() => host.call('voiceProduction.fixture.scenario', { mode: 'ok' })).toThrow();
    expect(() => host.call('voiceProduction.fixture.release', { lane: 'settings' })).toThrow();
    expect(() => host.call('connection.select', { id: 'unknown' })).toThrow();
    expect(audit().selected).toBe(primary); expect(audit().rejected).toHaveLength(9);
  });

  it('Native admission rejects missing/mismatched/extra scope before HTTP writes, TTS or ASR fake work; same-Host lease rotation also retires captured senders', async () => {
    const { host, send, audit, expectedHost } = isolatedHost(); await send('/api/voice/settings');
    const invalid = [undefined, null, { hostID: primary, lease: 'wrong' }, { hostID: secondary, lease: expectedHost.lease }, { ...expectedHost, extra: true }];
    for (const scope of invalid) {
      expect(() => host.call('runtime.request', { path: '/api/voice/settings', method: 'PUT', body: { apiKey: 'fixture-old-key' }, ...(scope === undefined ? {} : { expectedHost: scope }) })).toThrow();
      expect(() => host.call('voiceRecognition.start', { owner, revision: 1, provider: 'local', ...(scope === undefined ? {} : { expectedHost: scope }) })).toThrow();
    }
    const snapshot = host.call('connection.select', { id: primary }) as { runtimeScope: RuntimeScope };
    expect(snapshot.runtimeScope.hostID).toBe(primary); expect(snapshot.runtimeScope.lease).not.toBe(expectedHost.lease);
    await expect(send('/api/voice/settings', 'PUT', { apiKey: 'fixture-old-key' })).rejects.toThrow('scope_mismatch');
    expect(() => host.call('voiceRecognition.start', { owner, revision: 1, provider: 'local', expectedHost })).toThrow('scope_mismatch');
    expect(audit().writes).toEqual([]); expect(audit().native).toEqual([]); expect(audit().captures).toEqual([]); expect(audit().playback).toEqual([]);
    expect(audit().rejected).toHaveLength(invalid.length * 2 + 2);
  });
});

it('isolates the real production App/config/Storage identity and only cleans its own temporary artifacts', () => {
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8'); let first = '', second = '';
  withVoiceProductionFixture(root, (fixture: Fixture) => {
    first = fixture.directory; const config = JSON.parse(readFileSync(path.join(first, 'nsh.json'), 'utf8'));
    expect(config.id).toMatch(/^example\.yuri\.voice-production\./); expect(config.capabilities.host).toEqual(voiceProductionCapabilities);
    expect(config.capabilities).not.toHaveProperty('speech'); expect(config.capabilities.host.some((name: string) => name.includes('*') || name.startsWith('voiceProduction.'))).toBe(false);
    for (const name of ['connection.connect', 'speech.awake', 'camera.scan', 'notification.request', 'native.diagnostics.append']) expect(config.capabilities.host).not.toContain(name);
    expect(readFileSync(path.join(first, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    expect(existsSync(path.join(first, 'RootSettings.tsx'))).toBe(false);
  });
  expect(existsSync(first)).toBe(false);
  expect(() => withVoiceProductionFixture(root, (fixture: Fixture) => { second = fixture.directory; throw new Error('Deliberate Voice fixture failure'); })).toThrow('Deliberate Voice fixture failure');
  expect(first).not.toBe(second); expect(existsSync(second)).toBe(false); expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
});

const engineCases = ['browser-preview', 'ack-read-retry', 'new-edit-fence', 'placeholder-receipt', 'unknown-ack', 'local-model', 'literal-asr', 'stop-close-invalidated', 'lifecycle', 'host-fence', 'host-read-fence'] as const;
type EngineCase = typeof engineCases[number];
function engineScript(testCase: EngineCase) {
  const body: Record<EngineCase, string> = {
    'browser-preview': 'await voiceBrowserPreview(app, audit, expect, scenario);',
    'ack-read-retry': 'await voiceAckReadRetry(app, audit, expect, scenario);',
    'new-edit-fence': 'await voiceNewEditFence(app, audit, expect, scenario);',
    'placeholder-receipt': 'await voiceUnconfirmedReceipt(app, audit, expect, scenario, false);',
    'unknown-ack': 'await voiceUnconfirmedReceipt(app, audit, expect, scenario, true);',
    'local-model': 'await voiceModelSelection(app, audit, expect);',
    'literal-asr': 'await voiceLiteralAsr(app, audit, expect);',
    'stop-close-invalidated': 'await voiceStopCloseInvalidated(app, audit, expect);',
    lifecycle: 'await voiceLifecycleFence(app, audit, expect, scenario, release);',
    'host-fence': 'await voiceHostFence(app, audit, expect, scenario, release, false);',
    'host-read-fence': 'await voiceHostFence(app, audit, expect, scenario, release, true);',
  };
  return `import { test, open, expect } from 'nsh/test';
import { createHost } from './host.js';
${[traceVoiceProductionApp, openProductionVoice, editProductionVoice, checkVoiceNoExternalWork, voiceBrowserPreview, voiceAckReadRetry, voiceNewEditFence, voiceUnconfirmedReceipt, voiceModelSelection, startProductionAsr, voiceLiteralAsr, voiceStopCloseInvalidated, voiceLifecycleFence, switchProductionVoiceHost, voiceHostFence].map(work => work.toString()).join('\n')}
test('actual production Voice: ${testCase}', async () => {
  const host = createHost();
  const audit = () => host.call('voiceProduction.fixture.audit', {});
  const scenario = mode => host.call('voiceProduction.fixture.scenario', { mode });
  const release = lane => host.call('voiceProduction.fixture.release', { lane });
  const handlers = Object.fromEntries(${JSON.stringify(voiceProductionCapabilities)}.map(name => [name, input => {
    console.log('voice-production-native:' + JSON.stringify({ event: 'begin', name, fields: Object.keys(input ?? {}).sort(), resource: input?.path ?? null }));
    try {
      const value = host.call(name, input);
      console.log('voice-production-native:' + JSON.stringify({ event: value && typeof value.then === 'function' ? 'pending' : 'returned', name, held: audit().held, rejected: audit().rejected }));
      return value;
    } catch (error) { console.log('voice-production-native:' + JSON.stringify({ event: 'failed', name, audit: audit() })); throw error; }
  }]));
  console.log('voice-production-stage:open-begin');
  const rawApp = await open('./App.tsx', { storage: { language: 'en' }, network: {}, host: { handlers } });
  console.log('voice-production-stage:open-end');
  const app = traceVoiceProductionApp(rawApp, audit);
  try {
    await app.waitUntil(() => audit().configurations.length > 0 && audit().nativeCounts['native.diagnostics.status'] === 1);
    ${body[testCase]}
    checkVoiceNoExternalWork(app, audit, expect);
    expect(app.shows('id:notification-root-feedback')).toBe(false);
    expect(app.texts().join('\\n')).not.toMatch(/Unexpected Voice|ReferenceError|TypeError|capability.*denied/i);
  } catch (error) {
    console.log('voice-production-failure:' + JSON.stringify({ scenario: ${JSON.stringify(testCase)}, audit: audit(), nativeCalls: app.host.calls() }));
    throw error;
  } finally { app.dispose(); }
}, ${testCase === 'browser-preview' ? 30000 : 90000});
`;
}

it('statically compiles all eleven public drivers and the actual App→Settings→Voice graph without NSH engine execution', () => {
  withVoiceProductionFixture(root, (fixture: Fixture) => {
    const entries = engineCases.map(testCase => {
      const entry = testCase + '.test.ts', source = engineScript(testCase);
      const parsed = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
      expect(parsed.diagnostics ?? []).toEqual([]);
      expect(source).toMatch(/app\.press\(["']id:projects-open-search["']\)/); expect(source).toMatch(/app\.press\(["']id:projects-search-command:open-settings["']\)/);
      expect(source).not.toMatch(/app\.tab\.set|nav\.(push|replace)|network:\s*['"]live|--target|\.hear\(|\.endSpeech\(/);
      writeFileSync(path.join(fixture.directory, entry), source); return entry;
    });
    const metadata = path.join(fixture.directory, 'graph.json');
    const built = spawnSync('bun', ['build', fixture.entry, ...entries, '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + metadata, '--outdir', path.join(fixture.directory, 'graph')], { cwd: fixture.directory, encoding: 'utf8', timeout: 30_000 });
    expect(built.error, built.stdout + built.stderr).toBeUndefined(); expect(built.status, built.stdout + built.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metadata, 'utf8')) as { inputs: Record<string, { imports: Array<{ original?: string }> }>; outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }> };
    const files = Object.keys(graph.inputs);
    for (const file of ['App.tsx', 'application.tsx', 'settings.tsx', 'settings-basics.tsx', 'settings-voice-test.tsx', 'settings-voice-confirm.ts', 'settings-voice-recognition.ts', 'settings-voice-models.tsx', 'settings-retention.tsx', 'state.ts']) expect(files.some(value => value.endsWith('/' + file))).toBe(true);
    expect(files.filter(file => /\/node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/)/.test(file))).toEqual([]);
    expect(Object.values(graph.inputs).flatMap(file => file.imports.filter(item => item.original?.startsWith('@/')))).toEqual([]);
    expect(Object.values(graph.outputs).flatMap(file => file.imports.filter(item => item.external && item.path !== 'nsh' && !item.path.startsWith('nsh/')))).toEqual([]);
  });
});

// Only main may opt in, serially. Workers/default runs execute pure/static checks only.
const engine = it.skipIf(process.env.NSH_VOICE_PRODUCTION_ENGINE !== '1');
for (const testCase of engineCases) engine(`prepared actual production Voice navigation: ${testCase} (headless only, not UIKit)`, () => {
  withVoiceProductionFixture(root, (fixture: Fixture) => {
    const entry = 'voice-production.test.ts'; writeFileSync(path.join(fixture.directory, entry), engineScript(testCase));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry], { cwd: fixture.directory, encoding: 'utf8', timeout: 110_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 125_000);

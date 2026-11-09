import { speechDefaults, speechSecretFields } from '../../ui/src/lib/voice/speechSettings.ts';
import { fixtureRequest } from './new-session-request.js';
import { createHost as createNavigationHost } from './settings-navigation-production-host.js';

export const voiceProductionPrimary = 'settings-navigation-production';
export const voiceProductionSecondary = 'voice-production-secondary';
export const voiceProductionLiteral = '**literal**\n<script>not HTML</script> [not a link](https://example.invalid)\n中文 🎤';
const patches = [
  { speechRate: 1.25, apiKey: 'fixture-voice-key' }, { apiKey: 'fixture-old-key' }, { apiKey: 'fixture-new-key' },
  { apiKey: 'fixture-unknown-key' }, { speechRate: 1.5 }, { sttLocalModel: 'whisper-base-int8' },
];
const readPaths = ['/api/config/settings', '/api/config/themes', '/api/yuri/session-index', '/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks', '/api/session/active', '/api/debug/location', '/api/form', '/api/permission/request', '/api/session-folders/order', '/api/yuri/message-queue/worktrees/order', '/api/git/worktrees', '/api/session', '/api/yuri/content-search'];

/** In-memory native/HTTP protocol fake only: no audio, microphone, OS, sockets,
 * model, credentials, filesystem, fetch, timers or production callbacks. */
export function createHost() {
  const base = createNavigationHost();
  const connections = [
    { id: voiceProductionPrimary, label: 'Primary synthetic Voice Host', url: 'https://primary.example.invalid', lastUsedAt: 2 },
    { id: voiceProductionSecondary, label: 'Secondary synthetic Voice Host', url: 'https://secondary.example.invalid', lastUsedAt: 1 },
  ];
  const copy = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function keys(value, allowed, required = allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) throw new Error('Unexpected Voice production payload');
  }
  const same = (a, b) => object(a) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key]);
  const ok = body => ({ status: 200, body: copy(body) });
  const states = new Map(connections.map((connection, index) => [connection.id, {
    settings: { ...Object.fromEntries(Object.entries(speechDefaults).filter(([key]) => !speechSecretFields.has(key))), configured: true,
      voiceProvider: 'browser', showMessageTTSButtons: false, dictationEnabled: false, browserVoice: 'Fixture browser authority',
      sttProvider: index ? 'openai-compatible' : 'local', sttServerUrl: 'https://stt.example.invalid/v1', sttApiKeyConfigured: true,
      speechRate: index ? 0.75 : 1 },
    write: 0, read: 0, unknownCredential: false,
  }]));
  const requests = [], writes = [], rejected = [], native = [], nativeCounts = {}, configurations = [];
  const playback = new Map(), captures = new Map(), held = new Map();
  let selected = voiceProductionPrimary, sequence = 0, appearanceRevision = 0, nextGet = 'ok', nextPut = 'ok', holdSegment = false, holdFinish = false;
  let leaseSequence = 0;
  const issuedScopes = new Map();
  const issueScope = () => {
    const scope = { hostID: selected, lease: '11111111-1111-4111-8111-' + String(++leaseSequence).padStart(12, '0') };
    states.get(selected).read = 0; issuedScopes.set(scope.lease, scope); return scope;
  };
  let runtimeScope = issueScope();
  const snapshot = () => copy({ selected, connections, runtimeScope });
  function admit(expectedHost, required = true) {
    if (expectedHost === undefined && !required) return;
    keys(expectedHost, ['hostID', 'lease']);
    if (expectedHost.hostID !== runtimeScope.hostID || expectedHost.lease !== runtimeScope.lease) throw new Error('scope_mismatch');
  }
  const state = () => states.get(selected);
  function hold(lane, response) {
    if (held.has(lane)) throw new Error('Voice production lane already held');
    return new Promise(resolve => { held.set(lane, { resolve, response, hostID: selected }); });
  }
  function release(lane) {
    const pending = held.get(lane);
    if (!pending) throw new Error('Voice production lane is not held');
    held.delete(lane); pending.resolve(pending.response);
  }
  const authoritative = () => { if (!state().read || state().read <= state().write || state().unknownCredential) throw new Error('Voice native action without a complete confirmed GET'); };
  const identity = input => typeof input.owner === 'string' && /^settings-voice-[1-9][0-9]*$/.test(input.owner) && Number.isSafeInteger(input.revision) && input.revision > 0;
  const audioIdentity = input => typeof input.owner === 'string' && /^(settings-voice-[1-9][0-9]*-[1-9][0-9]*|speech-[0-9]+-[0-9]+)$/.test(input.owner);
  return { call(name, input) {
    try {
      if (name === 'voiceProduction.fixture.audit') {
        keys(input, []);
        return copy({ selected, runtimeScope, requests, writes, rejected, native, nativeCounts, configurations,
          settings: Object.fromEntries([...states].map(([id, value]) => [id, value.settings])),
          held: [...held].map(([lane, value]) => ({ lane, hostID: value.hostID })),
          playback: [...playback.values()].map(({ hostID, owner, revision, released }) => ({ hostID, owner, revision, released })),
          captures: [...captures.values()].map(({ hostID, owner, revision, provider, cancelled }) => ({ hostID, owner, revision, provider, cancelled })),
        });
      }
      if (name === 'voiceProduction.fixture.scenario') {
        keys(input, ['mode']);
        if (['fail-next-get', 'placeholder-next-get', 'hold-next-get'].includes(input.mode)) nextGet = input.mode;
        else if (input.mode === 'unknown-next-put') nextPut = input.mode;
        else if (input.mode === 'hold-segment') holdSegment = true;
        else if (input.mode === 'hold-finish') holdFinish = true;
        else throw new Error('Unexpected Voice production scenario');
        return true;
      }
      if (name === 'voiceProduction.fixture.release') { keys(input, ['lane']); if (!['get', 'segment', 'finish'].includes(input.lane)) throw new Error('Unexpected Voice production release'); release(input.lane); return true; }
      nativeCounts[name] = (nativeCounts[name] || 0) + 1;
      if (name === 'native.diagnostics.status') { keys(input, []); return { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 }; }
      if (name === 'connection.list') { keys(input, []); return snapshot(); }
      if (name === 'connection.select') { keys(input, ['id']); if (!connections.some(connection => connection.id === input.id)) throw new Error('Unexpected Voice Host'); selected = input.id; runtimeScope = issueScope(); return snapshot(); }
      if (name === 'appearance.reset') { keys(input, ['hostID']); if (input.hostID !== null && !states.has(input.hostID)) throw new Error('Unexpected appearance Host'); return { revision: ++appearanceRevision }; }
      if (name === 'appearance.apply') {
        keys(input, ['hostID', 'revision', 'mode', 'cssVars', 'fonts']);
        if (input.hostID !== selected || input.revision !== appearanceRevision || !['system', 'light', 'dark'].includes(input.mode)) throw new Error('Unexpected appearance scope');
        keys(input.cssVars, ['light', 'dark']); keys(input.fonts, ['ui', 'mono', 'assistantLight', 'assistantDark']);
        if (!object(input.cssVars.light) || !object(input.cssVars.dark) || Object.values(input.fonts).some(value => typeof value !== 'string' || !value)) throw new Error('Unexpected appearance values');
        return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], systemColorScheme: 'light' };
      }
      if (name === 'notification.configure') {
        keys(input, ['hostID', 'enabled', 'mode', 'events', 'language']);
        if (!requests.some(row => row.hostID === selected && row.path === '/api/config/settings') || input.hostID !== selected || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en' || JSON.stringify(input.events) !== JSON.stringify(['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'])) throw new Error('Unexpected Voice notification configuration');
        configurations.push(copy(input)); return { lease: 'voice-production-memory-lease-' + selected };
      }
      if (name === 'runtime.stream') {
        keys(input, input?.key === 'chat' ? ['path', 'key', 'expectedHost', 'ownerID', 'mode'] : ['path', 'key', 'expectedHost']); admit(input.expectedHost);
        if (input.key === 'chat' && (!['auto', 'ws', 'sse'].includes(input.mode) || typeof input.ownerID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerID))) throw new Error('Unexpected Voice stream ticket');
        return base.call(name, { path: input.path, key: input.key });
      }
      if (name === 'runtime.stop') {
        keys(input, ['key', 'expectedHost', 'ownerID'], []);
        if (input.key === 'chat' && (typeof input.ownerID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerID))) throw new Error('Unexpected Voice stop ticket');
        if (input.expectedHost !== undefined) {
          keys(input.expectedHost, ['hostID', 'lease']);
          if (!same(issuedScopes.get(input.expectedHost.lease), input.expectedHost)) throw new Error('Unknown Voice cleanup scope');
        } else if (input.key === undefined) runtimeScope = issueScope();
        else throw new Error('scope_required');
        return base.call(name, input.key === undefined ? {} : { key: input.key });
      }
      if (name === 'voiceRecognition.capabilities') {
        keys(input, []); native.push({ name, hostID: selected, input: {} });
        return { providers: ['local', 'openai-compatible', 'volcengine'], maximumSeconds: 60, maximumBytes: 1_920_000 };
      }
      if (name === 'voiceRecognition.start') {
        keys(input, ['owner', 'revision', 'provider', 'expectedHost']); admit(input.expectedHost); authoritative();
        if (!identity(input) || input.provider !== state().settings.sttProvider || [...captures.values()].some(value => !value.cancelled)) throw new Error('Unexpected configured Voice recognition start');
        if ([...captures.values()].some(value => value.owner === input.owner && value.revision >= input.revision)) throw new Error('Non-monotonic Voice recognition revision');
        captures.set(input.owner + ':' + input.revision, { ...input, hostID: selected, cancelled: false }); native.push({ name, hostID: selected, input: copy(input) }); return { owner: input.owner, revision: input.revision, provider: input.provider };
      }
      if (name === 'voiceRecognition.finish' || name === 'voiceRecognition.cancel') {
        keys(input, ['owner', 'revision']);
        const capture = captures.get(input.owner + ':' + input.revision);
        if (!identity(input) || !capture) throw new Error('Unknown Voice recognition lease');
        native.push({ name, hostID: capture.hostID, input: copy(input) });
        if (name === 'voiceRecognition.cancel') { capture.cancelled = true; return null; }
        if (capture.cancelled || capture.hostID !== selected) throw new Error('Retired Voice recognition finish');
        const response = { text: (capture.hostID === voiceProductionPrimary ? 'Primary ' : 'Secondary ') + voiceProductionLiteral };
        if (holdFinish) { holdFinish = false; return hold('finish', response); }
        return response;
      }
      if (name === 'speech.prepare') {
        keys(input, ['owner']); if (!audioIdentity(input) || playback.has(input.owner)) throw new Error('Unexpected Voice playback owner');
        if (input.owner.startsWith('settings-voice-')) authoritative();
        playback.set(input.owner, { owner: input.owner, hostID: selected, revision: 0, released: false }); native.push({ name, hostID: selected, input: copy(input) });
        return { provider: state().settings.voiceProvider, visible: state().settings.showMessageTTSButtons, mode: state().settings.ttsInputMode };
      }
      if (['speech.segment', 'speech.stop', 'speech.release'].includes(name)) {
        keys(input, name === 'speech.segment' ? ['owner', 'revision', 'source', 'text'] : name === 'speech.stop' ? ['owner', 'revision'] : ['owner']);
        const handle = playback.get(input.owner);
        if (!audioIdentity(input) || !handle) throw new Error('Unknown Voice playback lease');
        if (name !== 'speech.release' && (!Number.isSafeInteger(input.revision) || input.revision <= handle.revision)) throw new Error('Non-monotonic Voice playback revision');
        if (name === 'speech.segment' && (handle.released || handle.hostID !== selected || !input.owner.startsWith('settings-voice-') || input.source !== 'settings-preview' || input.text !== "Hello! I'm Fixture browser authority. This is how I sound.")) throw new Error('Unexpected Voice settings-preview segment');
        native.push({ name, hostID: handle.hostID, input: copy(input) });
        if (name !== 'speech.release') handle.revision = input.revision;
        if (name === 'speech.release') handle.released = true;
        if (name !== 'speech.segment') { if (held.get('segment')?.hostID === handle.hostID) release('segment'); return null; }
        if (holdSegment) { holdSegment = false; return hold('segment', null); }
        return null;
      }
      if (name !== 'runtime.request') throw new Error('Unexpected Voice production native call: ' + name);
      keys(input, ['path', 'method', 'body', 'expectedHost'], ['path', 'method']);
      if (typeof input.path !== 'string' || input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Unexpected Voice production resource');
      const route = fixtureRequest(input), { path, method, params } = route;
      admit(input.expectedHost, method !== 'GET');
      if (method === 'GET' && input.body !== undefined) throw new Error('Unexpected Voice GET body');
      const row = { hostID: selected, path, resource: input.path, method, sequence: ++sequence, ...(input.expectedHost === undefined ? {} : { expectedHost: copy(input.expectedHost) }) };
      if (path === '/api/yuri/history-import/jobs') {
        route.expect('GET'); admit(input.expectedHost);
        if (input.path !== path || Object.prototype.hasOwnProperty.call(input, 'body')) throw new Error('Unexpected Voice history monitor GET');
        requests.push(row);
        return ok([]);
      }
      if (path === '/api/voice/settings') {
        if (params.size || input.path !== path) throw new Error('Voice settings must be Host-global');
        if (method === 'GET') {
          requests.push(row); const mode = nextGet; nextGet = 'ok';
          if (mode === 'fail-next-get') return { status: 502, body: { error: 'Synthetic Voice read failure' } };
          if (mode === 'placeholder-next-get') return ok({ configured: false, openaiApiKeyConfigured: false, openaiCompatibleApiKeyConfigured: false, sttApiKeyConfigured: false });
          // A malicious/legacy public mask must still never seed the secret input.
          const response = ok({ ...state().settings, apiKey: '********' });
          if (mode === 'hold-next-get') {
            const captured = state(), capturedScope = { ...runtimeScope };
            return hold('get', response).then(value => { if (same(runtimeScope, capturedScope)) captured.read = row.sequence; return value; });
          }
          state().read = row.sequence; return response;
        }
        if (method !== 'PUT' || !patches.some(patch => same(input.body, patch))) throw new Error('Unexpected Voice settings exact PUT body');
        row.body = copy(input.body); requests.push(row); writes.push(copy(row)); state().write = row.sequence;
        for (const [key, value] of Object.entries(input.body)) {
          if (speechSecretFields.has(key)) state().settings[key === 'apiKey' ? 'configured' : key + 'Configured'] = !!value;
          else state().settings[key] = value;
        }
        if (nextPut === 'unknown-next-put') { nextPut = 'ok'; state().unknownCredential = Object.keys(input.body).some(key => speechSecretFields.has(key)); return ok({ ok: true }); }
        return ok(state().settings);
      }
      if (path === '/api/dictation/status') {
        route.expect('GET', ['provider'], ['provider']); if (params.get('provider') !== 'local') throw new Error('Unexpected Voice model provider');
        requests.push(row); const model = id => ({ id, installed: true, downloading: false, downloadProgress: null, downloadError: null });
        return ok({ provider: 'local', models: ['parakeet-tdt-0.6b-v2-int8', 'parakeet-tdt-0.6b-v3-int8', 'whisper-base-int8', 'whisper-tiny-int8'].map(model), ttsModels: [model('kokoro-en-v0_19')] });
      }
      // Only explicitly enumerated read-only production root/search routes pass
      // through. Retention bootstrap reads preferences; all cleanup writes fail.
      if (method !== 'GET' || !readPaths.includes(path)) throw new Error('Unexpected Voice production request: ' + method + ' ' + input.path);
      const response = base.call(name, { path: input.path, method, ...(input.body === undefined ? {} : { body: input.body }) }); requests.push(row); return response;
    } catch (error) {
      rejected.push({ name, resource: typeof input?.path === 'string' ? input.path : null, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } };
}

import { speechDefaults } from '../ui/src/lib/voice/speechSettings';

export const setupTourTestScope = { hostID: 'setup-tour-fixture', lease: 'synthetic-in-memory-tour-lease' } as const;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('strict-host-object');
  return value as ObjectValue;
};
const exact = (value: ObjectValue, keys: string[]) => {
  if (Object.keys(value).sort().join('|') !== keys.sort().join('|')) throw new Error('strict-host-keys');
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Test-only in-memory Host. No FS, network, installation, microphone, timers,
 * native engine, wildcard success or mutable production configuration. */
export function createSetupTourTestHost(options: {
  directory?: string; entries?: Array<{ spec: string; parsedKind: string; file?: boolean }>;
  allowedPlugins?: readonly string[]; allowedVoice?: boolean; config?: ObjectValue;
  failListAfterWrite?: number; failWrites?: readonly string[]; uncertainWrites?: readonly string[];
  missingAfterAck?: boolean; voiceReadFailureAfterWrite?: number; partialProviders?: boolean;
  voiceConfigured?: boolean;
} = {}) {
  const directory = options.directory ?? '/fixture/tour';
  const suffix = `?directory=${encodeURIComponent(directory)}`;
  const entries = clone(options.entries ?? []);
  let config: ObjectValue = clone(options.config ?? {}), voice = { ...speechDefaults, configured: options.voiceConfigured ?? false }, listFailures = 0, voiceFailures = 0;
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const rejected: string[] = [], writes: string[] = [];
  const metadata = ['@eficy/opencode2-plugin', '@yee94/opencode-profile'].map((spec, index) => ({ kind: 'npm-ok', spec, name: `Author package ${index}`, description: `Author description ${index}`, icon: 'data:image/svg+xml,%3Csvg/%3E', readme: `# Author README ${index}`, latestVersion: '3.2.1' }));
  const registry = `/api/config/plugins/registry?specs=${metadata.map(item => encodeURIComponent(item.spec)).join(',')}&details=true&directory=${encodeURIComponent(directory)}`;
  const fail = (code: string): never => { rejected.push(code); throw new Error(code); };
  function call(name: string, input: unknown): unknown {
    try {
      if (name !== 'runtime.request') return fail('strict-host-native');
      const request = object(input);
      const method = request.method;
      exact(request, method === 'GET' ? ['path', 'method', 'expectedHost'] : ['path', 'method', 'body', 'expectedHost']);
      const expectedHost = object(request.expectedHost); exact(expectedHost, ['hostID', 'lease']);
      if (expectedHost.hostID !== setupTourTestScope.hostID || expectedHost.lease !== setupTourTestScope.lease) return fail('strict-host-scope');
      if (typeof request.path !== 'string' || !['GET', 'POST', 'PUT'].includes(String(method))) return fail('strict-host-wire');
      const path = request.path;
      if (method === 'GET' && path === '/api/config/plugins' + suffix) {
        requests.push({ path, method });
        if (listFailures > 0) { listFailures--; return { status: 503, body: { error: 'scripted-list-failure' } }; }
        return { status: 200, body: { entries: clone(entries.filter(item => !item.file)), files: clone(entries.filter(item => item.file)) } };
      }
      if (method === 'GET' && path === registry) { requests.push({ path, method }); return { status: 200, body: { results: clone(metadata) } }; }
      if (method === 'GET' && path === '/api/config/catalog/providers' + suffix) { requests.push({ path, method }); return { status: 200, body: { schemaVersion: 1, partial: !!options.partialProviders, providers: [{ id: 'openai', models: { model: {} } }] } }; }
      if (method === 'GET' && path === '/api/voice/settings') {
        requests.push({ path, method });
        if (voiceFailures > 0) { voiceFailures--; return { status: 503, body: {} }; }
        return { status: 200, body: clone(voice) };
      }
      if (method === 'POST' && path === '/api/config/plugins/entry' + suffix) {
        const body = object(request.body); exact(body, ['spec', 'scope']);
        if (body.scope !== 'user' || typeof body.spec !== 'string' || !options.allowedPlugins?.includes(body.spec)) return fail('strict-host-plugin-consent');
        requests.push({ path, method, body: clone(body) });
        if (options.failWrites?.includes(body.spec)) return { status: 422, body: { error: 'scripted-write-rejection' } };
        if (entries.some(entry => entry.spec === body.spec)) return { status: 409, body: { error: 'duplicate' } };
        config = { $schema: 'https://opencode.ai/config.json', lsp: true, ...config, plugins: [...(Array.isArray(config.plugins) ? config.plugins : []), body.spec] };
        if (!options.missingAfterAck) entries.push({ spec: body.spec, parsedKind: 'npm' });
        writes.push(body.spec); listFailures += options.failListAfterWrite ?? 0;
        if (options.uncertainWrites?.includes(body.spec)) throw new Error('scripted-response-lost');
        return { status: 200, body: { success: true, requiresReload: false, application: 'watch', message: 'Plugin entry created.', reloadFailed: false } };
      }
      if (method === 'PUT' && path === '/api/voice/settings' && options.allowedVoice) {
        const body = object(request.body);
        const allowed = new Set(['voiceProvider', 'sttProvider', 'dictationEnabled', 'showMessageTTSButtons', 'apiKey', 'resourceId', 'voice', 'asrResourceId', 'asrContext']);
        if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) return fail('strict-host-voice-keys');
        for (const [key, value] of Object.entries(body)) if (typeof value !== typeof speechDefaults[key as keyof typeof speechDefaults]) return fail('strict-host-voice-type');
        if ('apiKey' in body && body.apiKey !== 'synthetic-tour-key') return fail('strict-host-voice-secret');
        requests.push({ path, method, body: { ...clone(body), ...('apiKey' in body ? { apiKey: '[synthetic]' } : {}) } });
        const { apiKey: _secret, ...publicPatch } = body;
        voice = { ...voice, ...publicPatch, ...('apiKey' in body ? { configured: true } : {}), apiKey: '' };
        writes.push('voice'); voiceFailures += options.voiceReadFailureAfterWrite ?? 0;
        return { status: 200, body: clone(voice) };
      }
      return fail('strict-host-route');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('strict-host-') && !rejected.includes(error.message)) rejected.push(error.message);
      throw error;
    }
  }
  return {
    call,
    audit: () => clone({ requests, rejected, writes, config, voice, entries }),
  };
}

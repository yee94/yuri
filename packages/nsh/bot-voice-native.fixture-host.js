export function createHost() {
  const ids = ['parakeet-tdt-0.6b-v2-int8', 'parakeet-tdt-0.6b-v3-int8', 'whisper-base-int8', 'whisper-tiny-int8', 'kokoro-en-v0_19'];
  let reads = 0, downloads = 0, deleted = false, saved = false;
  const states = () => ids.map((id, index) => ({ id, installed: index === 4 && !deleted, downloading: false, downloadProgress: null, downloadError: index === 0 ? 'Fixture download failed; retry allowed' : null }));
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected bridge call ' + name);
    // NSH's self-contained web Host has no URL or URLSearchParams globals.
    if (!input || typeof input.path !== 'string' || !input.path.startsWith('/api/') || input.path.includes('#') || input.path.includes('://')) throw new Error('Invalid fixture path');
    const parts = input.path.split('?');
    if (parts.length > 2 || !/^\/api\/[a-zA-Z0-9_./-]+$/.test(parts[0]) || parts[0].includes('//') || parts[0].split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid fixture path');
    const path = parts[0], query = Object.create(null);
    if (parts.length === 2) {
      if (!parts[1]) throw new Error('Empty fixture query');
      for (const field of parts[1].split('&')) {
        const separator = field.indexOf('=');
        if (separator < 1) throw new Error('Invalid fixture query');
        const key = decodeURIComponent(field.slice(0, separator).replace(/\+/g, ' '));
        if (Object.prototype.hasOwnProperty.call(query, key)) throw new Error('Duplicate fixture query');
        query[key] = decodeURIComponent(field.slice(separator + 1).replace(/\+/g, ' '));
      }
    }
    const expectQuery = expected => {
      if (Object.keys(query).length !== Object.keys(expected).length || Object.keys(expected).some(key => query[key] !== expected[key])) throw new Error('Unexpected fixture query ' + input.path);
    };
    if (path === '/api/config') expectQuery({ 'location[directory]': '/workspace/actual' });
    else if (path === '/api/config/catalog/providers') expectQuery(Object.keys(query).length ? { directory: '/workspace/actual' } : {});
    else if (path === '/api/dictation/status') expectQuery({ provider: 'local' });
    else expectQuery({});
    if (!['/api/yuri/assistants', '/api/dictation/models/' + ids[0] + '/download', '/api/dictation/models/kokoro-en-v0_19'].includes(path) && input.method !== 'GET') throw new Error('Fixture forbids mutation ' + path);
    const reply = body => ({ status: 200, body });
    if (path === '/api/config/settings/bootstrap') return reply({ schemaVersion: 1, defaultModel: 'configured/model#high', defaultVariant: 'low' });
    if (path === '/api/config/settings') {
      if (input.method !== 'GET') throw new Error('Fixture forbids Host settings mutation');
      return reply({ defaultModel: 'configured/model#high', defaultVariant: 'low' });
    }
    if (path === '/api/config') return reply([{ type: 'document', info: { model: 'not-used/model' } }]);
    if (path === '/api/config/catalog/providers') return reply({ schemaVersion: 1, providers: [{ id: 'configured', name: 'Configured', models: { model: { id: 'model', name: 'Configured model', variants: { high: {}, low: {} } } } }] });
    if (path === '/api/yuri/assistants/snapshot') return reply({ assistants: saved ? [{ id: 'fixture-bot', revision: 1, name: 'Yuri' }] : [] });
    if (path === '/api/yuri/assistants/capability') return reply({ supported: true, enabled: true, schemaVersion: 1 });
    if (path === '/api/yuri/assistants' && input.method === 'POST') {
      if (input.body.name !== 'Yuri' || input.body.providerID !== 'configured' || input.body.modelID !== 'model' || input.body.variant !== 'high' || input.body.workspacePath !== null) throw new Error('Wrong Bot defaults');
      saved = true; return reply({ id: 'fixture-bot', revision: 1 });
    }
    if (path === '/api/yuri/session-index') return reply({ available: true, directories: [] });
    if (path === '/api/yuri/scheduled-tasks') return reply({ tasks: [], failedProjectIds: [] });
    if (path === '/api/dictation/status') {
      reads++;
      if (downloads && reads === 2) return { status: 503, body: { error: 'Fixture status offline' } };
      const values = states();
      if (downloads) values[0] = { ...values[0], installed: true, downloadError: null };
      return reply({ provider: 'local', available: false, models: values.slice(0, 4), ttsModels: values.slice(4) });
    }
    if (path === '/api/dictation/models/' + ids[0] + '/download' && input.method === 'POST') {
      downloads++; if (downloads > 1) throw new Error('Accepted download must not replay on status retry');
      return reply({ ok: true, installed: false });
    }
    if (path === '/api/dictation/models/kokoro-en-v0_19' && input.method === 'DELETE') { deleted = true; return reply({ ok: true }); }
    throw new Error('Unexpected fixture wire ' + input.method + ' ' + path);
  } };
}

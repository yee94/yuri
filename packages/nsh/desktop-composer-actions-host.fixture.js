import { createHost as createBaseHost } from './desktop-new-session-host.fixture.js';

export function createHost() {
  const base = createBaseHost();
  const selected = { id: 'selection-session', agent: 'build', model: { providerID: 'fixture', id: 'gpt-model' } };
  const assistant = { id: 'selection-bot', revision: 1, agent: 'build', providerID: 'fixture', modelID: 'gpt-model', variant: '' };
  let requests = 0, catalogReads = 0, creates = 0, reads = 0, release;
  const writes = [];
  return { call(name, input) {
    if (name !== 'runtime.request') return base.call(name, input);
    const path = input.path.split('?')[0], method = input.method || 'GET';
    if (path === '/__composer/stats') return { status: 200, body: { requests, catalogReads, creates, reads, writes, selected } };
    if (path === '/__composer/release') { release?.(); release = undefined; return { status: 200, body: {} }; }
    if (path === '/__composer/defer') { selected.defer = true; return { status: 200, body: {} }; }
    requests++;
    if (path === '/api/session' && method === 'POST') creates++;
    if (path === '/api/agent') return { status: 200, body: { data: [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }, { name: 'review', mode: 'all' }, { name: 'hidden', mode: 'primary', hidden: true }, { name: 'child', mode: 'subagent' }] } };
    if (path === '/api/config/catalog/providers') {
      catalogReads++;
      return { status: 200, body: { schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: Object.fromEntries([
        ['gpt-model', { id: 'gpt-model', name: 'GPT fixture', variants: { low: {}, high: {} } }],
        ...Array.from({ length: 300 }, (_, index) => [`extra-${index}`, { id: `extra-${index}`, name: `Extra ${index}` }]),
      ]) }] } };
    }
    if (path === '/api/session/selection-session') { reads++; return { status: 200, body: { data: JSON.parse(JSON.stringify(selected)) } }; }
    if (path === '/api/yuri/assistants/snapshot') return { status: 200, body: { assistants: [JSON.parse(JSON.stringify(assistant))] } };
    if (path === '/api/yuri/assistants/selection-bot') {
      if (method !== 'PATCH' || input.body.expectedRevision !== assistant.revision || input.expectedHost?.lease !== 'new-session-fixture-lease') throw new Error('Unscoped or stale assistant selection write');
      writes.push({ path, body: input.body });
      const { expectedRevision, ...patch } = input.body;
      Object.assign(assistant, patch, { revision: assistant.revision + 1 });
      return { status: 200, body: { assistant: JSON.parse(JSON.stringify(assistant)) } };
    }
    if (/^\/api\/session\/selection-session\/(agent|model)$/.test(path)) {
      if (method !== 'POST' || input.expectedHost?.hostID !== 'new-session-fixture' || input.expectedHost?.lease !== 'new-session-fixture-lease' || !input.path.includes('directory=%2Ffixture%2Fproject')) throw new Error('Unscoped composer selection write');
      writes.push({ path, body: input.body });
      const apply = () => { Object.assign(selected, input.body); return { status: 200, body: {} }; };
      if (selected.defer) { delete selected.defer; return new Promise(resolve => { release = () => resolve(apply()); }); }
      return apply();
    }
    return base.call(name, input);
  } };
}

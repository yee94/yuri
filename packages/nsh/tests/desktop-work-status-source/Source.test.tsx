import { expect, open, test } from 'nsh/test';

const scope = { hostID: 'fixture', lease: 'lease-1' };
const directory = '/fixture/project';
async function launch(platform, holdStatus = false, children = false) {
  const events: Array<{ event: string; value?: any }> = [], reads = [], streams = [], rejected = [];
  const fail = value => { rejected.push(value); throw new Error('Unexpected original Chat source boundary'); };
  const app = await open('./App.tsx', { platform, width: 1440, height: 900, clock: {}, host: { params: { holdStatus, children }, handlers: {
    'connection.list': input => { if (Object.keys(input ?? {}).length) return fail(input); return { selected: 'fixture', runtimeScope: scope, connections: [{ id: 'fixture', url: 'https://fixture.invalid', authorizationID: 'fixture-auth' }] }; },
    'runtime.request': input => {
      if (input.method !== 'GET' || input.body !== undefined || JSON.stringify(input.expectedHost) !== JSON.stringify(scope)) return fail(input);
      reads.push(input);
      if (children && input.path === '/api/debug/location') return { status: 200, body: [] };
      if (children && input.path === '/api/session?location%5Bdirectory%5D=%2Ffixture%2Fproject&directory=%2Ffixture%2Fproject&parentID=parent&limit=200') return { status: 200, body: { data: [{ id: 'child', parentID: 'parent', title: 'Exact child', location: { directory } }], cursor: { next: null } } };
      if (input.path === '/api/session/active') return { status: 200, body: {} };
      if (input.path === '/api/session/parent?directory=%2Ffixture%2Fproject') return { status: 200, body: { id: 'parent', location: { directory } } };
      if (input.path === '/api/session/parent/message?directory=%2Ffixture%2Fproject&limit=20&order=desc') return { status: 200, body: { data: [{ id: 'history', type: 'assistant', content: [
        { type: 'tool', id: 'pending', name: 'task', state: { status: 'pending', input: { description: 'Historical pending', subagent_type: 'explore' }, metadata: { sessionID: 'child' } } },
        { type: 'tool', id: 'plan', name: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'Retained task', status: 'pending', priority: 'medium' }] } } },
      ] }], cursor: { next: null } } };
      if (['/api/session/parent/inbox?directory=%2Ffixture%2Fproject', '/api/session/parent/form?directory=%2Ffixture%2Fproject', '/api/permission/request?directory=%2Ffixture%2Fproject'].includes(input.path)) return { status: 200, body: [] };
      return fail(input);
    },
    'runtime.stream': input => { if (input.path !== '/api/event?directory=%2Ffixture%2Fproject' || input.key !== 'chat' || JSON.stringify(input.expectedHost) !== JSON.stringify(scope)) return fail(input); streams.push(input); return true; },
    'runtime.stop': input => { if (input.key !== 'chat' || JSON.stringify(input.expectedHost) !== JSON.stringify(scope)) return fail(input); return true; },
    'work.status.source.audit': value => { events.push(value); },
  } } });
  const latest = () => events.filter(event => event.event === 'projection').at(-1)?.value;
  const send = (type, data = {}, expectedHost = scope) => app.host.send('runtime.event', { key: 'chat', expectedHost, data: JSON.stringify({ type, data: { sessionID: 'parent', ...data }, location: { directory } }) });
  await app.waitFor('id:source-real-draft'); await app.waitUntil(() => latest()?.faces.length === 1);
  if (!holdStatus) await app.waitUntil(() => latest()?.activity === 'idle');
  return { app, latest, events, reads, streams, rejected, send };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' original source: fifty native draft/text events cause no extra projection notifications or reads, then exact live task/idle transitions', async () => {
    const f = await launch(platform), prior = f.events.filter(event => event.event === 'projection').length, reads = f.reads.length;
    expect(f.latest().taskIdentity).toBe(true); expect(f.latest().live).toEqual([]); expect(f.latest().shell).toEqual({ phase: 'unavailable' });
    for (let index = 0; index < 50; index++) {
      await f.app.clear('id:source-real-draft'); await f.app.paste('id:source-real-draft', { text: 'draft ' + index });
      await f.send('session.text.delta', { assistantMessageID: 'text', ordinal: 0, delta: 'x' }); await f.app.wait(32);
    }
    expect(f.events.filter(event => event.event === 'projection')).toHaveLength(prior); expect(f.reads).toHaveLength(reads); expect(f.streams).toHaveLength(1);
    await f.send('session.execution.started'); await f.app.waitUntil(() => f.latest().activity === 'working'); expect(f.latest().live).toEqual([]);
    await f.send('session.tool.called', { assistantMessageID: 'live', id: 'worker', name: 'task', input: { description: 'Real worker', subagent_type: 'explore' } }); await f.app.wait(32);
    await f.app.waitUntil(() => f.latest().live.length === 1); expect(f.latest().live).toEqual(['live:worker']);
    await f.send('session.status', { status: { type: 'idle' } }); await f.app.waitUntil(() => f.latest().activity === 'idle'); expect(f.latest().live).toEqual([]);
    expect(f.latest().faces.find(face => face.id === 'history:pending').running).toBe(true); expect(f.latest().taskIdentity).toBe(true);
    expect(f.rejected).toEqual([]); expect(f.app.requests()).toEqual([]);
  });
  test(platform + ' confirmed-read/live revision and owner retirement fence a delayed original native status response', async () => {
    const f = await launch(platform, true);
    await f.app.waitUntil(() => f.events.some(event => event.event === 'held')); expect(f.latest().activity).toBe('unknown');
    await f.send('session.execution.started'); await f.app.waitUntil(() => f.latest().activity === 'working');
    await f.app.host.send('work.status.source.control', { action: 'replace' });
    await f.app.waitUntil(() => f.streams.length === 2 && f.latest().activity === 'idle');
    const count = f.events.filter(event => event.event === 'projection').length;
    await f.app.host.send('work.status.source.control', { action: 'release' }); await f.app.waitUntil(() => f.events.some(event => event.event === 'released'));
    expect(f.events.filter(event => event.event === 'projection')).toHaveLength(count); expect(f.latest().activity).toBe('idle');
    await f.send('session.tool.called', { assistantMessageID: 'retired', id: 'worker', name: 'task', input: {} }, { hostID: 'fixture', lease: 'retired' }); await f.app.wait(32);
    expect(f.events.filter(event => event.event === 'projection')).toHaveLength(count);
    expect(f.rejected).toEqual([]); expect(f.app.requests()).toEqual([]);
  });
  test(platform + ' opened exact children follow real root events working to idle without parent history projection or polling', async () => {
    const f = await launch(platform, false, true), childEvents = () => f.events.filter(event => event.event === 'children'), latest = () => childEvents().at(-1)?.value;
    await f.app.waitUntil(() => latest()?.rows.length === 1); expect(latest().rows[0].activity).toBe('unknown');
    const reads = f.reads.length, notices = f.events.filter(event => event.event === 'projection').length;
    const send = (type, id = 'child', expectedHost = scope, location = directory) => f.app.host.send('runtime.event', { key: 'global', ...(expectedHost === null ? {} : { expectedHost }), data: JSON.stringify({ type, data: { sessionID: id }, location: { directory: location } }) });
    for (let i = 0; i < 50; i++) { await send('session.execution.started', 'unrelated'); await send('session.text.delta'); }
    expect(childEvents()).toHaveLength(1);
    await send('session.execution.started'); await f.app.waitUntil(() => latest().rows[0].activity === 'working'); expect(latest().agents[0].phase).toBe('working');
    await send('session.idle', 'child', { hostID: 'fixture', lease: 'old' }); await send('session.idle', 'child', scope, '/other'); expect(childEvents()).toHaveLength(2);
    await send('session.idle'); await f.app.waitUntil(() => latest().rows[0].activity === 'idle'); expect(latest().agents[0].phase).toBe('done');
    await send('session.execution.started', 'child', null); await f.app.waitUntil(() => latest().rows[0].activity === 'unknown'); expect(latest().agents[0].phase).toBe('unknown');
    expect(f.reads).toHaveLength(reads); expect(f.streams).toHaveLength(1); expect(f.events.filter(event => event.event === 'projection')).toHaveLength(notices);
    expect(f.rejected).toEqual([]); expect(f.app.requests()).toEqual([]);
  });
}

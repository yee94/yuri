import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real NSH Chat + native embedded transcript ownership and lifecycle (synthetic Host only)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-panel-chat-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Panel Chat fixture', id: 'example.yuri.panel-chat', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-panel-chat-native.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Panel.test.tsx'), `
import { expect, open, test } from 'nsh/test';
function synthetic() {
  const requests = [], streams = [], stops = [], rejected = [];
  let fail = false, lease = 'lease-1';
  const user = (id, body) => ({ id, type: 'user', content: [{ type: 'text', text: body }], time: { created: 1000 } });
  const handlers = {
    'connection.list': () => ({ selected: 'A', connections: [{ id: 'A', url: 'https://a.example', authorizationID: 'auth-A' }], runtimeScope: { hostID: 'A', lease } }),
    'runtime.stream': input => { streams.push(input); return true; }, 'runtime.stop': input => { stops.push(input); return true; },
    'runtime.request': input => {
      requests.push(input);
      if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== 'A') { rejected.push(input); throw new Error('Mutation/Host forbidden'); }
      const url = new URL(input.path, 'https://a.example'), path = url.pathname;
      if (path === '/api/session/active') return { status: 200, body: {} };
      const session = /^\\/api\\/session\\/([^/]+)$/.exec(path);
      if (session) return { status: 200, body: { id: session[1], title: session[1], location: { directory: '/repo' }, ...(session[1] === 'child' ? { parentID: 's' } : {}) } };
      if (path.endsWith('/message')) {
        if (fail) return { status: 503, body: { error: 'synthetic history unavailable' } };
        const older = url.searchParams.has('cursor');
        return { status: 200, body: { data: older ? [user('old', 'Older searchable body')] : [user('new', 'Newest body'), ...Array.from({ length: 19 }, (_, i) => user('filler-' + i, 'Historical row ' + i))], cursor: { next: older ? null : 'opaque:/+?=& older' } } };
      }
      if (path.endsWith('/inbox') || path.endsWith('/form') || path === '/api/permission/request') return { status: 200, body: [] };
      rejected.push(input); throw new Error('Unexpected wire ' + input.path);
    },
  };
  return { handlers, requests, streams, stops, rejected, fail: value => { fail = value; }, renew: () => { lease = 'lease-2'; } };
}
const launch = async (platform = 'macos', params = {}) => {
  const wire = synthetic(), app = await open('./App.tsx', { platform, width: 1200, height: 900, host: { params, handlers: wire.handlers } });
  await app.waitFor('text:fixture-ready'); await app.waitFor('text:Newest body'); return { app, wire };
};
const control = (app, action) => app.host.send('panel.test.control', { action });
const audit = async app => { await app.press('id:panel-audit-button'); return JSON.parse(app.texts().find(value => value.startsWith('{"mounts"'))); };
for (const platform of ['macos', 'windows']) {
  test(platform + ' same entity reuses main source; 50 real main draft edits do zero embedded work/catalog/stream plans, close cannot stop main', async () => {
    const { app, wire } = await launch(platform);
    expect(wire.streams.map(value => value.key)).toEqual(['chat']); expect(wire.requests.filter(value => value.path.includes('/message?')).length).toBe(1);
    await control(app, 'arm-work'); await control(app, 'reset-work'); const before = wire.requests.length, streams = wire.streams.length;
    await control(app, 'edit-50'); expect(app.value('id:main-input')).toBe('Main private draft 49');
    const state = await audit(app); expect(state.work).toBe(0); expect(state.mounts).toBe(1); expect(state.disposals).toBe(0);
    expect(wire.requests.length).toBe(before); expect(wire.streams.length).toBe(streams);
    await control(app, 'close'); expect(wire.stops).toEqual([]); expect(app.value('id:main-input')).toBe('Main private draft 49'); expect(wire.rejected).toEqual([]);
  });
  test(platform + ' independent pagination/focus/search/copy and nested navigation retain parent native List state', async () => {
    const { app, wire } = await launch(platform);
    await app.press('id:panel-focus-old'); await app.waitFor('text:result:focus-done'); await app.waitFor('text:Older searchable body');
    expect(wire.requests.filter(value => value.path.includes('cursor=')).length).toBe(1);
    await app.type('id:panel-chat-search', 'Older searchable'); await app.press('id:panel-chat-find'); await app.waitFor('id:panel-chat-result:old');
    await app.press('id:panel-chat-copy:old');
    await app.press('id:panel-child'); await app.waitFor('text:result:child-open'); await app.waitFor('id:panel-chat-page:child');
    await app.waitFor('id:panel-chat-read-only-banner');
    expect(wire.streams.some(value => value.key.startsWith('panel-chat:'))).toBe(true);
    await app.press('id:panel-chat-back'); await app.waitFor('id:panel-chat-page:s'); expect(app.value('id:panel-chat-search')).toBe('Older searchable');
    await app.press('id:panel-wrong-dir'); await app.waitFor('text:result:wrong-blocked');
    await app.press('id:panel-focus-missing'); await app.waitFor('text:result:missing-done'); await app.waitFor('id:panel-chat-focus-state');
    expect(wire.stops.every(value => value.key !== 'chat')).toBe(true); expect(wire.rejected).toEqual([]);
  });
  test(platform + ' cover retains snapshot/sync but denies actions; real hide and Host retirement stop only display stream', async () => {
    const { app, wire } = await launch(platform, { standalone: true });
    const streams = wire.streams.length; await control(app, 'cover');
    expect(app.enabled('id:panel-chat-load-older')).toBe(false); await app.press('id:panel-child'); await app.waitFor('text:result:child-blocked'); expect(wire.streams.length).toBe(streams); expect(wire.stops).toEqual([]);
    await control(app, 'uncover'); expect(app.enabled('id:panel-chat-load-older')).toBe(true);
    await control(app, 'hide'); expect(wire.stops.some(value => value.key.startsWith('panel-chat:'))).toBe(true); expect(wire.stops.every(value => value.key !== 'chat')).toBe(true);
    await control(app, 'show'); await app.waitUntil(() => wire.streams.length > streams);
    await control(app, 'host'); await app.press('id:panel-child'); await app.waitFor('text:result:child-blocked'); expect(wire.rejected).toEqual([]);
  });
}
test('standalone partial error retains rows and explicit retry only rereads; lease reconnect never replays send', async () => {
  const { app, wire } = await launch('macos', { standalone: true }); wire.fail(true);
  await app.press('id:panel-chat-load-older'); await app.waitFor('id:panel-chat-page-error'); expect(app.shows('text:Newest body')).toBe(true);
  wire.fail(false); await app.press('id:panel-chat-load-older'); await app.waitUntil(() => !app.shows('id:panel-chat-page-error'));
  await app.press('id:panel-focus-old'); await app.waitFor('text:result:focus-done'); await app.waitFor('text:Older searchable body');
  wire.renew(); await control(app, 'lease'); await app.waitFor('text:result:lease-done');
  await app.waitUntil(() => wire.streams.some(value => value.key.startsWith('panel-chat:') && value.expectedHost.lease === 'lease-2'));
  expect(wire.rejected).toEqual([]); expect(wire.requests.every(value => value.method === 'GET')).toBe(true);
});
test('without an independent native port a distinct target exposes unavailable realtime and never issues an unsupported native stream key', async () => {
  const { app, wire } = await launch('macos', { standalone: true, noStream: true });
  await app.waitFor('id:panel-chat-stream-unavailable'); expect(wire.streams.map(value => value.key)).toEqual(['chat']);
  await control(app, 'close'); expect(wire.stops).toEqual([]); expect(wire.rejected).toEqual([]);
});
test('same entity reads main live deltas without another stream, parser or refresh', async () => {
  const { app, wire } = await launch(); const before = wire.requests.length;
  await app.host.send('runtime.event', { key: 'chat', data: JSON.stringify({ type: 'session.execution.started', data: { sessionID: 's', directory: '/repo' } }) });
  await app.waitFor('text:main-busy:true');
  await app.host.send('runtime.event', { key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'live', directory: '/repo', ordinal: 0, delta: 'Main shared live body' } }) });
  await app.waitFor('text:Main shared live body'); expect(wire.streams.map(value => value.key)).toEqual(['chat']); expect(wire.requests.length).toBe(before);
  await control(app, 'close'); expect(wire.stops).toEqual([]); expect(wire.rejected).toEqual([]);
});
test('late native stream port upgrades the retained reader without replacing its search or the main writer', async () => {
  const { app, wire } = await launch('macos', { standalone: true, noStream: true });
  await app.waitFor('id:panel-chat-stream-unavailable'); await app.type('id:panel-chat-search', 'Retained search');
  const before = wire.streams.filter(value => value.key === 'chat').length;
  await control(app, 'grant-stream'); await app.waitUntil(() => wire.streams.some(value => value.key.startsWith('panel-chat:')));
  await app.waitFor('id:panel-chat-stream-unavailable', { state: 'gone' });
  expect(app.value('id:panel-chat-search')).toBe('Retained search');
  await app.press('id:panel-audit-button'); expect(JSON.parse(app.value('id:panel-audit') || app.texts().find(text => text.startsWith('{"mounts"'))).mounts).toBe(1);
  expect(wire.streams.filter(value => value.key === 'chat').length).toBe(before);
  await control(app, 'close'); expect(wire.stops.length).toBe(1); expect(wire.rejected).toEqual([]);
});
test('independent stream admits only its exact lease key and session/directory, without changing main writer', async () => {
  const { app, wire } = await launch('macos', { standalone: true });
  const key = wire.streams.find(value => value.key.startsWith('panel-chat:')).key;
  const event = (key, directory, delta) => app.host.send('runtime.event', { key, data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: 'other', assistantMessageID: 'display-live', directory, ordinal: 0, delta } }) });
  await event('chat', '/repo', 'Forbidden foreign stream token'); await event(key, '/wrong', 'Forbidden foreign directory token');
  await event(key, '/repo', 'Display-only live body'); await app.waitFor('text:Display-only live body'); expect(app.shows('text:main-busy:false')).toBe(true);
  expect(app.shows('text:Forbidden foreign stream token')).toBe(false); expect(app.shows('text:Forbidden foreign directory token')).toBe(false);
  await control(app, 'close'); expect(wire.stops.map(value => value.key)).toEqual([key]); expect(wire.rejected).toEqual([]);
});
test('real background releases reads and interaction, resumes unchanged identity without consuming main draft', async () => {
  const { app, wire } = await launch('macos', { standalone: true });
  await app.type('id:main-input', 'Unchanged private draft'); const streams = wire.streams.length;
  await app.setLifecycle('background'); expect(wire.stops.length).toBe(2);
  await app.setLifecycle('active'); await app.waitUntil(() => wire.streams.length > streams);
  expect(app.value('id:main-input')).toBe('Unchanged private draft'); expect(wire.rejected).toEqual([]);
});
test('main display suspension hands realtime to display, and return releases only its independent key', async () => {
  const { app, wire } = await launch(); await control(app, 'main-off');
  await app.waitUntil(() => wire.streams.some(value => value.key.startsWith('panel-chat:')));
  const key = wire.streams.find(value => value.key.startsWith('panel-chat:')).key;
  await control(app, 'main-on'); await app.waitUntil(() => wire.stops.some(value => value.key === key));
  expect(app.shows('text:Newest body')).toBe(true); expect(wire.rejected).toEqual([]);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Panel.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);

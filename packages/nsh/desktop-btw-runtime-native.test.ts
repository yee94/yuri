import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('NSH real native loader, HTTP adapter, store and delayed product onHandle admission on macOS/Windows headless', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-btw-runtime-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'BTW runtime tests', id: 'example.yuri.btw-runtime', version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.http.capabilities', 'runtime.http.request', 'runtime.http.cancel', 'btw.fixture'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-btw-runtime-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Runtime.test.tsx'), `
import { expect, open, test } from 'nsh/test';
async function launch(platform, capability = true) {
  const calls = [], events = [], rows = [];
  const app = await open('./App.tsx', { platform, width: 800, height: 900, host: { handlers: {
    'runtime.http.capabilities': input => { expect(input).toEqual({}); if (!capability) throw new Error('unsupported'); return { version: 1, request: true, cancel: true, windowID: 'native-window', maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 }; },
    'runtime.http.request': input => {
      calls.push({ name: 'request', input });
      expect(Object.keys(input).sort()).toEqual(['body','expectedHost','method','ownerID','path','requestID','windowID'].sort());
      expect(input.expectedHost).toEqual({ hostID: 'synthetic', lease: '00000000-0000-4000-abcd-000000000001' });
      for (const key of ['ownerID','requestID','windowID']) expect(/^[A-Za-z0-9_-]{1,128}$/.test(input[key])).toBe(true);
      rows.push({ input });
      return input.path.endsWith('/generate') ? { status: 200, body: { data: { text: 'native adapter answer' } } } : { status: 204, body: null };
    },
    'runtime.http.cancel': input => {
      calls.push({ name: 'cancel', input }); expect(Object.keys(input).sort()).toEqual(['ownerID','requestID','windowID','expectedHost'].sort());
      const row = rows.find(row => row.input.requestID === input.requestID); expect(!!row).toBe(true);
      expect(input.ownerID).toBe(row.input.ownerID); return { ok: true };
    },
    'btw.fixture': input => { events.push(input); },
  } } });
  await app.waitFor('text:runtime:' + (capability ? 'ready' : 'unavailable'));
  return { app, calls, rows, events, control: (action, text) => app.host.send('btw.control', { action, text }) };
}
for (const platform of ['macos', 'windows']) {
  test(platform + ' true delayed Panel onHandle + exact model/agent/generate; new draft is untouched', async () => {
    const f = await launch(platform); expect(f.calls.length).toBe(0);
    await f.control('submit', '/btw side question'); expect(f.rows.length).toBe(0); expect(f.app.shows('id:desktop-btw-panel')).toBe(false);
    await f.control('edit', 'new independent draft'); await f.control('mount'); await f.app.waitFor('id:btw-answer-btw_1');
    expect(f.events.filter(e => e.name === 'mounted').length).toBe(1);
    expect(f.rows[0].input.body).toEqual({ model: { providerID: 'provider', id: 'model', variant: 'high' } });
    expect(f.rows[1].input.body).toEqual({ agent: 'agent' });
    expect(Object.keys(f.rows[2].input.body)).toEqual(['prompt']); expect(f.rows[2].input.body.prompt.includes('side question')).toBe(true);
    expect(f.rows.map(row => row.input.path)).toEqual(['model','agent','generate'].map(phase => '/api/session/session%2Fa%20b/' + phase));
    expect(new Set(f.rows.map(row => row.input.requestID)).size).toBe(3);
    expect(f.app.texts()).toContain('draft:new independent draft'); expect(f.app.texts()).toContain('outcome:accepted');
    expect(f.events.filter(e => e.name === 'issue').length).toBe(0);
  });
  test(platform + ' bare open generates nothing; cancellation during model never advances to agent', async () => {
    const f = await launch(platform); await f.control('submit', '/btw'); await f.control('mount'); await f.app.waitFor('text:outcome:accepted');
    expect(f.rows.length).toBe(0); await f.control('selection-cancel'); await f.app.waitFor('id:btw-cancelled');
    expect(f.calls.filter(row => row.name === 'cancel').length).toBe(1); expect(f.rows.length).toBe(1);
  });
  test(platform + ' retired opening rejects late actual mount without touching new text; native loader failure stays unavailable', async () => {
    const f = await launch(platform); await f.control('submit', '/btw late'); await f.control('edit', 'preserved'); await f.control('retire'); await f.control('mount');
    await f.app.waitFor('text:draft:preserved'); expect(f.rows.length).toBe(0); expect(f.app.texts()).not.toContain('outcome:accepted');
    const blocked = await launch(platform, false); expect(blocked.rows.length).toBe(0); expect(blocked.app.shows('id:desktop-btw-panel')).toBe(false);
  });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Runtime.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'BTW denied tests', id: 'example.yuri.btw-denied', version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'), capabilities: { host: ['btw.fixture'] } }));
    writeFileSync(path.join(directory, 'Denied.test.tsx'), `
import { expect, open, test } from 'nsh/test';
for (const platform of ['macos', 'windows']) test(platform + ' actual manifest denial cannot grant HTTP', async () => {
  let calls = 0;
  const app = await open('./App.tsx', { platform, host: { handlers: {
    'runtime.http.capabilities': () => { calls++; return { version: 1, request: true, cancel: true, windowID: 'native-window', maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 }; },
  } } });
  await app.waitFor('text:runtime:unavailable'); expect(calls).toBe(0); expect(app.shows('id:desktop-btw-panel')).toBe(false);
});
`);
    const denied = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Denied.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(denied.error, denied.stdout + denied.stderr).toBeUndefined(); expect(denied.status, denied.stdout + denied.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 160_000);

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production desktop Header Usage and original mobile consumer, one bounded source with the retained owner and strict fake on macOS/Windows', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'desktop-header-quota-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Header quota fixture', id: 'example.yuri.header-quota', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-quota.fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Quota.test.tsx'), `
import { expect, open, test } from 'nsh/test';
import { createHeaderHost } from ${JSON.stringify(path.join(root, 'tests/desktop-header-application/Host.js'))};
import { navigationIdentity as identity } from ${JSON.stringify(path.join(root, 'tests/desktop-application/NavigationHost.js'))};
async function launch(platform) {
 const fake = createHeaderHost(), original = fake.handlers['runtime.request'], reads = [], rejected = [];
 let predictions = true, mode = 'usage', offline = false, hold = false, release, expired = false;
 fake.handlers['runtime.request'] = async input => {
   reads.push(input);
   if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) { rejected.push(input); throw new Error('Wrong quota read authority'); }
   if (input.path === '/api/config/settings') { const reply = original(input); return { ...reply, body: { ...reply.body, usageDropdownProviders: ['google'], usageSelectedModels: { google: ['gemini/same', 'antigravity/same', 'other'] }, usageShowPredValues: predictions, usageDisplayMode: mode, timeFormatPreference: '24h' } }; }
   if (input.path === '/api/quota/providers') { original(input); return { status: 200, body: { providers: ['google'] } }; }
   if (input.path === '/api/quota/google') {
     if (hold) await new Promise(done => { release = done; });
     if (offline) return { status: 503, body: { error: 'Synthetic native quota offline' } };
     const weekly = { usedPercent: 25, remainingPercent: 75, windowSeconds: 604800, resetAt: Date.now() + 604800000 * .75 };
     return { status: 200, body: { providerId: 'google', providerName: 'Synthetic Google', configured: true, ok: true, fetchedAt: 1, usage: {
       accounts: [{ name: 'Quota A', user: 'NOT_FOR_RENDER' }, { name: 'Quota B', user: 'NOT_FOR_RENDER' }],
       windows: { weekly: { ...weekly, accountName: 'Quota A' }, disabled: { ...weekly, accountName: 'Quota B', disablePace: true }, unknown: {}, infinite: { valueLabel: '∞' }, '5h': { usedPercent: 100, remainingPercent: 0, resetAt: Date.now() + 3600000 } },
       models: { other: { windows: { weekly: { usedPercent: 20 } } }, 'antigravity/same': { windows: { weekly: { ...weekly, usedPercent: 51, disablePace: true } } }, 'gemini/same': { windows: { weekly: { ...weekly, usedPercent: 33 }, ignored: { usedPercent: 99 } } }, 'gemini/EXCLUDED': { windows: { weekly } } },
     } } };
   }
   const reply = original(input);
   if (input.path.startsWith('/api/quota/magpie?') && reply.status === 200) {
     reply.body.sources[0].results[0].usage.models = { 'gemini/same': { windows: { weekly: { usedPercent: 46, remainingPercent: 54, windowSeconds: 604800, resetAt: Date.now() + 300000000 } } } };
     if (expired) reply.body.sources[0].results.push({ providerId: 'magpie:header:expired', providerName: 'Expired quota', source: 'magpie', sourceId: 'header', configured: true, ok: true, usage: { windows: { expired: { usedPercent: 63, windowSeconds: 604800, resetAt: 1 } } } });
   }
   return reply;
 };
 const app = await open('./App.tsx', { platform, width: 1100, height: 1600, host: { handlers: fake.handlers } });
 await app.waitFor('id:desktop-chat-header-usage');
 const control = (action, value?) => app.host.send('desktop-header-quota.control', { action, value });
 async function audit() { const before = app.texts().find(text => text.startsWith('quota-audit:')); await control('audit'); await app.waitUntil(() => app.texts().some(text => text.startsWith('quota-audit:{') && text !== before)); return JSON.parse(app.texts().find(text => text.startsWith('quota-audit:{')).slice('quota-audit:'.length)); }
 async function refresh() { await app.press('id:desktop-chat-header-quota-refresh'); await app.waitFor('id:desktop-chat-header-quota-provider-google'); await app.waitUntil(() => !app.texts().includes('Loading...')); }
 return { app, fake, reads, rejected, control, audit, refresh, predictions(value) { predictions = value; }, mode(value) { mode = value; }, offline(value) { offline = value; fake.offline(value); }, hold() { hold = true; }, release() { hold = false; release?.(); }, expired() { expired = true; } };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' actual family/aggregate/account presentation and compact pace, no optimistic mode, with zero input reads/enumeration', async () => {
   const f = await launch(platform), app = f.app;
   expect(f.reads).toEqual([]); const cold = await f.audit(); expect(cold.enumerations).toBe(0);
   for (let i = 0; i < 50; i++) await app.type('id:header-quota-input', 'x');
   expect(f.reads).toEqual([]); expect((await f.audit()).enumerations).toBe(0);
   await f.refresh(); expect(f.reads.length).toBe(4); expect(f.reads.filter(row => row.path.startsWith('/api/quota/magpie?')).length).toBe(1);
   expect(app.shows('text:Quota A')).toBe(true); expect(app.shows('text:Quota B')).toBe(true); expect(app.texts()).not.toContain('NOT_FOR_RENDER');
   expect(app.shows('id:desktop-chat-header-quota-marker-weekly')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-pace-weekly')).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-marker-disabled')).toBe(false); expect(app.shows('id:desktop-chat-header-quota-pace-disabled')).toBe(false);
   expect(app.shows('id:desktop-chat-header-quota-fill-unknown')).toBe(false); expect(app.texts()).toContain('∞'); expect(app.texts()).not.toContain('—');
   expect(app.shows('id:desktop-chat-header-quota-pace-5h')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-marker-5h')).toBe(false); expect(app.texts().some(text => text.includes('Wait'))).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-family-google-gemini-auth')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-family-google-antigravity-auth')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-family-google-other')).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(false);
   await app.press('id:desktop-chat-header-quota-family-google-gemini-auth'); expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-fill-model:antigravity/same:weekly')).toBe(false); expect(app.texts()).not.toContain('EXCLUDED');
   await app.press('id:desktop-chat-header-quota-family-google-antigravity-auth'); expect(app.shows('id:desktop-chat-header-quota-pace-model:antigravity/same:weekly')).toBe(true);
   expect(app.enabled('id:desktop-chat-header-quota-remaining')).toBe(false); expect(f.reads.length).toBe(4);
   const before = await f.audit(), requests = f.reads.length;
   for (let i = 0; i < 50; i++) await app.type('id:header-quota-input', 'y');
   const after = await f.audit(); expect(after.enumerations).toBe(before.enumerations); expect(after.commits).toBe(before.commits); expect(f.reads.length).toBe(requests);
   expect(before.updated > 1).toBe(true); expect(app.shows('id:desktop-chat-header-quota-updated')).toBe(true); expect(f.rejected).toEqual([]); expect(f.fake.rejected).toEqual([]);
 });
 test(platform + ' modal/lifecycle retain family state, provider isolation, scope rebuild, source preferences and original mobile rows', async () => {
   const f = await launch(platform), app = f.app; await f.refresh();
   await app.press('id:desktop-chat-header-quota-family-google-gemini-auth'); await app.press('id:desktop-chat-header-quota-family-google-other');
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-fill-model:other:weekly')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-pace-model:other:weekly')).toBe(false);
   await f.control('modal', true); expect(app.enabled('id:desktop-chat-header-quota-family-google-gemini-auth')).toBe(false); expect(app.enabled('id:desktop-chat-header-quota-refresh')).toBe(false);
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(true); await f.control('modal', false);
   const beforeRemount = await f.audit(), readsBeforeRemount = f.reads.length;
   await f.control('presented', false); expect(app.shows('id:desktop-chat-header-usage')).toBe(false); await f.control('presented', true);
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-fill-model:other:weekly')).toBe(true);
   expect(f.reads.length).toBe(readsBeforeRemount); expect((await f.audit()).enumerations).toBe(beforeRemount.enumerations);
   await app.setLifecycle('background'); expect(app.enabled('id:desktop-chat-header-quota-family-google-gemini-auth')).toBe(false); await app.setLifecycle('active');
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(true);
   // The same displayed model on a dynamic upstream-google provider belongs to Other, not Google's family.
   expect(app.shows('id:desktop-chat-header-quota-family-magpie:header:cursor-other')).toBe(true);
   expect(app.shows('id:desktop-chat-header-quota-value-model:gemini/same:weekly')).toBe(true);
   expect(app.count('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(1);
   await app.press('id:desktop-chat-header-quota-family-magpie:header:cursor-other'); expect(app.count('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(2);
   await app.press('id:desktop-chat-header-quota-family-magpie:header:cursor-other'); expect(app.count('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(1);
   f.predictions(false); f.mode('remaining'); await f.refresh();
   expect(app.shows('id:desktop-chat-header-quota-marker-weekly')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-pace-weekly')).toBe(false); expect(app.texts()).toContain('75%');
   await f.control('mobile', true); await app.waitFor('id:chat-quota-panel'); expect(app.texts()).toContain('same · Weekly Limit'); expect(app.texts()).toContain('—');
   expect((await f.audit()).groups[0].keys).toEqual(['weekly', 'disabled', 'unknown', 'infinite', '5h', 'model:other:weekly', 'model:antigravity/same:weekly', 'model:gemini/same:weekly']);
   const reads = f.reads.length; await f.control('scope', 'B'); expect(f.reads.length).toBe(reads); await f.refresh();
   expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/same:weekly')).toBe(false); expect(app.shows('id:desktop-chat-header-quota-fill-model:other:weekly')).toBe(false); expect(f.rejected).toEqual([]);
 });
 test(platform + ' stale/expired/account snapshots preserve values, suppress false fresh forecasts, and late results cannot cross authority', async () => {
   const f = await launch(platform), app = f.app; f.expired(); await f.refresh();
   expect(app.shows('id:desktop-chat-header-quota-fill-expired')).toBe(true); expect(app.shows('id:desktop-chat-header-quota-pace-expired')).toBe(false); expect(app.texts()).toContain('63%');
   const before = await f.audit(); f.offline(true); await app.press('id:desktop-chat-header-quota-refresh'); await app.waitFor('text:HTTP 503: Synthetic native quota offline');
   expect(app.texts()).toContain('25%'); expect(app.shows('id:desktop-chat-header-quota-marker-weekly')).toBe(false); expect(app.shows('id:desktop-chat-header-quota-pace-weekly')).toBe(false); expect((await f.audit()).updated).toBe(before.updated);
   f.offline(false); await f.refresh(); expect(app.shows('id:desktop-chat-header-quota-marker-weekly')).toBe(true);
   await f.control('revoke'); expect(app.shows('id:desktop-chat-header-quota-marker-weekly')).toBe(false); // retained-owner overlay does not rewrite desktop metadata
   const g = await launch(platform); g.hold(); const refreshing = g.app.press('id:desktop-chat-header-quota-refresh'); await g.app.waitUntil(() => g.reads.length === 4); await g.control('current', false); const pending = await g.audit(); g.release(); await refreshing;
   await g.control('audit'); expect((await g.audit()).groups).toEqual([]); expect(g.app.enabled('id:desktop-chat-header-quota-refresh')).toBe(false); expect((await g.audit()).commits).toBe(pending.commits); expect((await g.audit()).result).toBe('stale'); expect(g.rejected).toEqual([]);
 });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Quota.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 170_000);

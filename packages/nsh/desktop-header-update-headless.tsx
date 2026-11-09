import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  async function launch(delayed = false) {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    let failure = false, lease = 'synthetic-lease', origin = 'https://synthetic.invalid', auth = 'synthetic-auth';
    const plan = { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true, releaseNotes: 'Synthetic notes' };
    const app = await open('./App.tsx', { platform, width: 1000, height: 850, host: { handlers: {
      'update.fixture.mode': () => delayed,
      'connection.list': () => ({ connections: [{ id: 'synthetic', url: origin, authorizationID: auth, name: 'Synthetic' }], selected: 'synthetic', runtimeScope: { hostID: 'synthetic', lease } }),
      'runtime.request': async (input: Record<string, unknown>) => {
        calls.push({ name: 'runtime.request', input });
        expect(input.method).toBe('GET'); expect(input.expectedHost).toEqual({ hostID: 'synthetic', lease });
        if (input.path === '/api/system/update') {
          if (failure) return { status: 503, body: { error: 'Synthetic private failure' } };
          return { status: 200, body: { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: lease === 'synthetic-lease' ? '2.3.0' : '2.3.1', available: true, update: plan, operation: null, checkError: null } };
        }
        if (input.path === '/api/system/info') return { status: 200, body: { yuriVersion: '2.3.0' } };
        if (input.path === '/api/opencode/upgrade-status') return { status: 200, body: { serveVersion: '1.2.3' } };
        throw new Error('Unexpected synthetic route');
      },
      'native.clientMetadata': () => { calls.push({ name: 'native.clientMetadata', input: {} }); return { schemaVersion: 1, version: '0.1.0', build: '1', updates: { status: 'unsupported' } }; },
      'native.diagnostics.status': () => { calls.push({ name: 'native.diagnostics.status', input: {} }); return { schemaVersion: 2, mode: 'event-recorder', enabled: false }; },
    } } });
    await app.waitFor('id:update-composer');
    return { app, calls, updates: () => calls.filter(value => value.input.path === '/api/system/update').length,
      control: (action: string) => app.host.send('update.fixture.control', { action }),
      fail(value: boolean) { failure = value; },
      lease() { lease = 'synthetic-next-lease'; }, origin() { origin = 'https://other-synthetic.invalid'; }, auth() { auth = 'other-synthetic-auth'; },
    };
  }
  test(platform + ' shared native About/Instance source: visible-only read, safe unsupported, retained remount and 50 input budget', async () => {
    const f = await launch(); expect(f.calls).toHaveLength(0);
    await f.app.press('id:update-open-header'); await f.app.waitUntil(() => f.app.texts().includes('2.3.0'));
    expect(f.updates()).toBe(1); expect(f.calls).toHaveLength(1);
    expect(f.app.enabled('id:desktop-header-services-update')).toBe(false);
    for (let index = 0; index < 50; index++) await f.app.type('id:update-composer', 'x');
    expect(f.updates()).toBe(1); expect(f.app.value('id:update-composer')).toBe('Retained draft' + 'x'.repeat(50));
    await f.app.press('id:update-open-settings'); await f.app.waitFor('id:about-host-update');
    expect(f.updates()).toBe(1); expect(f.app.enabled('id:about-host-update')).toBe(false);
    expect(f.app.shows('id:about-host-update-unavailable')).toBe(true);
    await f.app.press('id:about-host-check'); expect(f.updates()).toBe(2);
    await f.app.press('id:update-close-settings'); await f.app.waitFor('id:desktop-header-services-instance');
    expect(f.updates()).toBe(3);
    await f.app.press('id:update-open-settings'); await f.app.waitFor('id:about-host-update'); expect(f.updates()).toBe(3);
    await f.app.press('id:update-close-settings');
    await f.app.press('id:update-hide-header'); const count = f.calls.length;
    await f.app.setLifecycle('background'); await f.app.setLifecycle('active'); expect(f.calls).toHaveLength(count);
    expect(f.calls.every(value => value.name !== 'runtime.request' || value.input.method === 'GET')).toBe(true);
  });
  test(platform + ' one in-flight status for both components, original navigation guard, failure prior and stale lease/origin fence', async () => {
    const f = await launch(true);
    await f.app.press('id:update-open-header'); await f.app.press('id:update-open-settings'); await f.app.waitFor('id:about-host-check');
    expect(f.updates()).toBe(0);
    await f.app.press('id:update-close-settings'); await f.app.waitFor('id:update-guard-blocked');
    expect(f.app.shows('id:about-host-check')).toBe(true);
    await f.control('release'); await f.app.waitFor('id:about-host-update'); expect(f.updates()).toBe(1);
    f.fail(true); await f.app.press('id:about-host-check');
    expect(f.app.texts()).toContain('2.3.0'); expect(f.app.shows('id:about-host-update-error')).toBe(false);
    expect(f.app.enabled('id:about-host-update')).toBe(false);
    f.fail(false); f.lease(); await f.control('adopt'); await f.app.press('id:about-host-check');
    await f.app.waitUntil(() => f.calls.some(value => (value.input.expectedHost as { lease?: string } | undefined)?.lease === 'synthetic-next-lease'));
    await f.app.press('id:update-close-settings'); await f.app.waitUntil(() => f.app.texts().includes('2.3.1'));
    f.origin(); f.auth(); await f.control('adopt'); const before = f.updates(); await f.control('refresh');
    expect(f.updates()).toBe(before); expect(f.calls.some(value => value.input.method === 'POST')).toBe(false);
  });
  test(platform + ' injected synthetic unknown survives modal teardown, rejects dispose and still blocks the original navigation guard', async () => {
    const f = await launch(); await f.app.press('id:update-open-settings'); await f.app.waitFor('id:about-host-update');
    await f.control('synthetic-unknown'); await f.app.waitFor('id:about-host-update-error');
    expect(f.app.enabled('id:about-host-update')).toBe(false);
    await f.app.press('id:update-close-settings'); await f.app.waitFor('id:update-guard-blocked');
    await f.control('force-close'); await f.app.press('id:update-open-header');
    expect(f.app.enabled('id:desktop-header-services-update')).toBe(false);
    await f.app.press('id:update-open-settings'); await f.app.waitFor('id:about-host-update-error');
    await f.app.press('id:about-host-check'); expect(f.app.enabled('id:about-host-update')).toBe(false);
    await f.app.press('id:update-close-settings'); expect(f.app.shows('id:about-host-update-error')).toBe(true);
    await f.control('dispose'); await f.app.waitFor('id:update-dispose-blocked');
    expect(f.app.shows('id:about-host-update-error')).toBe(false);
    expect(f.calls.some(value => value.input.method === 'POST')).toBe(false);
  });
}

import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  async function launch() {
    const app = await open('./App.tsx', { platform, width: 1050, height: 1000 });
    const events = () => JSON.parse((app.texts().find(value => value.startsWith('audit=')) || 'audit=[]').slice(6)) as Record<string, unknown>[];
    const control = (action: string, value?: unknown) => app.host.send('fixture.instances.control-event', { action, value });
    const calls = () => JSON.parse(app.texts().find(value => value.startsWith('["desktop.ssh.')) || '[]') as string[];
    await app.waitFor('id:instances-composer'); await app.waitFor('text:["desktop.ssh.capabilities"]'); return { app, events, control, calls };
  }
  async function seedOwner(f: Awaited<ReturnType<typeof launch>>) {
    await f.app.press('id:instances-settings-open'); await f.app.waitFor('id:desktop-ssh-fixture');
    await f.app.press('id:instances-settings-close'); await f.app.waitFor('id:instances-original-settings', { state: 'gone' });
  }
  test(platform + ' unknown native kind before owner; no URL/label inference and 50 hidden/open inputs add zero Host/GET', async () => {
    const f = await launch(); const initial = f.calls().length;
    for (let i = 0; i < 50; i++) await f.app.type('id:instances-composer', 'x'); expect(f.calls()).toHaveLength(initial);
    await f.app.press('id:instances-header-open'); await f.app.waitFor('id:desktop-header-services-instance-row-connection:fixture-connection');
    expect(f.app.texts()).toContain('Unknown'); expect(f.app.texts()).not.toContain('LAN'); expect(f.app.texts()).not.toContain('SSH'); expect(f.app.texts()).not.toContain('Relay');
    expect(f.app.enabled('id:desktop-header-services-instance-default-connection:fixture-connection')).toBe(false); expect(f.app.enabled('id:desktop-header-services-instance-new-window-connection:fixture-connection')).toBe(false);
    for (let i = 0; i < 50; i++) await f.app.type('id:instances-composer', 'x'); expect(f.calls()).toHaveLength(initial); expect(f.app.requests()).toHaveLength(0);
    expect(f.app.value('id:instances-composer')).toBe('Keep draft' + 'x'.repeat(100));
  });
  test(platform + ' same retained owner native-ID binding and readonly refresh; missing same-URL association stays unknown', async () => {
    const f = await launch(); await seedOwner(f); await f.app.press('id:instances-native-bound'); await f.app.waitFor('text:control=bound');
    await f.app.press('id:instances-settings-open'); await f.app.waitFor('id:desktop-ssh-fixture'); await f.app.press('id:desktop-ssh-refresh');
    await f.app.press('id:instances-settings-close'); await f.app.press('id:instances-header-open'); await f.app.waitFor('id:desktop-header-services-instance-row-connection:fixture-connection');
    expect(f.app.texts()).toContain('SSH'); expect(f.app.texts()).toContain('Unknown'); expect(f.app.shows('id:desktop-header-services-instance-row-ssh:fixture')).toBe(false);
    const calls = f.calls().length; await f.app.press('id:desktop-header-services-instance-refresh'); expect(f.calls()).toHaveLength(calls);
    await f.control('rename', 'Renamed committed'); await f.app.waitFor('text:Renamed committed'); expect(f.calls()).toHaveLength(calls);
    await f.control('invalid', true); await f.app.waitFor('id:desktop-header-services-error'); expect(f.app.texts()).toContain('Renamed committed'); expect(f.app.enabled('id:desktop-header-services-instance-switch-connection:same-url')).toBe(false);
    await f.control('invalid', false); await f.app.press('id:desktop-header-services-instance-refresh'); expect(f.app.shows('id:desktop-header-services-error')).toBe(false); expect(f.calls()).toHaveLength(calls);
  });
  test(platform + ' exact switch callback waits original guard, fences changed authorization; Add stays callback-only', async () => {
    const f = await launch(); await f.app.press('id:instances-header-open'); await f.app.waitFor('id:desktop-header-services-instance-row-connection:same-url');
    await f.control('hold', true); await f.app.press('id:desktop-header-services-instance-switch-connection:same-url'); await f.control('auth'); await f.control('release');
    expect(f.events().some(event => event.event === 'switch-commit')).toBe(false); expect(f.events().some(event => event.event === 'switch-stale')).toBe(true);
    await f.control('hold', false); await f.app.press('id:desktop-header-services-instance-add'); expect(f.events().some(event => event.event === 'add-commit')).toBe(true);
    expect(f.calls().every(name => name === 'desktop.ssh.capabilities')).toBe(true); expect(f.app.requests()).toHaveLength(0);
  });
  test(platform + ' idle SSH Connect uses original confirmation and unique controller; unknown is retained into original close guard', async () => {
    const f = await launch(); await seedOwner(f); await f.app.press('id:instances-header-open'); await f.app.waitFor('id:desktop-header-services-instance-connect-ssh:fixture');
    f.app.onDialog(() => 'Cancel'); await f.app.press('id:desktop-header-services-instance-connect-ssh:fixture'); expect(f.calls().filter(name => name === 'desktop.ssh.start')).toHaveLength(0);
    await f.app.press('id:instances-native-lose-start'); await f.app.waitFor('text:control=lose-start');
    f.app.onDialog(() => 'Connect'); await f.app.press('id:desktop-header-services-instance-connect-ssh:fixture'); await f.app.waitFor('text:owner=true;unknown=true;busy=false');
    expect(f.calls().filter(name => name === 'desktop.ssh.start')).toHaveLength(1); expect(f.app.enabled('id:desktop-header-services-instance-connect-ssh:fixture')).toBe(false);
    const count = f.calls().length; await f.app.press('id:desktop-header-services-instance-refresh'); expect(f.calls()).toHaveLength(count);
    await f.app.press('id:instances-header-close'); await f.app.press('id:instances-settings-open'); await f.app.waitFor('id:desktop-ssh-unknown');
    expect(f.app.texts()).toContain('guard=ready;dirty=false;pending=true'); await f.app.press('id:instances-settings-close'); expect(f.app.shows('id:instances-original-settings')).toBe(true);
    expect(f.calls().filter(name => name === 'desktop.ssh.start')).toHaveLength(1);
  });
  test(platform + ' original Settings dirty confirmation survives projection observers without a second slot/editor', async () => {
    const f = await launch(); await f.app.press('id:instances-settings-open'); await f.app.waitFor('id:desktop-ssh-fixture'); await f.app.press('id:desktop-ssh-fixture'); await f.app.type('id:desktop-ssh-label', ' keep');
    await f.app.waitFor('text:guard=ready;dirty=true;pending=false'); f.app.onDialog(() => 'Cancel'); await f.app.press('id:instances-settings-close'); expect(f.app.value('id:desktop-ssh-label')).toBe('Fixture SSH keep');
    await f.app.press('id:instances-header-open'); expect(f.app.count('id:desktop-ssh-label')).toBe(1); expect(f.app.shows('id:desktop-header-services-instance')).toBe(false);
    expect(f.calls().filter(name => name === 'desktop.ssh.save')).toHaveLength(0); f.app.onDialog(() => 'Discard'); await f.app.press('id:instances-settings-close'); await f.app.waitFor('id:instances-original-settings', { state: 'gone' });
    expect(f.app.shows('id:desktop-header-services-instance')).toBe(true);
  });
}

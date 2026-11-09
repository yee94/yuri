import { cleanup, effect, host, lifecycle, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { language } from './i18n';
import { app, captureHostOperation, loadConnections } from './state';
import { SettingsAbout } from './settings-about';
import { createNativeDesktopHeaderUpdateRoot } from './desktop-header-update-root';
import { createDesktopHeaderUpdateOwner } from './desktop-header-update';
import { aboutReadResponse, createSettingsAbout, type AboutDependencies } from './settings-about-core';
import { bindRawRequest, native } from './runtime';
import { aboutDiagnosticsCall } from './settings-about-diagnostics';
import { createDesktopHeaderServices, type DesktopHeaderServicesSnapshot } from './desktop-header-services';
import { NativeDesktopHeaderInstance } from './desktop-header-services-view';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';

/** Standalone, synthetic native ports only. Does not mount YuriNativeApp or a real updater. */
function Content(props: { delayed: boolean }) {
  const mounted = app.connection()!, identity = JSON.stringify([mounted.id, mounted.url, mounted.authorizationID]);
  const current = () => { const value = app.connection(); return JSON.stringify([value?.id, value?.url, value?.authorizationID]) === identity; };
  const operation = signal(captureHostOperation());
  let waiting = props.delayed, release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dependencies = (captured: ReturnType<typeof captureHostOperation>): AboutDependencies => ({
    current: () => current() && captured.current(), hostID: captured.scope?.hostID ?? null,
    read: async path => {
      if (path === '/api/system/update' && waiting) await gate;
      if (!current() || !captured.current()) throw new Error('fixture_stale');
      const response = await bindRawRequest(captured.scope)(path);
      if (!current() || !captured.current()) throw new Error('fixture_stale');
      return aboutReadResponse(path, response);
    },
    call: (name, input) => aboutDiagnosticsCall(native, name, input),
  });
  const injected = props.delayed ? createSettingsAbout(dependencies(operation())) : null;
  let windowAlive = true;
  const root = !injected ? createNativeDesktopHeaderUpdateRoot({ current: () => windowAlive, operation, committed: () => {
    const connection = app.connection(), host = app.runtimeScope();
    return connection && host ? { host, authorityKey: JSON.stringify([connection.id, connection.url, connection.authorizationID]) } : null;
  } }) : null;
  const source = injected ? { ...createDesktopHeaderUpdateOwner({ about: injected, current }), updateOperation: (next: ReturnType<typeof captureHostOperation>) => injected.replaceLane(dependencies(next)) }
    : { ...root!, get about() { return root!.about()!; }, updateOperation(next: ReturnType<typeof captureHostOperation>) { operation.set(next); root!.reconcile(); } };
  const header = signal(false), settings = signal(false), draft = signal('Retained draft');
  const snapshot = signal<DesktopHeaderServicesSnapshot | null>(null), blocked = signal(false), disposeBlocked = signal(false);
  const protection = createDesktopSettingsContentProtection({ page: 'about', active: () => settings() && lifecycle() === 'active', changed: () => {}, unavailable: async () => {} });
  const services = createDesktopHeaderServices({ current, operation, update: source.port, changed: value => snapshot.set(value) });
  snapshot.set(services.snapshot());
  effect(() => {
    const active = header() && !settings() && lifecycle() === 'active'; operation();
    untracked(() => services.update({ tab: header() ? 'instance' : null, active }));
  });
  cleanup(() => { windowAlive = false; services.dispose(); protection.dispose(); if (!source.dispose()) source.retire(); });
  host.on<{ action: string }>('update.fixture.control', value => {
    if (value.action === 'refresh') void services.refreshInstance();
    if (value.action === 'release') { waiting = false; release?.(); }
    if (value.action === 'synthetic-unknown') {
      // Test-only injected submitter, not runtime.request/POST or a native update capability.
      source.about.replaceLane({ ...dependencies(operation()), submitUpdate: async () => { throw new Error('Synthetic lost ACK'); } });
      void source.about.prepareUpdate().then(() => source.about.confirmUpdate());
    }
    if (value.action === 'dispose') disposeBlocked.set(!source.dispose());
    if (value.action === 'force-close') settings.set(false);
    if (value.action === 'adopt') void loadConnections().then(() => { const next = captureHostOperation(); source.updateOperation(next); operation.set(next); });
    if (value.action === 'guard') void protection.snapshot().requestLeave().then(allowed => blocked.set(!allowed));
  });
  return <View class="flex-1 bg-background gap-2">
    <View class="flex-row gap-2">
      <Button testID="update-open-header" onPress={() => header.set(true)}><Text>Instance</Text></Button>
      <Button testID="update-hide-header" onPress={() => header.set(false)}><Text>Close Instance</Text></Button>
      <Button testID="update-open-settings" onPress={() => settings.set(true)}><Text>About</Text></Button>
      <Button testID="update-close-settings" onPress={() => { void protection.snapshot().requestLeave().then(allowed => { blocked.set(!allowed); if (allowed) settings.set(false); }); }}><Text>Close About</Text></Button>
    </View>
    <If when={blocked()}><Text testID="update-guard-blocked">Guard blocked</Text></If>
    <If when={disposeBlocked()}><Text testID="update-dispose-blocked">Unknown source retained</Text></If>
    <If when={header() && !settings()}><NativeDesktopHeaderInstance owner={services} snapshot={snapshot()!} /></If>
    <If when={settings() && !disposeBlocked() && !!source.about}><DesktopSettingsPublisher.Provider value={protection}><SettingsAbout active owner={source.about} /></DesktopSettingsPublisher.Provider></If>
    <Input testID="update-composer" value={draft()} onChange={event => draft.set(event.value)} />
  </View>;
}
function Fixture() {
  const ready = signal(false), delayed = signal(false);
  void loadConnections().then(() => native<boolean>('update.fixture.mode')).then(value => { delayed.set(value); ready.set(true); });
  return <If when={ready()}><Content delayed={delayed()} /></If>;
}
language.set('en'); mount(Fixture);

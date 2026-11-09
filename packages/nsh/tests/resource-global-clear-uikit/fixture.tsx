import { cleanup, effect, host, mount, safeArea, signal, untracked, Scroll, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { ResourcePreviewPage } from '../../resource-navigation';
import { createResourceConnectionClear, type ResourceConnectionExit } from '../../resource-retirement';
import { app } from '../../state';
import { connectionSnapshotFrom, native } from '../../runtime';
import { language } from '../../i18n';
import { installProductionConnectionEffect } from './connection-effect';

if (host.params.resourceGlobalClearSyntheticOnly !== true) throw Error('Isolated synthetic fixture required');
language.set('en');
type Route = { kind: 'root' | 'resource' | 'late'; token: number };
const nav = createNavStack<Route>([{ kind: 'root', token: 0 }]);
const resourceConnectionClear = createResourceConnectionClear(nav);
const ready = signal(false), enabled = signal(false), audit = signal(''), failure = signal(false);
let serial = 0;
let pendingSnapshot: ReturnType<typeof connectionSnapshotFrom> | undefined, lastApplied: string | null | undefined;
const bypassGUI = { guiPreview: false };
function report(event: string, route: number) { host.post('fixture.globalClear.event', { event, route }); }
function register(route: Route, owner: ResourceConnectionExit) {
  return resourceConnectionClear.register(route, { retireForConnection(retry) {
    const flight = owner.retireForConnection(retry), snapshot = pendingSnapshot;
    report('globalClearAdmitted', route.token);
    if (snapshot && snapshot.selected !== lastApplied) {
      lastApplied = snapshot.selected;
      // Run the follow-up after clear has captured routes and admitted retirement,
      // independent of whether this SDK flushes effects immediately or in a batch.
      void Promise.resolve().then(() => {
        app.runtimeScope.set(snapshot.runtimeScope);
        const late: Route = { kind: 'late', token: ++serial };
        nav.push(late); report('lateRouteAdded', late.token);
        return native('fixture.globalClear.applied', { selected: snapshot.selected });
      }).catch(() => failure.set(true));
    }
    return flight;
  } });
}
export function GlobalClearFixtureToolbar(props: { enabled: boolean; control(action: string): void; inspect(): void }) {
  const button = 'flex-1 min-w-0 h-11 min-h-11 items-center justify-center px-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40';
  return <View testID="resource-global-toolbar" class="w-full shrink-0 gap-2 p-2">
    <View class="w-full flex-row gap-2">
      <Button testID="resource-global-enable" class={button} accessibilityLabel="Enable isolated controls" onPress={() => props.control('enable')}><Text style={{ numberOfLines: 1 }}>Enable controls</Text></Button>
      <Button testID="resource-global-audit" class={button} accessibilityLabel="Read metadata audit" onPress={() => props.inspect()}><Text style={{ numberOfLines: 1 }}>Read audit</Text></Button>
    </View>
    <View class="w-full flex-row gap-2">
      <Button testID="resource-global-arm" class={button} accessibilityLabel="Arm one switch before attach" disabled={!props.enabled} onPress={() => props.control('arm')}><Text style={{ numberOfLines: 1 }}>Arm one switch</Text></Button>
      <Button testID="resource-global-arm-twice" class={button} accessibilityLabel="Arm two switches before attach" disabled={!props.enabled} onPress={() => props.control('armTwice')}><Text style={{ numberOfLines: 1 }}>Arm two switches</Text></Button>
    </View>
  </View>;
}
function Fixture() {
  // The builder supplies the actual application.tsx effect, not a second clear implementation.
  installProductionConnectionEffect(resourceConnectionClear);
  let previous = nav.routes();
  effect(() => {
    const routes = nav.routes();
    untracked(() => { for (const route of previous) if (!routes.includes(route)) report('routeRemoved', route.token); previous = routes; });
  });
  cleanup(host.on('fixture.globalClear.connection', value => {
    const snapshot = connectionSnapshotFrom(value);
    pendingSnapshot = snapshot;
    // ID changes first: the production clear, not a local scope boundary, owns admission.
    app.connection.set(snapshot.connections.find(item => item.id === snapshot.selected) ?? null);
  }));
  void native('connection.list').then(value => {
    const snapshot = connectionSnapshotFrom(value);
    app.connection.set(snapshot.connections.find(item => item.id === snapshot.selected) ?? null);
    app.runtimeScope.set(snapshot.runtimeScope); ready.set(true);
  }).catch(() => failure.set(true));
  const inspect = () => { void native('fixture.globalClear.audit').then(value => audit.set(JSON.stringify(value))).catch(() => failure.set(true)); };
  const control = (action: string) => { void native('fixture.globalClear.control', { action }).then(() => { if (action === 'enable') enabled.set(true); inspect(); }).catch(() => failure.set(true)); };
  return <View testID="resource-global-safe-root" class="flex-1 bg-background" style={{ paddingTop: safeArea().top, paddingBottom: safeArea().bottom, paddingLeft: safeArea().left, paddingRight: safeArea().right }}>
    <GlobalClearFixtureToolbar enabled={enabled()} control={control} inspect={inspect} />
    <If when={ready()}><NavStack state={nav} class="flex-1 min-h-0 min-w-0">{route => {
      if (route.kind === 'resource') return <ResourcePreviewPage {...bypassGUI} title="Synthetic global clear HTML" directory="/fixture" path="/fixture/index.html"
        expectedHost={app.runtimeScope()} active={nav.routes().at(-1) === route}
        connectionExit={owner => register(route, owner)} onClose={() => { if (nav.routes().at(-1) === route) nav.pop(); }} />;
      return <NavPage title={route.kind === 'late' ? 'Later synthetic route' : 'Global clear UIKit fixture'} class="flex-1 bg-background"><Scroll class="flex-1" contentClass="p-4 gap-3">
        <Text testID={route.kind === 'late' ? 'resource-global-late-route' : 'resource-global-root'}>syntheticOnly · no Host/network/credentials · full AppRoutes not proved</Text>
        <Button testID="resource-global-open" class="min-h-11 min-w-11 items-center justify-center px-3 rounded-xl bg-secondary" disabled={route.kind !== 'root'} onPress={() => { const resource: Route = { kind: 'resource', token: ++serial }; nav.push(resource); report('resourceRouteAdded', resource.token); }}><Text>Open production resource preview</Text></Button>
        <Text testID="resource-global-route-count">{String(nav.routes().length)}</Text>
        <Text testID="resource-global-audit-value">{audit()}</Text>
        <Text testID="resource-global-build">{String(host.params.buildID)}</Text>
        <If when={failure()}><Text testID="resource-global-js-failure">Synthetic fixture operation failed</Text></If>
      </Scroll></NavPage>;
    }}</NavStack></If>
  </View>;
}
mount(Fixture);

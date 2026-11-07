import { effect, host, lifecycle, mount, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from '../../i18n';
import { list, record, text, type Project, type Row } from '../../model';
import { NativeNewSessionPage } from '../../new-session-page';
import { native } from '../../runtime';
import { app, captureHostOperation, loadConnections } from '../../state';

// Test-only navigation/audit. The draft and both pickers are the unchanged
// production components, at the full native viewport with no fixture overlay.
if (host.params.newSessionUIKitFixture !== true) throw new Error('This fixture requires the isolated synthetic UIKit Host');
const projects: Project[] = list(host.params.projects).map(row => ({ id: text(row.id), name: text(row.name), path: text(row.path) }));
if (projects.length !== 2 || projects.some(project => !project.id || !project.path || !project.name)) throw new Error('Invalid fixture projects');
language.set('en');
type Route = { kind: 'root' } | { kind: 'draft'; project: Project } | { kind: 'audit' };
const nav = createNavStack<Route>([{ kind: 'root' }]);
const fixtureError = signal('');

function Audit() {
  const snapshot = signal<Row>({}), error = signal(''), pending = signal(false);
  async function inspect() {
    if (pending()) return;
    pending.set(true); error.set('');
    try { snapshot.set(record(await native('fixture.newSession.audit'))); }
    catch (failure) { error.set(String(failure)); }
    finally { pending.set(false); }
  }
  void inspect();
  return <NavPage title="Synthetic audit" headerBackTitle="" class="flex-1 bg-background"><View class="flex-1 p-4 gap-2">
    <Button testID="new-session-uikit-audit-refresh" disabled={pending()} onPress={() => { void inspect(); }}><Text>Refresh audit</Text></Button>
    <If when={!!error()}><Text testID="new-session-uikit-audit-error" class="text-destructive">{error()}</Text></If>
    <Scroll class="flex-1" contentClass="gap-3 pb-8">
      <Each of={['captures', 'settingsWrites', 'configWrites', 'mkdirCalls', 'requests', 'reads', 'rejected', 'deniedSessionWrites']}>{key => <Text testID={`new-session-uikit-count-${key()}`} accessibilityLabel={`${key()}:${String(snapshot()[key()] ?? 'loading')}`} class="text-foreground">{`${key()}:${String(snapshot()[key()] ?? 'loading')}`}</Text>}</Each>
      <Each of={['lastCapture', 'settings', 'projectFiles', 'journal']}>{key => <Text testID={`new-session-uikit-${key()}`} accessibilityLabel={JSON.stringify(snapshot()[key()] ?? null)} class="text-foreground" style={{ fontSize: 11 }}>{`${key()}: ${JSON.stringify(snapshot()[key()] ?? null)}`}</Text>}</Each>
      <Text testID="new-session-uikit-snapshot" accessibilityLabel={JSON.stringify(snapshot())} class="text-muted-foreground" style={{ fontSize: 10 }}>{JSON.stringify(snapshot())}</Text>
    </Scroll>
  </View></NavPage>;
}

function Fixture() {
  const ready = signal(false);
  effect(() => {
    if (lifecycle() !== 'active') return;
    untracked(() => { void loadConnections().then(() => {
      if (!captureHostOperation().current()) return;
      app.projects.set(projects); ready.set(true);
    }).catch(failure => fixtureError.set(String(failure))); });
  });
  return <If when={ready()} else={<View class="p-5"><If when={!!fixtureError()} else={<Text>Loading synthetic connection snapshot</Text>}><Text testID="new-session-uikit-fixture-error" class="text-destructive">{fixtureError()}</Text></If></View>}><NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'audit') return <Audit />;
    if (route.kind === 'draft') return <NativeNewSessionPage project={route.project} projects={projects} active={nav.routes().at(-1) === route}
      onSelection={(directory, selection, agent) => {
        void native('fixture.newSession.capture', { directory, ...(selection ? { selection } : {}), ...(agent ? { agent } : {}) }).catch(failure => fixtureError.set(String(failure)));
      }}
      onOpenChat={() => { throw new Error('Session handoff is disabled in this fixture'); }} />;
    return <NavPage title="New Session UIKit QA" headerBackTitle="" class="flex-1 bg-background"><View class="flex-1 p-5 gap-4">
      <Text class="text-foreground">Synthetic memory only. No Host, network, Keychain or model invocation.</Text>
      <Each of={projects}>{project => <Button testID={`new-session-uikit-open-${project().id}`} onPress={() => nav.push({ kind: 'draft', project: project() })}><Text class="text-foreground">{project().name}</Text></Button>}</Each>
      <Button testID="new-session-uikit-open-audit" onPress={() => nav.push({ kind: 'audit' })}><Text class="text-foreground">Inspect captures and writes</Text></Button>
      <Text testID="new-session-uikit-build" class="text-muted-foreground">{String(host.params.buildID)}</Text>
      <If when={!!fixtureError()}><Text testID="new-session-uikit-fixture-error" class="text-destructive">{fixtureError()}</Text></If>
    </View></NavPage>;
  }}</NavStack></If>;
}
mount(Fixture);

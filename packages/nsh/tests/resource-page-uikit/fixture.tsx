import { effect, host, lifecycle, mount, signal, Text, View, Scroll } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { NativeAppearanceSync, nativeAppearance } from '../../appearance';
import { ResourceFilesPage, ResourcePreviewPage } from '../../resource-navigation';
import { language } from '../../i18n';
import { native } from '../../runtime';
import { app, captureHostOperation, loadConnections } from '../../state';

// Test launcher only; every resource surface/action below belongs to production.
if (host.params.resourcePageSyntheticOnly !== true) throw new Error('syntheticOnly fixture required');
language.set('en');
type Route = { kind: 'root' } | { kind: 'file'; path: string } | { kind: 'files' };
const nav = createNavStack<Route>([{ kind: 'root' }]);
const ready = signal(false), foreground = signal(false), error = signal(''), audit = signal('');

function Fixture() {
  effect(() => {
    if (lifecycle() !== 'active') { foreground.set(false); return; }
    let alive = true;
    foreground.set(false);
    void loadConnections({ forceReconnect: true }).then(() => {
      if (alive && captureHostOperation().current()) { ready.set(true); foreground.set(true); }
    }).catch(cause => { if (alive) error.set(String(cause)); });
    return () => { alive = false; };
  });
  const inspect = () => { void native('fixture.resourcePage.audit').then(value => audit.set(JSON.stringify(value))).catch(cause => error.set(String(cause))); };
  return <View class="flex-1 bg-background"><NativeAppearanceSync />
    <If when={ready() && !!nativeAppearance.current()} else={<Text testID="resource-page-admission">{error() || nativeAppearance.error() || 'Synthetic connection / appearance admission pending'}</Text>}>
      <NavStack state={nav} class="flex-1">{route => {
        const active = () => foreground() && nav.routes().at(-1) === route;
        if (route.kind === 'file') return <ResourcePreviewPage title={route.path.split('/').pop()!} directory="/fixture" path={route.path} expectedHost={app.runtimeScope()} active={active()} onClose={() => nav.pop()} onOpen={path => nav.push({ kind: 'file', path })} />;
        if (route.kind === 'files') return <ResourceFilesPage title="Synthetic resources" directory="/fixture" expectedHost={app.runtimeScope()} active={active()} onClose={() => nav.pop()} />;
        return <NavPage title="Synthetic resource UIKit QA" class="flex-1 bg-background"><Scroll class="flex-1" contentClass="p-4 gap-3">
          <Text class="text-foreground">syntheticOnly · memory transport · no real Host · AppRoutes not proved</Text>
          <Each of={['index.html', 'note.md', 'plain.txt', 'art.svg']}>{name => <Button testID={`resource-page-open-${name().split('.')[0]}`} onPress={() => nav.push({ kind: 'file', path: '/fixture/' + name() })}><Text>{name()}</Text></Button>}</Each>
          <Button testID="resource-page-open-files" onPress={() => nav.push({ kind: 'files' })}><Text>Production resources browser</Text></Button>
          <Button testID="resource-page-watch-version" onPress={() => { void native('fixture.resourcePage.bumpStat').then(inspect).catch(cause => error.set(String(cause))); }}><Text>Advance synthetic stat version (same bytes)</Text></Button>
          <Button testID="resource-page-audit" onPress={inspect}><Text>Read bounded native audit</Text></Button>
          <Text testID="resource-page-audit-value" class="text-foreground">{audit()}</Text>
          <Text testID="resource-page-build" class="text-muted-foreground">{String(host.params.buildID)}</Text>
          <Text testID="resource-page-error" class="text-destructive">{error()}</Text>
        </Scroll></NavPage>;
      }}</NavStack>
    </If>
  </View>;
}
mount(Fixture);

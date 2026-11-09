import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { record, type Project } from './model';
import { request } from './runtime';
import { loadConnections, refresh } from './state';
import { ProjectsHome } from './projects';
import { NativeNewSessionPage } from './new-session-page';
import { NativeAppearanceSync } from './appearance';
import { deviceChatPreferences, deviceChatPreferenceStore } from './settings-preferences-device';
import { language } from './i18n';

/** Real production pages in owned navigation; the out-of-band fake Host audit is test UI. */
function Fixture() {
  // Own App exercises real Projects/NewSession pages without mounting the production startup roots.
  language.set('en');
  const nav = createNavStack<{ kind: 'home' } | { kind: 'new'; project?: Project }>([{ kind: 'home' }]);
  const audit = signal('not inspected'), ready = signal(false), error = signal('');
  const unexpected = () => { throw new Error('Unexpected production new-session fixture navigation'); };
  void Promise.all([loadConnections(), deviceChatPreferenceStore.load()]).then(refresh).then(() => ready.set(true)).catch(failure => error.set(String(failure)));
  let inspections = 0;
  return <View class="flex-1 bg-background">
    <NativeAppearanceSync />
    <If when={!!error()}><Text>{error()}</Text></If>
    <If when={ready()}><NavStack state={nav} class="flex-1">{route => route.kind === 'new'
      ? <NativeNewSessionPage project={route.project} deviceChatPreferences={deviceChatPreferences} active={nav.routes().at(-1) === route} onOpenChat={unexpected} />
      : <NavPage title="Projects" headerBackTitle=""><ProjectsHome active={nav.routes().at(-1) === route} onNewSession={project => nav.push({ kind: 'new', project })}
        onOpenChat={unexpected} onOpenProject={unexpected} onOpenFiles={unexpected} onOpenChanges={unexpected} onAddProject={unexpected} onEditProject={unexpected} /></NavPage>
    }</NavStack></If>
    <Button testID="new-session-production-audit" class="min-h-11 bg-secondary" onPress={() => {
      void request('/__fixture/new-session-production/audit').then(value => {
        const stats = record(value);
        audit.set(`audit:${++inspections} writes:${stats.writes} creates:${stats.creates} prompts:${stats.prompts}`);
      });
    }}><Text class="text-foreground">Inspect fake Host writes</Text></Button>
    <Text testID="new-session-production-stats" class="text-foreground">{audit()}</Text>
  </View>;
}

mount(Fixture);

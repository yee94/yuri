import { host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ProjectsHome } from './projects';
import { app, loadConnections } from './state';
import { language } from './i18n';

/** Synthetic, memory-only Host. Main owns starting this fixture on UIKit. */
function ProjectsOrderFixture() {
  const ready = signal(false), audit = signal(''), opened = signal(''), error = signal('');
  language.set('en');
  void loadConnections().then(() => {
    app.projects.set([{ id: 'order-project', name: 'Projects drag fixture', path: '/fixture/repo' }]);
    ready.set(true);
  }).catch(failure => error.set(String(failure)));
  return <View class="flex-1 bg-background">
    <View class="flex-row"><Button testID="projects-order-audit" onPress={() => { void host.call('projects.order.audit', {}).then(value => audit.set(JSON.stringify(value))); }}><Text>Read order audit</Text></Button>
      <Button testID="projects-order-fail-read" onPress={() => { void host.call('projects.order.failRead', {}).then(() => audit.set('Next order GET fails')); }}><Text>Fail next order GET</Text></Button></View>
    <Text testID="projects-order-audit-result">{audit()}</Text><Text>{error() || opened()}</Text>
    <If when={ready()}><ProjectsHome onOpenChat={target => opened.set(`Opened ${target.id}`)} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => {}} onEditProject={() => {}} /></If>
  </View>;
}
mount(ProjectsOrderFixture);

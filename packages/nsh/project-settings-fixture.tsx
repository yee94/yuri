import { mount, signal, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { Text } from 'nsh';
import { language } from './i18n';
import { SettingsPage, type SettingsRoute } from './settings';
import { native } from './runtime';

language.set('en');
function ProjectSettingsFixture() {
  const nav = createNavStack<SettingsRoute | { page: 'fixture' }>([{ page: 'fixture' }]);
  const audit = signal('');
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <View class="flex-1"><NavStack state={nav} class="flex-1">{route => route.page === 'fixture'
    ? <NavPage title="Own project settings fixture"><Button testID="project-settings-open" onPress={() => nav.push({ page: 'projects', entity: 'catalog-do-not-use' })}><Text>Open fixture project</Text></Button></NavPage>
    : <SettingsPage {...callbacks} page="projects" entity={route.entity} create={route.create} target={route.target} directory="/fixture/other-focus-worktree" />}</NavStack>
    <Button testID="project-fixture-audit" onPress={() => { audit.set(''); void native<Record<string, unknown>>('projectSettings.fixture.audit').then(value => audit.set(JSON.stringify(value)), error => audit.set(String(error))); }}><Text>Audit fixture</Text></Button>
    <Text testID="project-fixture-audit-result">{audit()}</Text>
  </View>;
}
mount(ProjectSettingsFixture);

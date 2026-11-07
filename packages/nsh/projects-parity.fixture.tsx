import { host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ProjectsHome } from './projects';
import { projectsAttention } from './projects-attention';
import { app, epoch, observeRuntime } from './state';
import { language } from './i18n';
import { request } from './runtime';
import { sessionsFrom } from './model';

function ProjectsParityFixture() {
  language.set('en');
  app.connection.set({ id: 'projects-parity', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  app.projects.set([{ id: 'fixture', name: 'Projects parity fixture', path: '/fixture/repo' }]);
  observeRuntime(() => {});
  const opened = signal(''), audit = signal(''), catalogReady = signal(false);
  void request('/api/yuri/session-index').then(value => { app.sessions.set(sessionsFrom(value)); catalogReady.set(true); });
  const scope = () => JSON.stringify([epoch(), app.connection()?.id]);
  return <View class="flex-1">
    <Button testID="projects-fixture-audit" onPress={() => { void host.call('projects.fixture.audit', {}).then(value => audit.set(JSON.stringify(value))); }}><Text>Read fixture audit</Text></Button>
    <Text>{audit()}</Text>
    <Text>{catalogReady() ? 'Root catalog ready' : ''}</Text>
    <Button testID="projects-fixture-complete" disabled={!catalogReady()} onPress={() => { void host.call('projects.fixture.complete', {}); }}><Text>Complete fixture round</Text></Button>
    <Button testID="projects-fixture-back" onPress={() => { opened.set(''); projectsAttention.setViewedSession(scope(), null); }}><Text>Leave viewed fixture</Text></Button>
    <Text>{opened()}</Text>
    <ProjectsHome onOpenChat={target => { opened.set(`Viewed: ${target.id}`); projectsAttention.setViewedSession(scope(), target.id); }} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => {}} onEditProject={() => {}} />
  </View>;
}
mount(ProjectsParityFixture);

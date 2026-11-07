import { host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ProjectsHome } from './projects';
import { projectsAttention } from './projects-attention';
import { app, epoch, observeRuntime } from './state';
import { language } from './i18n';
import { request } from './runtime';
import { sessionsFrom } from './model';

function ProjectsAttentionFixture() {
  language.set('en');
  app.connection.set({ id: 'attention-fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  app.projects.set([{ id: 'fixture', name: 'Attention fixture', path: '/fixture/repo' }]);
  observeRuntime(() => {});
  const ready = signal(false), audit = signal('');
  void request('/api/yuri/session-index').then(value => { app.sessions.set(sessionsFrom(value)); ready.set(true); });
  const scope = () => JSON.stringify([epoch(), app.connection()?.id]);
  return <View class="flex-1">
    <Text>{ready() ? 'Attention catalog ready' : ''}</Text>
    <Each of={['question', 'permission', 'fail', 'recover', 'audit']}>{action => <Button testID={`attention-fixture-${action()}`} onPress={() => { void host.call('projects.attention.fixture', { action: action() }).then(value => { if (action() === 'audit') audit.set(JSON.stringify(value)); }); }}><Text>{action()}</Text></Button>}</Each>
    <Text>{audit()}</Text>
    <ProjectsHome onOpenChat={target => projectsAttention.setViewedSession(scope(), target.id)} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => {}} onEditProject={() => {}} />
  </View>;
}
mount(ProjectsAttentionFixture);

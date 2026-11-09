import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { app, captureHostRequest, refresh, run } from './state';
import { language } from './i18n';
import { ProjectsHome } from './projects';
import { projectsFixtureAdmission } from './tests/projects-fixture-admission';

function RootCatalogFixture() {
  language.set('en');
  const opened = signal('');
  const admission = projectsFixtureAdmission(() => { void run(refresh); });
  return <If when={admission.ready()} else={<Text>{admission.error() || 'Loading isolated Host'}</Text>}><View class="flex-1">
    <Text>{app.notificationCatalog().complete ? 'Catalog confirmed' : 'Catalog incomplete'}</Text>
    <Text>{app.error() ? 'Root failed' : 'Root usable'}</Text>
    <Text>{app.online() ? 'Host reachable' : 'Host unknown'}</Text>
    <Text>{app.loading() ? 'Catalog reading' : 'Catalog idle'}</Text>
    <Button testID="fixture-recover-directory" onPress={() => { void run(async () => { await captureHostRequest()('/fixture/healthy', 'POST'); await refresh(); }); }}><Text>Recover isolated directory</Text></Button>
    <ProjectsHome active={true} onOpenChat={target => opened.set(target.id)} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => {}} onEditProject={() => {}} />
    <Text>{opened() ? `Opened ${opened()}` : ''}</Text>
    <Text>{app.sessions().some(row => row.id === 'failed-seed') ? 'Saved failed row retained' : 'Failed directory confirmed empty'}</Text>
  </View></If>;
}
mount(RootCatalogFixture);

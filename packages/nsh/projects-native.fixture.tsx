import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ProjectsHome } from './projects';
import { app, captureHostRequest, observeRuntime } from './state';
import { language } from './i18n';
import { projectsFixtureAdmission } from './tests/projects-fixture-admission';

function ProjectsFixture() {
  const opened = signal(''), visible = signal(true), audit = signal('');
  language.set('en');
  const admission = projectsFixtureAdmission(() => app.projects.set([{ id: 'p', name: 'Native projects fixture', path: '/repo' }]));
  observeRuntime(() => {});
  return <If when={admission.ready()} else={<Text>{admission.error() || 'Loading Projects fixture connection'}</Text>}><View class="flex-1"><Button testID="fixture-projects-tab" onPress={() => visible.set(!visible())}><Text>Toggle Projects tab</Text></Button><Button testID="fixture-projects-audit" onPress={() => { void captureHostRequest()('/fixture/projects-read-count').then(value => audit.set(String(value))); }}><Text>Audit directory reads</Text></Button><Text>{audit()}</Text><View class="flex-1" style={{ display: visible() ? 'flex' : 'none' }}><ProjectsHome active={visible()} onOpenChat={target => opened.set(target.title)} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => opened.set('Add project requested')} onEditProject={() => {}} /></View><Text>{opened()}</Text></View></If>;
}
mount(ProjectsFixture);

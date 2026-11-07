import { mount, signal, Text, View } from 'nsh';
import { ProjectsHome } from './projects';
import { app, observeRuntime } from './state';
import { language } from './i18n';

function ProjectsFixture() {
  const opened = signal('');
  language.set('en');
  app.connection.set({ id: 'fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  app.projects.set([{ id: 'p', name: 'Native projects fixture', path: '/repo' }]);
  observeRuntime(() => {});
  return <View class="flex-1"><ProjectsHome onOpenChat={target => opened.set(target.title)} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => opened.set('Add project requested')} onEditProject={() => {}} /><Text>{opened()}</Text></View>;
}
mount(ProjectsFixture);

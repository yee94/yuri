import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { ProjectsSearchPage, type ProjectSearchCommand } from './projects-search';
import { language } from './i18n';
import { app } from './state';
import { native } from './runtime';

function ProjectsSearchFixture() {
  language.set('en');
  app.connection.set({ id: 'search-fixture', label: 'Search fixture', url: 'https://fixture.invalid', lastUsedAt: 0 });
  const projects = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `needle project ${index}`, path: `/global/project-${index}` }));
  const nav = createNavStack<{ kind: 'root' | 'search' | 'result'; value?: string }>([{ kind: 'root' }]);
  const focus = signal<string | undefined>('/fixture/focus'), audit = signal('');
  const result = (value: string) => nav.push({ kind: 'result', value });
  const commands: ProjectSearchCommand[] = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, title: `needle command ${index}`, group: 'commands' as const, onSelect: () => result(`command:${index}`) })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `settings:${index}`, title: `needle setting ${index}`, group: 'settings' as const, onSelect: () => result(`settings:${index}`) })),
  ];
  return <View class="flex-1">
    <View class="flex-row gap-2 p-2">
      <Button testID="search-fixture-focus-toggle" onPress={() => focus.set(focus() ? undefined : '/fixture/focus')}><Text>Toggle explicit Focus</Text></Button>
      <Button testID="search-fixture-audit" onPress={() => { void native('projectsSearch.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Read fixture audit</Text></Button>
    </View>
    <Text testID="search-fixture-audit-value">{audit()}</Text>
    <NavStack state={nav} class="flex-1">{route => {
      if (route.kind === 'search') return <ProjectsSearchPage focusDirectory={focus()} projects={projects} commands={commands} onOpenProject={project => result(`project:${project.id}:${project.path}`)} onOpenChat={(target, options) => result(`chat:${target.id}:${target.directory}:${options?.messageID ?? 'title'}`)} onOpenFile={(directory, path) => result(`file:${directory}:${path}`)} />;
      if (route.kind === 'result') return <NavPage title="Selected result" headerBackTitle=""><Text>{route.value}</Text></NavPage>;
      return <NavPage title="Search fixture" headerBackTitle=""><Button testID="search-fixture-open" onPress={() => nav.push({ kind: 'search' })}><Text>Open search</Text></Button></NavPage>;
    }}</NavStack>
  </View>;
}
mount(ProjectsSearchFixture);

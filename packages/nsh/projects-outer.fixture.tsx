import { mount, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { ProjectDirectoryPage } from './projects-directory';
import { ProjectsSearchPage } from './projects-search';
import { language } from './i18n';
import { app } from './state';

function ProjectsOuterFixture() {
  language.set('en');
  app.connection.set({ id: 'fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  const nav = createNavStack<{ kind: 'root' | 'directory' | 'search' | 'result'; value?: string }>([{ kind: 'root' }]);
  return <NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'directory') return <ProjectDirectoryPage onAdded={(project, options) => { if (options.openDraft) { nav.pop(); nav.push({ kind: 'result', value: `Draft: ${project.path}` }); } }} />;
    if (route.kind === 'search') return <ProjectsSearchPage focusDirectory="/workspace/focus" commands={[{ id: 'settings', title: 'Fixture settings action', group: 'commands', onSelect: () => nav.push({ kind: 'result', value: 'Settings action reached' }) }]} onOpenChat={(target, options) => nav.push({ kind: 'result', value: `${target.id}:${options?.messageID ?? 'title'}` })} onOpenFile={(directory, path) => nav.push({ kind: 'result', value: `${directory}:${path}` })} />;
    if (route.kind === 'result') return <NavPage title="Result" headerBackTitle=""><Text>{route.value}</Text></NavPage>;
    return <NavPage title="Projects fixture" headerBackTitle=""><View><Button testID="fixture-directory" onPress={() => nav.push({ kind: 'directory' })}><Text>Directory fixture</Text></Button><Button testID="fixture-search" onPress={() => nav.push({ kind: 'search' })}><Text>Search fixture</Text></Button></View></NavPage>;
  }}</NavStack>;
}
mount(ProjectsOuterFixture);

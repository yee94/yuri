import { mount, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { ScheduledHome, ScheduledTaskDetail } from './schedules';
import { app } from './state';
import { language } from './i18n';
import type { ChatTarget, Row } from './model';

type Route = { kind: 'home' } | { kind: 'task'; item: Row } | { kind: 'session'; target: ChatTarget } | { kind: 'edit' };
const nav = createNavStack<Route>([{ kind: 'home' }]);
const onOpenSession = (target: ChatTarget) => nav.push({ kind: 'session', target });
const onEdit = () => nav.push({ kind: 'edit' });
function ScheduleTestApp() {
  language.set('en');
  app.connection.set({ id: 'schedule-host', url: 'https://host.example', label: 'Test', lastUsedAt: 0 });
  app.projects.set([{ id: 'project', path: '/workspace/project', name: 'Native workspace' }]);
  return <NavStack state={nav} class="flex-1 bg-background">{route => {
    if (route.kind === 'task') return <ScheduledTaskDetail active={nav.routes().at(-1) === route} item={route.item} onEdit={onEdit} onOpenSession={onOpenSession} onDeleted={() => nav.pop()} />;
    if (route.kind === 'session') return <NavPage title="Opened native session"><Text>{route.target.id}</Text><Text>{route.target.directory}</Text></NavPage>;
    if (route.kind === 'edit') return <NavPage title="Editor callback"><Button testID="editor-done" onPress={() => nav.pop()}><Text>Done</Text></Button></NavPage>;
    return <NavPage headerVisible={false} headerBackTitle=""><View class="flex-1"><ScheduledHome active={nav.routes().at(-1) === route} onCreate={onEdit} onEdit={onEdit} onOpenSession={onOpenSession} onOpenTask={item => nav.push({ kind: 'task', item })} /></View></NavPage>;
  }}</NavStack>;
}
mount(ScheduleTestApp);

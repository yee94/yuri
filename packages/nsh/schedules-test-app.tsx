import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { ScheduledHome, ScheduledTaskDetail } from './schedules';
import { app, captureHostOperation } from './state';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';
import { language } from './i18n';
import type { ChatTarget, Row } from './model';

type Route = { kind: 'home' } | { kind: 'task'; item: Row } | { kind: 'session'; target: ChatTarget } | { kind: 'edit' };
function ScheduleTestApp() {
  language.set('en');
  const boot = settingsEngineFixtureBoot();
  return <If when={boot.mounted()}><AdmittedSchedules active={boot.active()} /></If>;
}
function AdmittedSchedules(props: { active: boolean }) {
  const nav = createNavStack<Route>([{ kind: 'home' }]), audit = signal('');
  const onOpenSession = (target: ChatTarget) => nav.push({ kind: 'session', target });
  const onEdit = () => nav.push({ kind: 'edit' });
  app.tab.set(2);
  app.projects.set([{ id: 'project', path: '/workspace/project', name: 'Native workspace' }]);
  return <View class="flex-1"><Button testID="schedules-fixture-audit" onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/schedules/audit').then(value => { if (operation.current()) audit.set(JSON.stringify(value)); });
  }}><Text>Inspect synthetic schedule audit</Text></Button><Text>{audit()}</Text><NavStack state={nav} class="flex-1 bg-background">{route => {
    if (route.kind === 'task') return <ScheduledTaskDetail active={props.active && nav.routes().at(-1) === route} item={route.item} onEdit={onEdit} onOpenSession={onOpenSession} onDeleted={() => nav.pop()} />;
    if (route.kind === 'session') return <NavPage title="Opened native session"><Text>{route.target.id}</Text><Text>{route.target.directory}</Text></NavPage>;
    if (route.kind === 'edit') return <NavPage title="Editor callback"><Button testID="editor-done" onPress={() => nav.pop()}><Text>Done</Text></Button></NavPage>;
    return <NavPage headerVisible={false} headerBackTitle=""><View class="flex-1"><ScheduledHome active={props.active && nav.routes().at(-1) === route} onCreate={onEdit} onEdit={onEdit} onOpenSession={onOpenSession} onOpenTask={item => nav.push({ kind: 'task', item })} /></View></NavPage>;
  }}</NavStack></View>;
}
mount(ScheduleTestApp);

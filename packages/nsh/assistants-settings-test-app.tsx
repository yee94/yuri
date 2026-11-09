import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { AssistantDetails, AssistantSettings } from './assistants';
import { BotEditor } from './features';
import { ScheduledTaskDetail } from './schedules';
import { language } from './i18n';
import type { ChatTarget, Row } from './model';
import { app, captureHostOperation } from './state';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';

type Route = { kind: 'settings' } | { kind: 'bot'; bot: Row } | { kind: 'create' } | { kind: 'chat'; target: ChatTarget } | { kind: 'task'; item: Row };
function AssistantSettingsTestApp() {
  language.set('en');
  const boot = settingsEngineFixtureBoot();
  return <If when={boot.mounted()}><AdmittedAssistantSettings active={boot.active()} /></If>;
}
function AdmittedAssistantSettings(props: { active: boolean }) {
  app.projects.set([{ id: 'project', name: 'Native fixture project', path: '/workspace/project' }]);
  app.tab.set(3);
  const nav = createNavStack<Route>([{ kind: 'settings' }]);
  const audit = signal(''), unknownReset = signal(false);
  const onOpenChat = (target: ChatTarget) => nav.push({ kind: 'chat', target });
  return <View class="flex-1"><Button testID="assistants-settings-fixture-unknown-reset" disabled={!props.active || unknownReset()} onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/assistants-settings/reset-scenario', 'PUT', { mode: 'unknown' }).then(() => { if (operation.current()) unknownReset.set(true); });
  }}><Text>Simulate unknown reset result</Text></Button><If when={unknownReset()}><Text>Unknown reset scenario armed</Text></If><Button testID="assistants-settings-fixture-audit" onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/assistants-settings/audit').then(value => { if (operation.current()) audit.set(JSON.stringify(value)); });
  }}><Text>Inspect synthetic Bot settings audit</Text></Button><Text>{audit()}</Text><NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'create') return <BotEditor active={props.active && nav.routes().at(-1) === route} onDone={() => nav.pop()} />;
    if (route.kind === 'chat') return <NavPage title="Opened contact" headerBackTitle=""><Text testID="opened-contact">{route.target.id}</Text></NavPage>;
    if (route.kind === 'task') return <ScheduledTaskDetail active={props.active && nav.routes().at(-1) === route} item={route.item} onEdit={() => {}} onOpenSession={onOpenChat} onDeleted={() => nav.pop()} />;
    if (route.kind === 'bot') return <AssistantDetails active={props.active && nav.routes().at(-1) === route} bot={route.bot} onDone={() => nav.pop()} onOpenChat={onOpenChat} onOpenTask={item => nav.push({ kind: 'task', item })} historyActions={{ clearLabel: 'Clear chat history', confirmDescription: 'Delete this bot’s chat history? This cannot be undone. The bot and its configuration will remain.', clearedLabel: 'Chat history cleared' }} />;
    return <AssistantSettings active={props.active && nav.routes().at(-1) === route} onCreate={() => nav.push({ kind: 'create' })} onEdit={bot => nav.push({ kind: 'bot', bot })} />;
  }}</NavStack></View>;
}
mount(AssistantSettingsTestApp);

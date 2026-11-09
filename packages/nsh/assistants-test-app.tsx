import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { AssistantHome, AssistantDetails } from './assistants';
import { app, captureHostOperation } from './state';
import { language } from './i18n';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';
import type { Row } from './model';

language.set('en');
type Route = { kind: 'root' } | { kind: 'detail'; bot: Row };
function AssistantsTestApp() {
  const boot = settingsEngineFixtureBoot();
  return <If when={boot.mounted()}><AdmittedAssistants active={boot.active()} /></If>;
}
function AdmittedAssistants(props: { active: boolean }) {
  app.tab.set(1);
  const nav = createNavStack<Route>([{ kind: 'root' }]), opened = signal(''), audit = signal('');
  return <View class="flex-1"><Button testID="assistants-fixture-audit" onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/assistants/audit').then(value => { if (operation.current()) audit.set(JSON.stringify(value)); });
  }}><Text>Inspect synthetic Assistant audit</Text></Button><Text>{audit()}</Text><NavStack state={nav} class="flex-1">{route => route.kind === 'root'
    ? <NavPage><AssistantHome active={props.active && nav.routes().at(-1) === route} onCreate={() => {}} onEdit={bot => nav.push({ kind: 'detail', bot })} onOpenChat={target => opened.set(target.id)} /><Text testID="opened">{opened()}</Text></NavPage>
    : <AssistantDetails active={props.active && nav.routes().at(-1) === route} bot={route.bot} onDone={() => nav.pop()} />}</NavStack></View>;
}
mount(AssistantsTestApp);

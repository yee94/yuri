import { cleanup, effect, mount, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { type NativeNewSessionPageHandoff } from './new-session';
import { createNewSessionAdmission } from './new-session-admission';
import { createPageOperations } from './page-operations';
import { NativeNewSessionPage } from './new-session-page';
import { request } from './runtime';
import { app, createChat, loadConnections } from './state';

type Route = { kind: 'root' } | { kind: 'new'; unbound?: boolean } | { kind: 'chat'; handoff: NativeNewSessionPageHandoff } | { kind: 'cover' };
const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };
const nav = createNavStack<Route>([{ kind: 'root' }]);

function ReceiptChat(props: { handoff: NativeNewSessionPageHandoff }) {
  const chat = createChat(props.handoff.receipt.target), result = signal('waiting');
  const operations = createPageOperations(() => chat.active());
  const admission = createNewSessionAdmission({ chat, handoff: props.handoff, current: () => operations.displayCurrent() && chat.active(), operation: operations.operation,
    changed: state => result.set(state === 'complete' ? 'admitted' : state === 'error' ? 'failed' : state) });
  let attempted = false;
  effect(() => { chat.active.set(nav.routes().at(-1)?.kind === 'chat'); });
  effect(() => {
    const operation = operations.operation();
    if (!operation) return;
    untracked(() => { if (!attempted) { attempted = true; void admission.run(); } else void admission.reconcile(); });
  });
  cleanup(() => { void admission.close().catch(() => {}); });
  return <NavPage title="Handoff chat fixture" headerBackTitle="" class="flex-1 bg-background"><View class="p-5 gap-3"><Text testID="new-session-fixture-result" class="text-foreground">{result()}</Text><Text class="text-foreground">{props.handoff.receipt.inputID}</Text><If when={chat.pendingSend()}><Text class="text-foreground">{chat.pendingSend()?.text}</Text></If><Button testID="new-session-fixture-retry" onPress={() => { void admission.reconcile(); }}><Text>Retry handoff</Text></Button><Button testID="new-session-fixture-cover" onPress={() => nav.push({ kind: 'cover' })}><Text>Cover chat</Text></Button></View></NavPage>;
}

function Fixture() {
  language.set('en');
  const ready = signal(false);
  void loadConnections().then(() => { app.projects.set([project, { id: 'other-project', name: 'Other draft project', path: '/fixture/other' }]); ready.set(true); });
  return <If when={ready()}><NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'new') return <NativeNewSessionPage project={route.unbound ? undefined : project} active={nav.routes().at(-1) === route} onOpenChat={(_target, handoff) => nav.push({ kind: 'chat', handoff })} />;
    if (route.kind === 'chat') return <ReceiptChat handoff={route.handoff} />;
    if (route.kind === 'cover') return <NavPage title="Covered fixture" headerBackTitle=""><Text>Only this page is active</Text></NavPage>;
    return <NavPage title="New session fixture" headerBackTitle="" class="flex-1 bg-background"><View class="p-5 gap-3"><Button testID="new-session-fixture-open" onPress={() => nav.push({ kind: 'new' })}><Text>Open draft</Text></Button><Button testID="new-session-fixture-unbound" onPress={() => nav.push({ kind: 'new', unbound: true })}><Text>Open unbound draft</Text></Button><Button testID="new-session-fixture-unknown" onPress={() => { void request('/__fixture/new-session/lose-create').then(() => nav.push({ kind: 'new' })); }}><Text>Lose next creation response</Text></Button><Button testID="new-session-fixture-fail-prompt" onPress={() => { void request('/__fixture/new-session/fail-prompt').then(() => nav.push({ kind: 'new' })); }}><Text>Fail next prompt</Text></Button></View></NavPage>;
  }}</NavStack></If>;
}
mount(Fixture);

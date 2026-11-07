import { cleanup, effect, host, mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, Input, NavPage, NavStack } from 'nsh/base';
import { ChatHeaderActions } from './chat-header';
import { language } from './i18n';
import type { ChatTarget } from './model';
import { app, createChat } from './state';
import { NativeSessionSwitcherPage } from './session-switcher';

const initial: ChatTarget = { kind: 'session', id: 'ses_a', title: 'First conversation', directory: '/workspace/second' };
type Route = { kind: 'chat'; target: ChatTarget; messageID?: string } | { kind: 'sessions'; source: ChatTarget };
const nav = createNavStack<Route>([{ kind: 'chat', target: initial }]);

/** Only synthetic entry scaffolding; draft/header/catalog owners are production modules. */
function ChatFixture(props: { route: Extract<Route, { kind: 'chat' }> }) {
  const chat = createChat(props.route.target);
  const active = () => nav.routes()[nav.routes().length - 1] === props.route;
  effect(() => { chat.active.set(active()); });
  const current = () => app.connection()?.id === 'session-switcher-fixture';
  return <NavPage title={props.route.target.title} headerBackTitle="" class="flex-1 bg-background">
    <ChatHeaderActions target={props.route.target} active={active()} busy={false} current={current} onOptions={() => {}} />
    <Input testID="session-switcher-draft" class="min-h-12 text-foreground" value={chat.draft()} onChange={event => chat.setDraftText(event.value)} />
    <Text testID="session-switcher-draft-ready" class="text-foreground">{chat.draftStatus()}</Text>
    <Text testID="session-switcher-chat-error" class="text-destructive">{chat.error()}</Text>
    <Text testID="session-switcher-focused-message" class="text-foreground">{props.route.messageID ?? ''}</Text>
    <Button testID="session-switcher-open" class="min-h-11 bg-secondary" onPress={() => nav.push({ kind: 'sessions', source: props.route.target })}><Text>Open synthetic session switcher</Text></Button>
    <Button testID="session-switcher-fixture-back" class="min-h-11" onPress={() => nav.pop()}><Text>Fixture navigation back</Text></Button>
  </NavPage>;
}

function Fixture() {
  language.set('en');
  app.connection.set({ id: 'session-switcher-fixture', label: 'Synthetic Host', url: 'https://host.example', lastUsedAt: 0 });
  // The active directory deliberately belongs to the second catalog item.
  app.projects.set([{ id: 'first', name: 'First project', path: '/workspace/first' }, { id: 'second', name: 'Second project', path: '/workspace/second' }]);
  const opened = signal(''), audit = signal('');
  cleanup(() => app.connection.set(null));
  return <View class="flex-1"><NavStack state={nav} class="flex-1">{route => route.kind === 'chat' ? <ChatFixture route={route} /> : <NativeSessionSwitcherPage currentTarget={route.source} current={() => app.connection()?.id === 'session-switcher-fixture'} onClose={() => nav.pop()} navigation={{
    onOpenChat: target => { opened.set(target.directory); nav.push({ kind: 'chat', target }); },
    onOpenProject: () => {}, onOpenFiles: () => {}, onOpenChanges: () => {}, onAddProject: () => {}, onEditProject: () => {},
    // Opening a draft must remain a navigation callback, never createSession's fallback.
    onNewSession: project => opened.set(`draft:${project?.path ?? ''}`),
  }} />}</NavStack><Text testID="session-switcher-opened-directory" class="text-foreground">{opened()}</Text>
    <Button testID="session-switcher-audit" class="min-h-11" onPress={() => { void host.call('sessionSwitcher.fixture.audit', {}).then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect synthetic Host audit</Text></Button>
    <Text testID="session-switcher-audit-result" class="text-foreground">{audit()}</Text>
  </View>;
}

mount(Fixture);

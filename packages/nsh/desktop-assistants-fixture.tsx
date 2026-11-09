import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { AssistantHome } from './assistants';
import { app, loadConnections } from './state';
import { request } from './runtime';
import { language } from './i18n';
import type { DesktopAssistantConversationContext } from './desktop-assistants';

language.set('en');
app.tab.set(1);
function Fixture() {
  void loadConnections();
  const active = signal(true), interactive = signal(true), event = signal(''), audit = signal('');
  const installed = signal(0), disposed = signal(0);
  const admission = signal('allow'), changes = signal(0), validation = signal('');
  const released = signal(0), mutations = signal(0);
  let held: (() => void) | null = null, lateCommit: (() => void) | null = null;
  let attemptMutation: (() => void) | null = null;
  async function requestConversationChange(commit: () => void, current: () => boolean) {
    const mounted = installed() > disposed();
    changes.set(changes() + 1);
    lateCommit = commit;
    if (admission() === 'hold') await new Promise<void>(resolve => { held = resolve; });
    validation.set(current() ? 'current' : 'stale');
    if (admission() === 'veto') return false;
    if (admission() === 'unknown') throw new Error('synthetic_writer_unknown');
    if (!current()) return false;
    if (mounted) released.set(released() + 1);
    commit(); return true;
  }
  function Conversation(context: DesktopAssistantConversationContext) {
    const draft = signal('');
    installed.set(installed() + 1); cleanup(() => disposed.set(disposed() + 1));
    const mutate = () => { if (context.active() && context.interactive()) { mutations.set(mutations() + 1); void request('/fixture/conversation-mutation', 'POST'); } };
    attemptMutation = mutate; cleanup(() => { if (attemptMutation === mutate) attemptMutation = null; });
    return <View testID="fixture-assistant-conversation" class="flex-1 p-4 gap-2">
      <Text>{`Conversation:${String(context.bot().id)}`}</Text>
      <Text>{`scope:${String(context.bot().effectiveWorkspacePath)}`}</Text>
      <Text>{`admission:${context.active()}:${context.interactive()}`}</Text>
      <Input testID="fixture-assistant-draft" class="bg-card text-foreground h-8" value={draft()} disabled={!context.active() || !context.interactive()} onChange={value => { if (context.active() && context.interactive()) draft.set(value.value); }} />
    </View>;
  }
  return <View class="flex-1 bg-background">
    <View class="flex-1 min-h-0"><If when={!!app.connection()}><AssistantHome presentation="desktop" active={active()} interactive={interactive()}
      onOpenChat={() => event.set('unexpected-mobile-navigation')} onCreate={() => event.set('create')}
      onEdit={bot => event.set(`edit:${String(bot.id)}`)} renderConversation={Conversation} requestConversationChange={requestConversationChange} /></If></View>
    <View class="gap-1 px-2 py-1">
      <View class="flex-row gap-2"><Button testID="fixture-assistants-modal" onPress={() => interactive.set(!interactive())}><Text>Toggle modal</Text></Button><Button testID="fixture-assistants-active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
        <Button testID="fixture-assistants-audit" onPress={() => { void request('/fixture/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button>
        <Each of={['refresh', 'fail', 'empty', 'disabled', 'unknown', 'unsupported', 'remove-b', 'restore-b', 'remove-a', 'restore-a', 'move-a']}>{mode => <Button testID={`fixture-assistants-${mode()}`} onPress={() => { void request(`/fixture/${mode()}`); }}><Text>{mode()}</Text></Button>}</Each>
      </View>
      <View class="flex-row gap-2">
        <Each of={['allow', 'veto', 'hold', 'unknown']}>{mode => <Button testID={`fixture-admission-${mode()}`} onPress={() => admission.set(mode())}><Text>{mode()}</Text></Button>}</Each>
        <Button testID="fixture-admission-resolve" onPress={() => { const resume = held; held = null; resume?.(); }}><Text>Resolve</Text></Button>
        <Button testID="fixture-admission-late" onPress={() => lateCommit?.()}><Text>Late commit</Text></Button>
        <Button testID="fixture-admission-host" onPress={() => { const prior = app.connection(); if (prior) app.connection.set({ ...prior, url: 'https://other.example' }); }}><Text>Retire Host</Text></Button>
        <Button testID="fixture-admission-mutate" onPress={() => attemptMutation?.()}><Text>Attempt mutation</Text></Button>
        <Button testID="fixture-admission-external-remove" onPress={() => app.bots.set(app.bots().filter(bot => bot.id !== 'a'))}><Text>External remove</Text></Button>
        <Button testID="fixture-admission-inplace-dir" onPress={() => { const bot = app.bots().find(bot => bot.id === 'a'); if (bot) bot.effectiveWorkspacePath = '/other-workspace'; app.bots.set([...app.bots()]); }}><Text>External directory</Text></Button>
      </View>
      <Text>{`released:${released()}:mutations:${mutations()}`}</Text>
      <Text>{`changes:${changes()}:${validation()}`}</Text>
      <Text>{`owners:${installed()}:${disposed()}`}</Text><Text>{event()}</Text><Text style={{ numberOfLines: 1 }}>{`audit:${audit()}`}</Text>
    </View>
  </View>;
}
mount(Fixture);

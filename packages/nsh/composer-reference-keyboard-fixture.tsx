import { keymap, lifecycle, mount, signal, Text, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { NativeReferencePicker } from './composer-references-controls';
import { app, createChat, loadConnections } from './state';
import { request } from './runtime';

function Fixture() {
  const chat = createChat({ kind: 'session', id: 'reference-chat', title: 'References', directory: '/workspace' });
  const active = signal(true), host = signal('fixture'), fallback = signal('none'), calls = signal(0);
  let input: InputRef | undefined;
  keymap.bind(Object.fromEntries(['up', 'down', 'enter', 'tab', 'escape', 'mod+down', 'shift+tab', 'alt+enter'].map(key => [key, () => fallback.set(key)])), { when: 'always', repeat: true });
  const keyboard = createNativeReferenceKeyboard({ active: () => active() && chat.active() && lifecycle() === 'active', text: chat.draft,
    scope: () => ({ ...chat.referenceScope, host: host() }),
    insert: (candidate, start, end) => chat.insertReference({ ...candidate, scope: chat.referenceScope }, start, end),
  });
  const search = async (path: string) => {
    calls.set(calls() + 1);
    if (path.startsWith('/api/fs/find?') && path.includes('type=file')) return { data: Array.from({ length: 12 }, (_, i) => ({ path: `src/file-${String(i).padStart(2, '0')}.ts`, type: 'file' })) };
    return request(path);
  };
  const selection = (start: number, end = start) => { input?.focus(); input?.setSelection(start, end); keyboard.onSelectionChange({ start, end }); };
  return <View>
    <Text>{chat.draftStatus()}</Text>
    <Input testID="keyboard-composer" autoFocus multiline value={chat.draft()} ref={node => { input = node; keyboard.ref(node); }} selectedRange={keyboard.selectedRange()}
      onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} onSelectionChange={keyboard.onSelectionChange} onCompositionChange={keyboard.onCompositionChange}
      submitBehavior={keyboard.submitBehavior()} onSubmit={keyboard.onSubmit} onChange={event => { keyboard.beforeChange(); chat.setDraftText(event.value); keyboard.refresh(); }} />
    <Text>{`active:${keyboard.state().index}:${keyboard.state().id || 'none'}`}</Text>
    <Text>{`rows:${keyboard.state().rows.length}`}</Text>
    <Text>{`refs:${chat.references().length}`}</Text><Text>{`fallback:${fallback()}`}</Text><Text>{`calls:${calls()}`}</Text><Text>{`submit:${keyboard.submitBehavior()}`}</Text>
    <If when={!!keyboard.trigger()}><NativeReferencePicker scope={{ ...chat.referenceScope, host: host() }} currentSessionID="reference-chat" open query={keyboard.trigger()?.query} keyboard={keyboard} request={search} onClose={keyboard.dismiss} onChoose={() => {}} /></If>
    <Button testID="middle" onPress={() => { keyboard.beforeChange(); chat.setDraftText('Read @src and keep tail'); selection(9); keyboard.refresh(); }}><Text>Middle</Text></Button>
    <Button testID="selection" onPress={() => selection(5, 9)}><Text>Selection</Text></Button>
    <Button testID="caret" onPress={() => selection(chat.draft().length)}><Text>Caret</Text></Button>
    <Button testID="ime-start" onPress={() => { input?.focus(); keyboard.onCompositionChange({ composing: true }); }}><Text>Composition start</Text></Button>
    <Button testID="ime-end" onPress={() => keyboard.onCompositionChange({ composing: false })}><Text>Composition end</Text></Button>
    <Button testID="page" onPress={() => { active.set(!active()); keyboard.refresh(); }}><Text>Page</Text></Button>
    <Button testID="host" onPress={() => { host.set('next-host'); keyboard.refresh(); }}><Text>Host</Text></Button>
    <Input testID="other-input" />
  </View>;
}
function App() { void loadConnections(); return <If when={!!app.connection()}><Fixture /></If>; }
mount(App);

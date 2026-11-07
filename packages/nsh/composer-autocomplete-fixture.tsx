import { keyboardFrame, keymap, lifecycle, mount, Overlay, safeArea, signal, Text, untracked, View, windowSize, type InputRef, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeCommandSuggestions } from './composer-controls';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { NativeReferencePicker } from './composer-references-controls';
import { shouldSubmitCommandOnSelection } from './composer-commands-model';
import { nativeComposerSurface } from './composer-surface';
import { editNativeReferences, insertNativeReference, type ReferenceDocument } from './composer-references';

function Fixture() {
  const doc = signal<ReferenceDocument>({ text: '', references: [] }), anchor = signal<ViewRef | null>(null);
  const active = signal(true), host = signal('fixture'), calls = signal(0), scans = signal(0), fail = signal(false), fallback = signal('none'), action = signal('none');
  const scope = () => ({ host: host(), draft: 'fixture', directory: '/workspace' });
  const commands = new Proxy(Array.from({ length: 300 }, (_, index) => ({ name: `custom-${String(index).padStart(3, '0')}`, description: 'Neutral command' })), {
    get(array, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) untracked(() => scans.set(scans() + 1)); return Reflect.get(array, key, receiver); },
  });
  let input: InputRef | undefined;
  keymap.bind(Object.fromEntries(['up', 'down', 'enter', 'tab', 'escape', 'mod+down'].map(key => [key, () => fallback.set(key)])), { when: 'always', repeat: true });
  const keyboard = createNativeReferenceKeyboard({ active: () => active() && lifecycle() === 'active', scope, text: () => doc().text,
    insert: (candidate, start, end) => { doc.set(insertNativeReference(doc(), candidate, start, end)); return true; },
    chooseCommand: (command, submit, context) => {
      const run = shouldSubmitCommandOnSelection(command, submit);
      doc.set(editNativeReferences(doc(), run ? context.text.slice(context.end) : `/${command.name} ${context.text.slice(context.end)}`));
      if (run) action.set(command.name);
    },
  });
  keymap.bind({ 'mod+i': () => keyboard.onCompositionChange({ composing: true }), 'mod+j': () => keyboard.onCompositionChange({ composing: false }), 'mod+f': () => fail.set(!fail()) }, { when: 'always' });
  const seed = (text: string, cursor = text.length) => { keyboard.beforeChange(); doc.set({ text, references: [] }); input?.focus(); keyboard.onFocus(); input?.setSelection(cursor); keyboard.onSelectionChange({ start: cursor, end: cursor }); };
  async function request(path: string) {
    if (path.startsWith('/api/fs/find?')) return { data: [{ path: 'src/neutral.ts', type: 'file' }] };
    if (path.startsWith('/api/agent?')) return { data: [{ name: 'reviewer' }] };
    return { data: [] };
  }
  return <View class="flex-1 bg-background justify-end px-3 gap-2" style={{ paddingBottom: Math.max(keyboardFrame().height, safeArea().bottom) + 8 }}>
    <Text>{`calls:${calls()} scans:${scans()} action:${action()} fallback:${fallback()}`}</Text>
    <Text>{`slash:${keyboard.commandState().rows.length} refs:${doc().references.length}`}</Text>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="slash" onPress={() => seed('/')}><Text>Slash</Text></Button>
      <Button testID="model" onPress={() => seed('/mo')}><Text>Model</Text></Button>
      <Button testID="middle" onPress={() => seed('/mo\nKEEP', 2)}><Text>Middle</Text></Button>
      <Button testID="mention" onPress={() => seed('@src')}><Text>Mention</Text></Button>
      <Button testID="ordinary" onPress={() => seed('ordinary')}><Text>Ordinary</Text></Button>
      <Button testID="failure" onPress={() => fail.set(!fail())}><Text>Failure</Text></Button>
      <Button testID="host" onPress={() => host.set('other')}><Text>Host</Text></Button>
      <Button testID="page" onPress={() => active.set(!active())}><Text>Page</Text></Button>
      <Button testID="ime" onPress={() => keyboard.onCompositionChange({ composing: true })}><Text>IME</Text></Button>
      <Button testID="ime-end" onPress={() => keyboard.onCompositionChange({ composing: false })}><Text>IME end</Text></Button>
      <Button testID="selection" onPress={() => keyboard.onSelectionChange({ start: 0, end: 2 })}><Text>Selection</Text></Button>
    </View>
    <Input testID="other" />
    <View testID="composer-glass" ref={node => anchor.set(node)} style={nativeComposerSurface} class="px-3 py-2">
      <Input testID="autocomplete-input" multiline style={{ backgroundColor: 'transparent', borderWidth: 0 }} class="text-foreground min-h-12" value={doc().text}
        ref={node => { input = node; keyboard.ref(node); }} selectedRange={keyboard.selectedRange()} onFocus={keyboard.onFocus} onBlur={keyboard.onBlur}
        onSelectionChange={keyboard.onSelectionChange} onCompositionChange={keyboard.onCompositionChange} submitBehavior={keyboard.submitBehavior()} onSubmit={keyboard.onSubmit}
        onChange={event => { keyboard.beforeChange(); doc.set(editNativeReferences(doc(), event.value)); keyboard.refresh(); }} />
    </View>
    <If when={!!keyboard.commandTrigger() && !!anchor()}><Overlay anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}>
      <NativeCommandSuggestions scope={scope()} keyboard={keyboard} commands={commands} loadCommands={async () => { calls.set(calls() + 1); if (fail()) throw new Error('fixture'); }} />
    </Overlay></If>
    <If when={!!keyboard.trigger() && !!anchor()}><Overlay anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}>
      <NativeReferencePicker scope={scope()} keyboard={keyboard} open query={keyboard.trigger()?.query} request={request} onClose={keyboard.dismiss} />
    </Overlay></If>
  </View>;
}
mount(Fixture);

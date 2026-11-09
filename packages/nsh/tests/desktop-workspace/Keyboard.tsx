import { effect, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createNativeReferenceKeyboard } from '../../composer-reference-keyboard-native';
import { mixedReferenceRows } from '../../composer-references';

function App() {
  const draft = signal(''), submits = signal(0), active = signal(true);
  const scope = { host: 'synthetic', draft: 'desktop-keyboard', directory: '/fixture' };
  const keyboard = createNativeReferenceKeyboard({ active, scope: () => scope, text: draft,
    insert: (candidate, start, end) => { draft.set(draft().slice(0, start) + '@' + candidate.value + ' ' + draft().slice(end)); return true; },
    onSubmit: () => submits.set(submits() + 1),
  });
  effect(() => {
    const trigger = keyboard.trigger();
    if (trigger) untracked(() => keyboard.core.rows({ scope, query: trigger.query }, mixedReferenceRows([{ kind: 'file', value: 'src/file.ts', label: 'src/file.ts', scope }], trigger.query)));
  });
  return <View>
    <Input testID="desktop-keyboard" multiline value={draft()} ref={keyboard.ref} onFocus={keyboard.onFocus} onBlur={keyboard.onBlur}
      selectedRange={keyboard.selectedRange()} onSelectionChange={keyboard.onSelectionChange} onCompositionChange={keyboard.onCompositionChange}
      submitBehavior={keyboard.submitBehavior()} onSubmit={keyboard.onSubmit} onChange={event => { keyboard.beforeChange(); draft.set(event.value); keyboard.refresh(); }} />
    <Text>submits:{submits()}</Text>
    <Button testID="composition-start" onPress={() => keyboard.onCompositionChange({ composing: true })}><Text>compose</Text></Button>
    <Button testID="composition-end" onPress={() => keyboard.onCompositionChange({ composing: false })}><Text>finish</Text></Button>
    <Button testID="inactive" onPress={() => active.set(false)}><Text>hide</Text></Button>
  </View>;
}

mount(App);

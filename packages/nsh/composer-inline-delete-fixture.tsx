import { mount, signal, Text, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { editNativeReferences, insertNativeReference, type ReferenceDocument, type ReferenceKind } from './composer-references';

function Fixture() {
  const doc = signal<ReferenceDocument>({ text: '', references: [] }), selection = signal({ start: 0, end: 0 });
  const keyboard = createNativeReferenceKeyboard({ active: () => true, scope: () => ({ host: 'fixture', draft: 'delete', directory: '/work' }),
    text: () => doc().text, references: () => doc().references, insert: () => false });
  let input: InputRef | undefined;
  const seed = (kind: ReferenceKind, composing = false) => {
    const value = insertNativeReference({ text: '前 ', references: [] }, { kind, value: kind, label: 'review' });
    doc.set({ ...value, text: value.text + '后' });
    input?.focus(); keyboard.onFocus(); input?.setSelection(value.references[0].end);
    keyboard.onCompositionChange({ composing });
  };
  return <View class="flex-1 bg-background p-4" style={{ paddingTop: 60 }}>
    <Input testID="atomic-input" multiline value={doc().text} selectedRange={keyboard.selectedRange()} ref={node => { input = node; keyboard.ref(node); }}
      onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} onCompositionChange={keyboard.onCompositionChange}
      onSelectionChange={value => { selection.set(value); keyboard.onSelectionChange(value); }}
      onChange={event => { doc.set(editNativeReferences(doc(), keyboard.beforeChange(event.value) ?? event.value)); keyboard.refresh(); }} />
    <Text>{`refs:${doc().references.length}`}</Text><Text>{`caret:${selection().start}:${selection().end}`}</Text>
    <Each of={['skill', 'file', 'directory', 'agent', 'session'] as const}>{kind => <Button testID={`seed-${kind()}`} onPress={() => seed(kind())}><Text>{kind()}</Text></Button>}</Each>
    <Button testID="seed-composing" onPress={() => seed('skill', true)}><Text>Composing</Text></Button>
    <Button testID="place-caret" onPress={() => { input?.focus(); input?.setSelection(doc().references[0].end); }}><Text>Place caret</Text></Button>
  </View>;
}
mount(Fixture);

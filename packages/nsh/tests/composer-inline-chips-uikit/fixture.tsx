import { cleanup, host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeComposerInlineChips } from '../../native-composer-inline-chips';
import { editNativeReferences, insertNativeReference, type ReferenceDocument } from '../../composer-references';
import { NativeMessageText } from '../../message-text';
import { nativeMessageReferenceContext } from '../../message-references';

function Fixture() {
  const doc = signal<ReferenceDocument>({ text: '检查 ', references: [] }), active = signal(true), phase = signal(0);
  cleanup(host.on('fixture.chips.step', value => {
    const next = Number((value as { phase: number }).phase); phase.set(next);
    if (next === 1) doc.set(insertNativeReference(doc(), { kind: 'skill', value: 'review', label: 'review' }));
    if (next === 2) doc.set(insertNativeReference(doc(), { kind: 'file', value: 'notes.txt', label: 'notes.txt' }));
    if (next === 3) doc.set(editNativeReferences(doc(), doc().text.replace('@review', 'review')));
    if (next === 4) active.set(false);
    if (next === 5) active.set(true);
    if (next === 6) doc.set({ text: '完成', references: [] });
  }));
  return <View class="flex-1 bg-background p-5 gap-6" style={{ paddingTop: 80 }}>
    <Text class="text-xl font-semibold text-foreground">Native inline reference validation</Text>
    <Text testID="chip-phase" class="text-foreground">{`phase:${phase()}`}</Text>
    <View testID="chip-owner" class="bg-secondary rounded-xl p-3">
      <NativeComposerInlineChips ownerID="chip-owner" inputID="chip-input" textLength={doc().text.length} references={doc().references} active={active()} />
      <Input testID="chip-input" multiline value={doc().text} class="text-foreground min-h-20" style={{ fontSize: 18, lineHeight: 29, backgroundColor: 'transparent' }} onChange={event => doc.set(editNativeReferences(doc(), event.value))} />
    </View>
    <NativeMessageText testID="chip-message" markdown="消息中的 **[skill:review]** 和 [photo.png]" referenceContext={nativeMessageReferenceContext([], '')} selectable class="text-foreground" />
  </View>;
}
mount(Fixture);

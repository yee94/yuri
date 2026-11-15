import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeMessageText } from './message-text';
import { nativeMessageReferenceContext } from './message-references';

/** Original Markdown, canonical references and replacement identity; no Host calls. */
function Fixture() {
  const source = signal('使用 **[skill:review]** 看看 [photo.png]，保留 `literal [skill:code]`。'), opened = signal('');
  return <View style={{ width: 360 }}>
    <NativeMessageText testID="message-reference-body" markdown={source()} selectable referenceContext={nativeMessageReferenceContext([], source())} onOpenSkill={value => opened.set(value)} />
    <Text testID="opened-skill">{opened()}</Text>
    <Button testID="replace-reference-text" onPress={() => source.set('替换后 [skill:build]，原技能不再显示。')}><Text>Replace</Text></Button>
  </View>;
}
mount(Fixture);

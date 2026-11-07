import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeReferencePicker } from '../composer-references-controls';
import { compileNativePrompt } from '../composer';
import { editNativeReferences, insertNativeReference, nativeReferenceTrigger, type ReferenceDocument } from '../composer-references';

function ReferenceTestApp() {
  const opened = signal(false), calls = signal(0), result = signal('');
  const doc = signal<ReferenceDocument>({ text: '', references: [] });
  const scope = { host: 'fixture-host', draft: 'fixture-draft', directory: '/workspace' };
  async function request(path: string) {
    calls.set(calls() + 1);
    if (path.startsWith('/api/session/prior/message?')) return { data: [{ id: 'm1', type: 'user', text: 'Neutral previous context' }], cursor: {} };
    if (path.startsWith('/api/fs/find?')) return { location: { directory: '/workspace' }, data: [{ path: path.includes('type=directory') ? 'src/' : 'src/neutral.ts', type: path.includes('type=directory') ? 'directory' : 'file' }] };
    if (path.startsWith('/api/skill?')) return { location: {}, data: [{ id: 'real-skill', name: 'Display skill', path: '/skills/real-skill' }] };
    if (path.startsWith('/api/agent?')) return { location: {}, data: [{ name: 'reviewer' }] };
    if (path.startsWith('/api/session?')) return { data: [{ id: 'prior', title: 'Prior neutral work', location: { directory: '/other' } }], cursor: {} };
    throw new Error('Unexpected fixture route');
  }
  return <View>
    <Input testID="reference-composer" value={doc().text} onChange={event => doc.set(editNativeReferences(doc(), event.value))} />
    <Text testID="reference-call-count">{`calls:${calls()}`}</Text>
    <Text testID="reference-sidecar-count">{`references:${doc().references.length}`}</Text>
    <Button testID="reference-open" onPress={() => { doc.set(editNativeReferences(doc(), `${doc().text}${doc().text && !/\s$/.test(doc().text) ? ' ' : ''}@`)); opened.set(true); }}><Text>@</Text></Button>
    <NativeReferencePicker scope={scope} open={opened()} query={nativeReferenceTrigger(doc().text)?.query} request={request} onClose={() => opened.set(false)} onChoose={candidate => { const trigger = nativeReferenceTrigger(doc().text); doc.set(insertNativeReference(doc(), candidate, trigger?.start, trigger?.end)); opened.set(false); }} />
    <Button testID="reference-submit" onPress={() => { void compileNativePrompt({ text: doc().text, files: [], scope, references: { ...doc(), scope } }, request).then(value => result.set(JSON.stringify(value))); }}><Text>Compile</Text></Button>
    <Text testID="reference-output">{result()}</Text>
  </View>;
}
mount(ReferenceTestApp);

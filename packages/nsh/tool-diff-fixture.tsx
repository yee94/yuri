import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeToolRow } from './transcript-tools';
import { NativeChangesSheet } from './chat-changes';
import { language } from './i18n';
import type { ChangesSource } from './chat-changes-model';

function Fixture() {
  language.set('en-US');
  const source = signal<ChangesSource | null>(null), active = signal(true), preview = signal('');
  const target = { kind: 'session' as const, id: 'fixture', title: 'Fixture', directory: '/fixture' };
  const patch = '@@ -8,2 +8,2 @@\n same\n-old word\n+NEW_WORD\n@@ -120,1 +120,1 @@\n-old target\n+TARGET_WORD';
  const history = (path: string, body: { patch?: string; before?: string; after?: string; isBinary?: boolean }, targetLine?: number) => source.set({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', path, targetLine, files: [{ path, ...body }] });
  return <View class="flex-1 bg-background p-4 gap-2">
    <Text>TOOL DIFF READY</Text>
    <NativeToolRow tool={{ id: 'edit', name: 'patch', time: { ran: 1000, completed: 4000 }, state: { status: 'completed', metadata: { files: [{ filePath: '/fixture/example.ts', patch, additions: 2, deletions: 2 }] } } }} target={target} current={active} onOpenDiff={file => history(file.path, file)} />
    <NativeToolRow tool={{ id: 'multi', name: 'patch', state: { status: 'completed', metadata: { files: [{ filePath: 'first.ts', patch: '@@ -1 +1 @@\n-old\n+FIRST_HISTORY' }, { filePath: 'other.ts', patch: '@@ -4 +4 @@\n-old\n+OTHER_HISTORY' }] } } }} target={target} current={active} onOpenDiff={(file, _target, files) => source.set({ kind: 'turn', directory: target.directory, sessionID: target.id, messageID: 'multi-message', path: file.path, files })} />
    <NativeToolRow tool={{ id: 'grep', name: 'grep', time: { ran: 1000, completed: 4000 }, state: { status: 'completed', input: { pattern: 'word', path: '/fixture' }, output: 'fixture literal **result**' } }} target={target} current={active} />
    <NativeToolRow tool={{ id: 'failed', name: 'webfetch', state: { status: 'error', input: { url: 'https://example.invalid' }, error: 'fixture request failed' } }} target={target} current={active} />
    <NativeToolRow tool={{ id: 'live', name: 'skill', state: { status: 'running', input: { name: 'fixture' } } }} target={target} current={active} />
    <Button testID="fixture-text-pair" onPress={() => history('pair.ts', { before: 'const value = "old";\n', after: 'const value = "PAIR_NEW";\n' })}><Text>Text pair</Text></Button>
    <Button testID="fixture-target" onPress={() => history('target.ts', { patch }, 120)}><Text>Target hunk</Text></Button>
    <Button testID="fixture-delete" onPress={() => history('deleted.ts', { before: 'DELETED_ONLY', after: '' })}><Text>Deleted file</Text></Button>
    <Button testID="fixture-binary" onPress={() => history('binary.png', { isBinary: true })}><Text>Binary file</Text></Button>
    <Button testID="fixture-empty" onPress={() => history('empty.ts', { before: '', after: '' })}><Text>Empty file</Text></Button>
    <Button testID="fixture-long" onPress={() => history('long.ts', { before: Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n'), after: Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n') })}><Text>Long file</Text></Button>
    <Button testID="fixture-expire" onPress={() => active.set(false)}><Text>Expire</Text></Button>
    <Text>{preview()}</Text>
    <If when={!!source()}><NativeChangesSheet source={source()!} open active={active()} onClose={() => source.set(null)} onOpenPreview={(path, line) => preview.set(`preview:${path}:${line}`)} /></If>
  </View>;
}
mount(Fixture);

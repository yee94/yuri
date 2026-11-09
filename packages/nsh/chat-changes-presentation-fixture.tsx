import { cleanup, computed, host, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeChangesPresentation, type NativeChangesPresentationHandle } from './chat-changes';
import type { ChangesSource } from './chat-changes-model';
import { app, loadConnections } from './state';
import { language } from './i18n';

function Fixture() {
  language.set('en');
  const ready = signal(false), source = signal<ChangesSource | null>(null), noise = signal(''), active = signal(true), current = signal(true);
  const handle = signal<NativeChangesPresentationHandle | null>(null), blocked = signal(0), loader = signal(0);
  const audit = signal('');
  cleanup(host.on('changes.fixture.audit', value => audit.set(JSON.stringify(value))));
  const requested = computed(() => { noise(); const value = source(); return value ? { ...value } : null; });
  let release: (() => void) | undefined;
  const history = (messageID: string): ChangesSource => ({ kind: 'turn', directory: '/fixture', sessionID: 'session', messageID, path: 'history.ts', files: [{ path: 'history.ts' }], loadFile: async path => {
    loader.set(loader() + 1);
    if (messageID === 'held') await new Promise<void>(resolve => { release = resolve; });
    return { path, before: 'OLD_' + messageID, after: 'HISTORY_' + messageID };
  } });
  cleanup(host.on('changes.presentation.control', value => {
    const event = value as { action: string };
    if (event.action === 'workspace') source.set({ kind: 'workspace', directory: '/fixture' });
    if (event.action === 'path') source.set({ kind: 'workspace', directory: '/fixture', path: 'folder/a.ts', targetLine: 1 });
    if (event.action === 'line') source.set({ kind: 'workspace', directory: '/fixture', path: 'folder/a.ts', targetLine: 7 });
    if (event.action === 'different') source.set({ kind: 'workspace', directory: '/other' });
    if (event.action === 'close') source.set(null);
    if (event.action === 'pause') active.set(false);
    if (event.action === 'resume') active.set(true);
    if (event.action === 'retire') current.set(false);
    if (event.action === 'host') { const previous = app.connection(); if (previous) app.connection.set({ ...previous, url: 'https://replacement.example.invalid' }); }
    if (event.action === 'history') source.set(history('exact'));
    if (event.action === 'held') source.set(history('held'));
    if (event.action === 'release') release?.();
  }));
  void loadConnections().then(() => ready.set(true));
  return <View class="flex-1 bg-background">
    <Text>{ready() ? 'PRESENTATION_READY' : 'WAITING'}</Text>
    <Text>{`changes-audit:${audit()}`}</Text>
    <Button testID="changes-fixture-workspace" onPress={() => source.set({ kind: 'workspace', directory: '/fixture' })}><Text>Workspace fixture</Text></Button>
    <Each of={['seed-staged', 'hold-commit', 'release']}>{name => <Button testID={`changes-fixture-${name()}`} onPress={() => { void host.call('changes.fixture.control', { name: name() }); }}><Text>{name()}</Text></Button>}</Each>
    <Input testID="presentation-composer" value={noise()} onChange={event => noise.set(event.value)} />
    <Text>{`guard:${handle()?.canLeave() ?? true};blocked:${blocked()};loader:${loader()}`}</Text>
    <If when={ready()}><NativeChangesPresentation source={requested()} open={!!source()} active={active()} current={() => current()}
      onHandle={value => handle.set(value)} onBlocked={() => blocked.set(blocked() + 1)} onClose={() => source.set(null)}
      onOpenPreview={(path, line, captured) => { void host.call('changes.presentation.preview', { path, line, directory: captured.directory, kind: captured.kind }); }} /></If>
  </View>;
}
mount(Fixture);

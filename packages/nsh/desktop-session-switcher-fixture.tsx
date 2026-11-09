import { host, mount, signal, Text, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { NativeDesktopSessionSwitcher } from './desktop-session-switcher';
import type { DesktopSwitcherSnapshot, DesktopSwitcherSource } from './desktop-session-switcher-core';
import type { ChatTarget } from './model';

function Fixture() {
  language.set('en');
  const open = signal(false), anchor = signal<ViewRef | null>(null), generation = signal(1), draft = signal(false), closes = signal(0), navigations = signal(0), newDrafts = signal(0);
  const target = signal<ChatTarget>({ kind: 'session', id: 's299', title: 'Session 299', directory: '/workspace/project' });
  const mode = signal<'ready' | 'loading' | 'error' | 'empty'>('ready'), metrics = signal('');
  const composing = signal(false);
  let snapshots = 0, retries = 0;
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, title: i === 0 ? '中文 target' : `Session ${i}`, directory: '/workspace/project', updated: i + 1 }));
  const data: DesktopSwitcherSnapshot = { sessions: [...rows, { id: 'child', title: 'Subtask', directory: '/workspace/project', updated: 1000, parentID: 's299' }],
    projects: [{ id: 'project', name: 'Project', path: '/workspace/project' }], pinnedSessionIDs: [], ready: true, loading: false, error: '' };
  const source: DesktopSwitcherSource = {
    snapshot: () => { snapshots++; return { ...data, sessions: mode() === 'empty' ? [] : data.sessions, ready: mode() !== 'loading', loading: mode() === 'loading', error: mode() === 'error' ? 'Synthetic offline' : '' }; },
    retry: async () => { retries++; mode.set('ready'); },
    status: session => session.id === 's298' ? 'running' : null,
  };
  host.on('desktop-switcher-fixture.host', () => generation.set(generation() + 1));
  host.on('desktop-switcher-fixture.composition', value => composing.set(value === true));
  const show = () => open.set(true);
  return <View class="flex-1 p-4 gap-2">
    <Text>ready</Text><View class="flex-row"><View style={{ width: 110 }} /><View ref={node => anchor.set(node)} testID="switcher-title" role="button" class="px-2 py-2" onPress={show}><Text>{draft() ? 'New session' : target().title}</Text></View></View>
    <Text>{`closes:${closes()} nav:${navigations()} drafts:${newDrafts()} generation:${generation()}`}</Text><Text testID="metrics-value">{metrics()}</Text>
    <Button testID="draft" onPress={() => { draft.set(true); show(); }}><Text>Draft title</Text></Button>
    <Button testID="empty" onPress={() => mode.set('empty')}><Text>Empty</Text></Button>
    <Button testID="loading" onPress={() => mode.set('loading')}><Text>Loading</Text></Button>
    <Button testID="error" onPress={() => mode.set('error')}><Text>Error</Text></Button>
    <Button testID="switch-host" onPress={() => generation.set(generation() + 1)}><Text>Switch Host</Text></Button>
    <Button testID="metrics" onPress={() => metrics.set(`snapshots:${snapshots} retries:${retries}`)}><Text>Metrics</Text></Button>
    <NativeDesktopSessionSwitcher open={open()} anchor={anchor()} scope={generation()} current={() => true} active source={source} composing={composing()}
      currentTarget={draft() ? undefined : target()} onClose={scope => { if (scope === generation()) { open.set(false); closes.set(closes() + 1); } }}
      onOpenChat={next => { target.set(next); draft.set(false); navigations.set(navigations() + 1); }} onNewSession={() => { draft.set(true); newDrafts.set(newDrafts() + 1); }} />
  </View>;
}
mount(Fixture);

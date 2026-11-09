import { cleanup, host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { loadNativeDesktopHttpGrant } from './desktop-http';
import { createDesktopBtwRuntime, type DesktopBtwRuntime } from './desktop-btw-runtime';
import { createNativeBtwStore } from './desktop-btw';
import { NativeDesktopBtwPanel } from './desktop-btw-panel';
import { createNativeDesktopBtwAction, type NativeDesktopBtwHandle } from './desktop-btw-panel-core';
import { createNativeLocalCommands, type NativeLocalCommandSnapshot } from './composer-local-commands';

/** Isolated engine consumer: native Host is synthetic; the loader/store/action/Panel are production modules. */
function Fixture() {
  const live = signal(true), port = signal<DesktopBtwRuntime | null>(null), status = signal('loading');
  const scope = { sessionId: 'session/a b', directory: '/workspace' }, runtime = { transport: 'fixture', generation: 1 };
  const expectedHost = { hostID: 'synthetic', lease: '00000000-0000-4000-abcd-000000000001' };
  const event = (name: string, value?: unknown) => { void host.call('btw.fixture', { name, value }); };
  void loadNativeDesktopHttpGrant({ current: live }).then(grant => {
    const next = createDesktopBtwRuntime({ grant, expectedHost, scope, runtime: () => runtime, runtimeScope: () => expectedHost,
      current: live, onIssue: error => event('issue', { code: 'code' in error ? error.code : error.phase, outcome: 'outcome' in error ? error.outcome : 'response' }) });
    if (next) { port.set(next); status.set('ready'); } else status.set('unavailable');
  });
  cleanup(() => { live.set(false); void port()?.dispose().catch(() => {}); });
  function Consumer() {
    const adapter = port()!, requested = signal(false), mounted = signal(false), outcome = signal('none');
    const store = createNativeBtwStore({ runtime: () => runtime, resolveSelection: () => ({ providerID: 'provider', modelID: 'model', variant: 'high', agent: 'agent' }),
      rememberSelection: () => {}, applySelection: adapter.applySelection, generate: adapter.generate });
    const snapshot = signal<NativeLocalCommandSnapshot>({ authority: 'fixture', scope: { host: 'fixture', draft: 'chat', directory: scope.directory },
      target: { kind: 'session', id: scope.sessionId, directory: scope.directory }, revision: 0, text: '', inputMode: 'normal', active: true, ready: true,
      pending: false, unknown: false, sending: false, queueEditing: false, hasReferences: false, hasMessages: true, selection: null });
    let handle: NativeDesktopBtwHandle | null = null;
    let opening: { resolve: (value: NativeDesktopBtwHandle) => void; reject: (reason: Error) => void } | undefined;
    const action = createNativeDesktopBtwAction({ open: () => {
      if (handle?.current()) return handle;
      if (opening) return null;
      const promise = new Promise<NativeDesktopBtwHandle>((resolve, reject) => { opening = { resolve, reject }; });
      requested.set(true); event('opening'); return promise;
    } });
    const owner = createNativeLocalCommands({ t: key => key, read: snapshot,
      replaceText: (expected, text) => { if (snapshot() !== expected) return false; snapshot.set({ ...expected, text, revision: expected.revision + 1 }); return true; },
      actions: { btw: action }, onBlocked: (_command, reason) => event('blocked', reason), onConflict: value => event('conflict', value.phase),
      onOutcome: (_invocation, value) => { outcome.set(value.status); event('outcome', value.status); } });
    const retire = () => { live.set(false); opening?.reject(new Error('opening_retired')); opening = undefined; };
    cleanup(() => { retire(); owner.dispose(); store.dispose(); });
    cleanup(host.on('btw.control', value => {
      const input = value as { action: string; text?: string };
      if (input.action === 'edit' || input.action === 'submit') {
        snapshot.set({ ...snapshot(), text: input.text ?? '', revision: snapshot().revision + 1 });
        if (input.action === 'submit') event('admission', owner.submit().kind);
      }
      if (input.action === 'mount') mounted.set(true);
      if (input.action === 'cancel') handle?.cancel();
      if (input.action === 'selection-cancel') { void store.ask(scope, 'cancel selection'); store.cancel(scope); }
      if (input.action === 'close') { opening?.reject(new Error('opening_closed')); opening = undefined; handle?.close(); }
      if (input.action === 'retire') retire();
    }));
    return <View style={{ width: '100%', height: '100%' }}>
      <Text>{`draft:${snapshot().text}`}</Text><Text>{`outcome:${outcome()}`}</Text>
      {requested() && mounted() ? <NativeDesktopBtwPanel store={store} scope={scope} authority="fixture" current={adapter.current} active={live()} interactive={live()} visible={true}
        onHandle={next => { handle = next; event('mounted'); const ticket = opening; opening = undefined; ticket?.resolve(next); return () => { if (handle === next) handle = null; }; }}
        onClose={() => { requested.set(false); mounted.set(false); }} /> : null}
      <Button testID="fixture-noop" onPress={() => {}}><Text>Fixture</Text></Button>
    </View>;
  }
  return <View style={{ width: '100%', height: '100%' }}><Text>{`runtime:${status()}`}</Text>{port() ? <Consumer /> : null}</View>;
}
mount(Fixture);

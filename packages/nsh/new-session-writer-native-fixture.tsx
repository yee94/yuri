import { cleanup, effect, host, mount, platform, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavStack } from 'nsh/base';
import { loadNativeDesktopWriterClient } from './desktop-writer';
import type { DesktopWriterClient } from './desktop-writer-core';
import { NativeNewSessionPage } from './new-session-page';
import type { NativeNewSessionOwner, NativeNewSessionPageHandoff } from './new-session';
import { createNewSessionAdmission } from './new-session-admission';
import { createPageOperations } from './page-operations';
import { app, createChat, loadConnections } from './state';
import { language } from './i18n';
import type { NewSessionWriterAdmissionGuard } from './new-session-writer';

function ReceiptChat(props: { handoff: NativeNewSessionPageHandoff }) {
  const writer = props.handoff.desktopWriter;
  const chat = createChat(props.handoff.receipt.target, { draftAuthorityKey: props.handoff.receipt.draftAuthorityKey, ...(writer ? { writerGrant: writer.grant, writerUnknown: writer.markUnknown } : {}) });
  const result = signal('waiting'), operations = createPageOperations(() => chat.active());
  const admission = createNewSessionAdmission({ chat, handoff: props.handoff, current: () => operations.displayCurrent() && chat.active(), operation: operations.operation, changed: value => result.set(value) });
  let attempted = false;
  effect(() => { const operation = operations.operation(); if (operation) untracked(() => { if (!attempted) { attempted = true; void admission.run(); } }); });
  cleanup(() => { void admission.close().catch(() => {}); });
  return <Text testID="writer-admission">{result()}</Text>;
}

/** Real Page/owner/Chat; only the window root and native producer are synthetic. */
function Fixture() {
  language.set('en');
  const ready = signal(false), visible = signal(true), covered = signal(false), client = signal<DesktopWriterClient | undefined>(undefined);
  const clientState = signal('waiting'), control = signal('none'), audit = signal('{}'), handoff = signal<NativeNewSessionPageHandoff | null>(null);
  const retained = signal<NativeNewSessionOwner | null>(null);
  const durableCloses = signal(0);
  const draftRoute = signal({ unbound: false });
  const guards = signal<readonly { kind: 'waiting' | 'source'; guard: NewSessionWriterAdmissionGuard }[]>([]);
  const guardEvents = signal<readonly string[]>([]), observerCalls = signal(0), guardResult = signal('none');
  const nav = createNavStack([{}]);
  let alive = true, loading = false;
  const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };
  cleanup(host.on('fixture.writer.audit', value => audit.set(JSON.stringify(value))));
  cleanup(() => { alive = false; });
  void loadConnections().then(() => { app.projects.set([project]); ready.set(true); });
  async function load() {
    if (loading || !platform?.desktop) return;
    loading = true;
    const value = await loadNativeDesktopWriterClient({ current: () => alive });
    client.set(value); clientState.set(value ? 'ready' : 'unavailable');
  }
  async function command(action: string) { await host.call('fixture.newSessionWriter.control', { action }); control.set(action); }
  function register(kind: 'waiting' | 'source', guard: NewSessionWriterAdmissionGuard) {
    const entry = { kind, guard };
    guards.set([...guards(), entry]); guardEvents.set([...guardEvents(), `${kind}+`]);
    return () => { guards.set(guards().filter(value => value !== entry)); guardEvents.set([...guardEvents(), `${kind}-`]); };
  }
  function observe(guard: NewSessionWriterAdmissionGuard) { observerCalls.set(observerCalls() + 1); return register('waiting', guard); }
  async function requestGuard() {
    const current = guards().filter(entry => entry.guard.current());
    const prepared = (await Promise.all(current.map(entry => entry.guard.prepare()))).every(Boolean);
    guardResult.set(`prepare:${prepared}:final:${prepared && current.every(entry => entry.guard.current() && entry.guard.canClose())}`);
  }
  async function releaseGuard() {
    const released = (await Promise.all(guards().filter(entry => entry.kind === 'waiting').map(entry => entry.guard.release()))).every(Boolean);
    guardResult.set(`release:${released}`);
  }
  function retain(owner: NativeNewSessionOwner) {
    const close = owner.durable.close;
    owner.durable.close = () => { durableCloses.set(durableCloses() + 1); return close(); };
    retained.set(owner);
    if (platform?.desktop) return register('source', { current: owner.ownedScope, prepare: owner.prepareWriterRetirement,
      canClose: owner.canReleaseWriter, cancel: owner.cancelWriterRetirement, release: owner.releaseWriter });
  }
  async function releaseSource() {
    const owner = retained();
    const released = !!owner && await owner.prepareWriterRetirement() && await owner.releaseWriter();
    control.set(`source-release:${released}:owned:${owner?.ownedScope()}`);
  }
  return <View class="flex-1 bg-background">
    <View class="flex-row flex-wrap gap-1">
      <Button testID="writer-load" onPress={() => { void load(); }}><Text>Load root client</Text></Button>
      <Button testID="writer-cover" onPress={() => covered.set(!covered())}><Text>Temporary modal</Text></Button>
      <Button testID="writer-retire" onPress={() => visible.set(false)}><Text>Retire page</Text></Button>
      <Button testID="writer-unbound" onPress={() => draftRoute.set({ unbound: true })}><Text>Choose project state</Text></Button>
      <Button testID="writer-release-source" onPress={() => { void releaseSource(); }}><Text>Release source only</Text></Button>
      <Button testID="writer-request-guard" onPress={() => { void requestGuard(); }}><Text>Request navigation/close guard</Text></Button>
      <Button testID="writer-release-guard" onPress={() => { void releaseGuard(); }}><Text>Release waiting guard</Text></Button>
      <Button testID="writer-cancel-guard" onPress={() => { guards().forEach(entry => entry.guard.cancel()); guardResult.set('cancel'); }}><Text>Cancel guards</Text></Button>
      <Each of={['hold-resolve', 'release-resolve', 'fail-resolve', 'hold-acquire', 'release-acquire', 'lose-acquire', 'lose-session', 'lose-create', 'lose-release', 'conflict', 'no-capability', 'audit']}>{action => <Button testID={`writer-${action()}`} onPress={() => { void command(action()); }}><Text>{action()}</Text></Button>}</Each>
    </View>
    <Text>{`client:${clientState()}`}</Text><Text>{`control:${control()}`}</Text><Text>{`audit=${audit()}`}</Text>
    <Text>{`durable-closes:${durableCloses()}`}</Text>
    <Text>{`guards:${guards().map(entry => entry.kind).join(',')}`}</Text><Text>{`guard-events:${guardEvents().join(',')}`}</Text>
    <Text>{`observer-calls:${observerCalls()}`}</Text><Text>{`guard-result:${guardResult()}`}</Text>
    <Text>{`source:${retained()?.phase() ?? 'none'}:${retained()?.inputID() ?? 'none'}`}</Text>
    <If when={ready() && visible() && !handoff()}><Each of={[draftRoute()]}>{route => platform?.desktop
      ? <NativeNewSessionPage project={route().unbound ? undefined : project} desktopWriter={client} active={!covered()} onWriterAdmissionGuard={observe} onRetainedOwner={retain} onOpenChat={(_target, receipt) => handoff.set(receipt)} />
      : <NavStack state={nav} class="flex-1">{() => <NativeNewSessionPage project={route().unbound ? undefined : project} desktopWriter={client} active={!covered()} onWriterAdmissionGuard={observe} onRetainedOwner={retain} onOpenChat={(_target, receipt) => handoff.set(receipt)} />}</NavStack>}
    </Each></If>
    <Each of={handoff() ? [handoff()!] : []}>{value => <ReceiptChat handoff={value()} />}</Each>
  </View>;
}
mount(Fixture);

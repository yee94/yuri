import { batch, cleanup, host, lifecycle, mount, signal, Storage, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeDesktopChatWriter, type NativeDesktopChatWriterOwner } from './desktop-chat-writer-native';
import { loadDesktopWriterClient, beginDesktopWriterDispatch, type DesktopWriterClient, type DesktopWriterSource, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { openDraft } from './drafts';
import type { RuntimeScope } from './runtime-scope';

const client = signal<DesktopWriterClient | undefined>(undefined), discovered = signal(false), modal = signal(false);
const scope = signal<RuntimeScope | null>(null), authority = signal('fixture-origin-auth-one');
const audit = signal(''), updated = signal(0);
let owner: NativeDesktopChatWriterOwner | undefined, durable: ReturnType<typeof openDraft> | undefined;
let constructs = 0, unmounts = 0, reads = 0, writes = 0, laneBindings = 0, staleRejected = 0, disposed = false;
let originalGrant: VerifiedDesktopWriterGrant | null = null;
let releaseAcquire!: () => void, releaseRenew!: () => void;
const acquired = new Promise<void>(resolve => { releaseAcquire = resolve; }), renewed = new Promise<void>(resolve => { releaseRenew = resolve; });
// Keep the real producer ACK queued at the fixture adapter boundary, not in nsh/test's single Host handler loop.
const source: DesktopWriterSource = { available: () => host.available(), async call(name, input, options) {
  const reply = await host.call(name, input, options);
  if (name === 'desktop.writer.acquire') await acquired;
  if (name === 'desktop.writer.renew') await renewed;
  return reply;
} };
const get = Storage.getItem, set = Storage.setItem;
Storage.getItem = key => { reads++; return get(key); };
Storage.setItem = (key, value) => { writes++; return set(key, value); };

function Child(props: { grant(): VerifiedDesktopWriterGrant | null; writer: NativeDesktopChatWriterOwner }) {
  constructs++;
  durable = openDraft('host-a', { kind: 'session', id: 'session/a', title: 'Synthetic original draft', directory: '/workspace' }, 'fixture-origin-auth-one');
  const draft = durable;
  let paused = false, flushed = -1;
  const unbind = props.writer.bindBusiness({
    async prepareWriterRetirement() { paused = true; await draft.whenReady(); const before = draft.revision(); await draft.flush(); flushed = before; return paused && draft.revision() === before; },
    canReleaseWriter: () => paused && draft.status() === 'ready' && flushed === draft.revision() && !draft.pendingSend() && !draft.queueEdit(),
    cancelWriterRetirement() { paused = false; },
  });
  cleanup(() => { unbind(); unmounts++; void draft.close(); });
  return <View><Input testID="chat-writer-input" value={draft.draft()} readonly={modal() || lifecycle() !== 'active' || !props.grant()} onChange={event => {
    if (!modal() && lifecycle() === 'active' && props.grant() && !paused) draft.setDraftText(event.value);
  }} /><Text testID="chat-writer-draft">{draft.draft()}</Text></View>;
}
host.on<{ action: string; value?: boolean }>('chat-writer.control', async event => {
  if (event.action === 'activate') scope.set({ hostID: 'host-a', lease: 'lease-one' });
  else if (event.action === 'acquired') releaseAcquire();
  else if (event.action === 'renewed') releaseRenew();
  else if (event.action === 'modal') modal.set(event.value === true);
  else if (event.action === 'lease') scope.set({ hostID: 'host-a', lease: 'lease-two' });
  else if (event.action === 'authority') authority.set('fixture-origin-auth-two');
  else if (event.action === 'prepare') { await owner?.prepareRetirement(); updated.set(updated() + 1); }
  else if (event.action === 'cancel') { owner?.cancel(); updated.set(updated() + 1); }
  else if (event.action === 'retire') owner?.retire();
  else if (event.action === 'stale') {
    for (const expectedHost of [{ hostID: 'host-a', lease: 'lease-one' }, scope()]) {
      try { const write = beginDesktopWriterDispatch({ writer: () => originalGrant, expectedHost, path: '/api/session/session%2Fa/prompt', method: 'POST' }); write?.finish('not-dispatched'); }
      catch { staleRejected++; }
    }
  } else if (event.action !== 'audit') throw new Error('Unknown synthetic writer action');
  audit.set(JSON.stringify({ constructs, unmounts, reads, writes, laneBindings, staleRejected, phase: owner?.status().phase,
    writable: !!owner?.grant(), draft: durable?.draft(), canClose: owner?.canClose() }));
});
function Fixture() {
  cleanup(() => { disposed = true; client()?.retire(); });
  void loadDesktopWriterClient({ source: () => source, current: () => !disposed }).then(value => batch(() => { client.set(value); discovered.set(true); }));
  return <View class="flex-1"><NativeDesktopChatWriter client={client} capabilitiesReady={discovered}
    target={{ kind: 'session', id: 'session/a' }} current={() => !disposed} committedRuntimeScope={scope} stableAuthorityIdentity={authority}
    onOwner={value => { owner = value; }} scopeReady={() => { laneBindings++; }}
    waiting={status => <Text testID="chat-writer-wait">{status.phase}</Text>}>
    {(grant, _unknown, writer) => { originalGrant ??= grant(); return <Child grant={grant} writer={writer} />; }}
  </NativeDesktopChatWriter><Text testID="chat-writer-audit">{audit()}</Text><Text>{updated()}</Text></View>;
}
mount(() => <Fixture />);

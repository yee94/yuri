import { cleanup, effect, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { app, createChat, loadConnections } from '../../state';
import { loadNativeDesktopWriterClient, type DesktopWriterClient, type VerifiedDesktopWriterGrant } from '../../desktop-writer';
import { NativeDesktopChatWriter } from '../../desktop-chat-writer-native';
import { createPageOperations } from '../../page-operations';
import { createNativeLocalCommands, type NativeLocalCommandSnapshot } from '../../composer-local-commands';
import { language } from '../../i18n';
import { identity } from './Host.js';

function Writer(props: { grant(): VerifiedDesktopWriterGrant | null; markUnknown(cause?: unknown): void }) {
  const target = { kind: 'session' as const, id: identity.sessionID, title: 'Compact writer', directory: identity.directory };
  const recoveryReads = createPageOperations();
  const chat = createChat(target, { draftAuthorityKey: JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]),
    writerGrant: props.grant, writerUnknown: props.markUnknown, recoveryReadOperation: recoveryReads.operation });
  effect(() => chat.active.set(!!props.grant()));
  const outcome = signal('idle');
  const read = (): NativeLocalCommandSnapshot => ({ scope: chat.referenceScope, authority: JSON.stringify(chat.messageScope), target,
    revision: chat.composerRevision(), text: chat.draft(), inputMode: 'normal', active: chat.active(), ready: chat.draftStatus() === 'ready',
    pending: !!chat.pendingSend(), unknown: chat.pendingSend()?.uncertain === true, sending: chat.sending(), queueEditing: !!chat.queueEdit(), hasReferences: !!chat.references().length, hasMessages: chat.messages().length > 0, selection: {} });
  const registry = createNativeLocalCommands({ t: key => key, read,
    replaceText: (snapshot, text) => chat.compareAndSetDraftText(snapshot.revision, text), actions: { compact: { run: async invocation => {
      const result = await chat.admitLocalCompact(invocation); outcome.set(result.status); return result;
    } } },
    onBlocked: () => outcome.set('blocked'), onConflict: () => outcome.set('conflict'), onOutcome: (_invocation, result) => outcome.set(result.status) });
  cleanup(registry.dispose);
  return <View><Input testID="compact-document" value={chat.draft()} onChange={event => chat.setDraftText(event.value)} />
    <Button testID="compact-run" disabled={chat.draftStatus() !== 'ready' || chat.sending()} onPress={() => registry.submit()}><Text>Compact</Text></Button>
    <Button testID="compact-reconcile" onPress={() => { void chat.retrySend(); }}><Text>Read receipt</Text></Button>
    <Text testID="compact-outcome">{outcome()}</Text><Text testID="compact-pending">{chat.pendingSend() ? 'pending' : 'clear'}</Text><Text testID="compact-barrier">{chat.compactionBarrier() ? 'barrier' : 'open'}</Text>
    <Text>{chat.attachments().map(file => file.name).join(',')}</Text></View>;
}
function Fixture() {
  language.set('en');
  const ready = signal(false), client = signal<DesktopWriterClient | undefined>(undefined);
  let alive = true;
  cleanup(() => { alive = false; client()?.retire(); });
  void loadConnections().then(async () => {
    const writer = await loadNativeDesktopWriterClient({ current: () => alive });
    if (!alive) { writer?.retire(); return; }
    client.set(writer); ready.set(true);
  });
  return <View><If when={ready()}><NativeDesktopChatWriter client={client} capabilitiesReady={ready}
    target={{ kind: 'session', id: identity.sessionID }} committedRuntimeScope={app.runtimeScope}
    stableAuthorityIdentity={() => JSON.stringify([identity.hostID, identity.origin, identity.authorizationID])} current={() => alive}
    waiting={() => <Text>Waiting for verified compact writer</Text>}>
    {(grant, markUnknown) => <Writer grant={grant} markUnknown={markUnknown} />}
  </NativeDesktopChatWriter></If></View>;
}
mount(Fixture);

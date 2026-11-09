import { cleanup, Clipboard, effect, Image, keymap, lifecycle, Scroll, signal, Text, untracked, View, type JSX, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { t } from './i18n';
import { assistantQRSvg } from './assistants-qr';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { publishSettingsEditor, publishSettingsPicker } from './desktop-settings-publisher';
import { settingsObject } from './settings-protocol';
import { nativePairingLink, nativePairingRequest, nativePairingTransports, nativePendingPairings, nativeRemoteClients, type NativePairingDraft, type NativePairingTransports, type NativePendingPairing, type NativeRemoteClient } from './settings-remote-instances-core';

/** Root-owned SSH/network/settings surfaces may mount here under the same publisher. */
export type NativeRemoteConnectionsSlot = (context: { readonly active: boolean }) => JSX.Element;
export function SettingsRemoteInstances(props: SettingsCallbacks & SettingsRoute & { active?: boolean; connections?: NativeRemoteConnectionsSlot }) {
  const state = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active');
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current);
  const clients = signal<NativeRemoteClient[] | null>(null), pending = signal<NativePendingPairing[] | null>(null), currentClientId = signal<string | null>(null), transports = signal<NativePairingTransports | null>(null);
  const errors = signal({ clients: false, pending: false, transports: false });
  const panel = signal<'pair' | 'rename' | null>(null), panelOpen = signal(false), panelVisible = signal(false), confirming = signal(false);
  const rename = signal({ id: '', label: '', before: '' }), pair = signal<NativePairingDraft>({ label: '', transport: 'local', fallback: true, relayUrl: '' }), pairBaseline = signal('');
  const pairResult = signal<ReturnType<typeof nativePairingLink> | null>(null), qr = signal(''), enlarged = signal(false), copied = signal(false), pairAttempted = signal(false);
  let readRevision = 0, secretRevision = 0, polling = false, seenPending = false;
  const dirty = () => panelOpen() && (panel() === 'rename' ? rename().label !== rename().before : !pairResult() && (pairAttempted() || JSON.stringify(pair()) !== pairBaseline()));
  const owner = publishSettingsEditor({ current: state.current, scope: state.operation, pending: () => state.busy() || confirming(), dirty, stamp: () => [rename(), pair(), pairAttempted()] });
  publishSettingsPicker(() => panelOpen() || panelVisible());
  const disabled = () => state.busy() || confirming() || !state.current();
  function clearSecret() { pairResult.set(null); qr.set(''); copied.set(false); enlarged.set(false); seenPending = false; }
  cleanup(clearSecret);
  effect(() => { const active = props.active !== false && lifecycle() === 'active' && state.current(); if (!active) untracked(() => { ++readRevision; ++secretRevision; clearSecret(); }); });
  effect(() => { if (panelOpen() && props.active !== false && state.current() && !state.busy()) cleanup(keymap.bind('escape', () => { void closePanel(); }, { when: 'always' })); });
  async function load(operation: SettingsOperation, includeTransports = false) {
    if (!operation.current()) return;
    const turn = ++readRevision;
    const responses = await Promise.allSettled([
      operation.request('/api/client-auth/clients').then(nativeRemoteClients),
      operation.request('/api/client-auth/pairing/sessions').then(nativePendingPairings),
      includeTransports ? operation.request('/api/client-auth/pairing/transports').then(nativePairingTransports) : Promise.resolve(transports()),
    ]);
    if (!operation.current() || turn !== readRevision) return;
    const nextErrors = { ...errors(), clients: responses[0].status === 'rejected', pending: responses[1].status === 'rejected' };
    if (responses[0].status === 'fulfilled') { clients.set(responses[0].value.clients); currentClientId.set(responses[0].value.currentClientId); }
    if (responses[1].status === 'fulfilled') pending.set(responses[1].value);
    if (includeTransports) { nextErrors.transports = responses[2].status === 'rejected'; if (responses[2].status === 'fulfilled') transports.set(responses[2].value); }
    errors.set(nextErrors); state.ready.set(true);
    const result = pairResult();
    if (result && responses[1].status === 'fulfilled') {
      if (responses[1].value.some(entry => entry.id === result.id)) seenPending = true;
      else if (seenPending) {
        if (responses[0].status === 'fulfilled' && responses[0].value.clients.some(client => client.pairingId === result.id && !client.revokedAt)) state.notice.set(t('settings.remoteInstances.clientAuth.addDevice.connectedToast'));
        panelOpen.set(false); clearSecret();
      }
    }
  }
  const refresh = () => state.perform(operation => load(operation, true));
  void refresh();
  state.observeOperation(operation => { readRevision++; clearSecret(); if (operation) void state.perform(next => load(next, true), operation); });
  effect(() => {
    const operation = state.operation(), active = props.active !== false && lifecycle() === 'active';
    if (!operation?.current() || !active) return;
    const timer = setInterval(() => {
      const result = pairResult();
      if (result?.expiresAt && Date.parse(result.expiresAt) <= Date.now()) { clearSecret(); panelOpen.set(false); }
      if (!operation.current() || state.busy() || confirming() || polling) return;
      polling = true; void load(operation).catch(() => { /* Independent resource errors are published by load. */ }).finally(() => { polling = false; });
    }, 5_000);
    cleanup(() => clearInterval(timer));
  });
  async function closePanel() { if (await owner.requestLeave()) { panelOpen.set(false); clearSecret(); } }
  async function confirm(title: string, label: string, operation: SettingsOperation) {
    if (confirming() || state.busy() || !operation.current()) return false;
    confirming.set(true);
    try { const answer = await AlertDialog.show({ title, actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'confirm', label, role: 'destructive' }] }); return answer.action === 'confirm' && operation.current(); }
    finally { confirming.set(false); }
  }
  async function mutate(kind: 'revoke' | 'cancel' | 'purge', id?: string) {
    const operation = state.operation(); if (disabled() || !operation) return;
    const label = t(kind === 'revoke' ? 'settings.remoteInstances.clientAuth.actions.revoke' : kind === 'purge' ? 'settings.remoteInstances.clientAuth.actions.clearRevoked' : 'settings.remoteInstances.sidebar.actions.remove');
    if (!await confirm(label, label, operation)) return;
    await state.perform(async operation => {
      ++readRevision;
      const path = kind === 'cancel' ? `/api/client-auth/pairing/sessions/${encodeURIComponent(id ?? '')}` : `/api/client-auth/clients${kind === 'revoke' ? `/${encodeURIComponent(id ?? '')}` : ''}`;
      const receipt = settingsObject(await operation.transaction(path, 'DELETE'));
      if (kind === 'revoke' && receipt.revoked !== true || kind === 'cancel' && receipt.cancelled !== true || kind === 'purge' && (!Number.isInteger(receipt.purged) || Number(receipt.purged) < 0)) throw new Error(t('settings.remoteInstances.quick.error'));
      await load(operation);
    }, operation);
  }
  async function saveName() {
    let saved = false;
    await state.perform(async operation => {
      const draft = rename(); if (!draft.label.trim()) return;
      ++readRevision;
      const response = settingsObject(await operation.transaction(`/api/client-auth/clients/${encodeURIComponent(draft.id)}`, 'PATCH', { label: draft.label.trim() }));
      const client = nativeRemoteClients({ clients: [response.client] }).clients[0];
      if (client.id !== draft.id) throw new Error(t('settings.remoteInstances.quick.error'));
      if (!operation.current()) return;
      clients.set((clients() ?? []).map(row => row.id === client.id ? client : row)); rename.set({ id: client.id, label: client.label, before: client.label }); saved = true;
      await load(operation);
    });
    if (saved && state.current()) panelOpen.set(false);
  }
  async function openPair() {
    if (disabled()) return;
    clearSecret(); pairAttempted.set(false); errors.set({ ...errors(), transports: true });
    pairBaseline.set(JSON.stringify(pair())); panel.set('pair'); panelOpen.set(true);
    await state.perform(async operation => {
      const value = nativePairingTransports(await operation.request('/api/client-auth/pairing/transports'));
      if (!operation.current()) return;
      transports.set(value); errors.set({ ...errors(), transports: false });
      const draft: NativePairingDraft = { label: value.serverName ?? '', transport: value.relayAvailable ? 'relay' : value.lan ? 'lan' : 'local', fallback: true, relayUrl: value.relayUrl ?? value.relayUrls?.[0] ?? '' };
      pair.set(draft); pairBaseline.set(JSON.stringify(draft));
    });
  }
  function editPair(patch: Partial<NativePairingDraft>) { if (!disabled() && !pairResult() && !pairAttempted()) pair.set({ ...pair(), ...patch }); }
  async function createPairing() {
    if (pairAttempted()) return;
    await state.perform(async operation => {
      const available = transports(); if (!available || errors().transports) throw new Error(t('settings.remoteInstances.quick.error'));
      let input: ReturnType<typeof nativePairingRequest>;
      try { input = nativePairingRequest(pair(), available); } catch { throw new Error(t('settings.remoteInstances.clientAuth.addDevice.relayUrlInvalid')); }
      ++readRevision; const secretTurn = ++secretRevision; pairAttempted.set(true);
      let response: unknown;
      try { response = await operation.transaction('/api/client-auth/pairing/sessions', 'POST', input); }
      catch { throw new Error(t('settings.common.writeUnconfirmed')); }
      if (!operation.current() || secretTurn !== secretRevision) return;
      const result = nativePairingLink(response, pair().label);
      // Retain the link even if QR capacity fails, so explicit copy can recover without minting another secret.
      pairResult.set(result);
      try { qr.set('data:image/svg+xml,' + encodeURIComponent(assistantQRSvg(result.url))); }
      catch { state.error.set(t('common.unavailable')); }
      await load(operation);
    });
  }
  const status = (client: NativeRemoteClient) => t(client.revokedAt ? 'settings.remoteInstances.clientAuth.state.revoked' : client.connected === true ? client.lastTransport === 'relay' ? 'settings.remoteInstances.clientAuth.state.connectedRelay' : client.lastTransport === 'direct' ? 'settings.remoteInstances.clientAuth.state.connectedDirect' : 'mobile.instances.status.connected' : 'mobile.instances.status.saved');
  return <Scroll ref={scroll} onScroll={event => navigation.onScroll(event)} class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={() => { void refresh(); }} />
    <SettingsTarget id="remote-instances.instances" target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsGroup title={t('settings.remoteInstances.direct.title')}>
      <Button testID="remote-instances-saved" class={settingsAction} disabled={disabled()} onPress={() => props.onOpen({ page: 'instances', directory: props.directory })}><Text>{t('mobile.connect.saved.title')}</Text></Button>
      <Button testID="remote-instances-connect" class={settingsAction} disabled={disabled()} onPress={props.onConnect}><Text>{t('mobile.instances.addTitle')}</Text></Button>
      {props.connections?.({ get active() { return props.active !== false; } })}
    </SettingsGroup></SettingsTarget>
    <SettingsTarget id="remote-instances.client-auth" target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsGroup title={t('settings.remoteInstances.clientAuth.title')}>
      <View class="flex-row flex-wrap gap-2"><Button testID="remote-clients-refresh" class={settingsAction} disabled={disabled()} onPress={() => { void refresh(); }}><Text>{t('chat.questionDelegate.retry')}</Text></Button>
        <Button testID="remote-clients-add" class={settingsAction} disabled={disabled()} onPress={() => { void openPair(); }}><Text>{t('settings.remoteInstances.clientAuth.actions.addDevice')}</Text></Button>
        <If when={(clients() ?? []).some(client => !!client.revokedAt)}><Button testID="remote-clients-purge" class={settingsAction} disabled={disabled()} onPress={() => { void mutate('purge'); }}><Text>{t('settings.remoteInstances.clientAuth.actions.clearRevoked')}</Text></Button></If></View>
      <If when={errors().clients || errors().pending}><Text testID="remote-clients-stale" class="text-sm text-destructive">{t('settings.remoteInstances.quick.error')}</Text></If>
      <If when={clients() !== null && pending() !== null && !clients()?.length && !pending()?.length && !errors().clients && !errors().pending}><Text class="text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.empty')}</Text></If>
      <Each of={pending() ?? []}>{entry => <View testID={`remote-pending-${entry().id}`} class="gap-2 py-2">
        <Text class="text-foreground">{entry().label || t('settings.remoteInstances.clientAuth.field.labelPlaceholder')}</Text><Text class="text-xs text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.pending')} · {entry().expiresAt ?? ''}</Text>
        <If when={entry().usesRelay}><Text class="text-xs text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.viaRelay')}</Text></If>
        <Button testID={`remote-pending-cancel-${entry().id}`} class={settingsAction} disabled={disabled()} onPress={() => { void mutate('cancel', entry().id); }}><Text>{t('settings.common.actions.cancel')}</Text></Button>
      </View>}</Each>
      <Each of={clients() ?? []}>{client => <View testID={`remote-client-${client().id}`} class="gap-2 py-2">
        <Text class="text-foreground">{client().label}</Text><Text class="text-xs text-muted-foreground">{status(client())}</Text>
        <If when={client().id === currentClientId()}><Text class="text-xs text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.thisDevice')}</Text></If>
        <Text class="text-xs text-muted-foreground">{client().deviceName ?? ''} {client().devicePlatform ?? ''}</Text>
        <Text class="text-xs text-muted-foreground">{client().lastUsedAt ? t('settings.remoteInstances.clientAuth.lastUsed', { date: client().lastUsedAt ?? '' }) : t('settings.remoteInstances.clientAuth.neverUsed')}</Text>
        <View class="flex-row gap-2"><Button testID={`remote-client-rename-${client().id}`} class={settingsAction} disabled={disabled() || !!client().revokedAt} onPress={() => { rename.set({ id: client().id, label: client().label, before: client().label }); panel.set('rename'); panelOpen.set(true); }}><Text>{t('settings.remoteInstances.clientAuth.edit.action')}</Text></Button>
          <Button testID={`remote-client-revoke-${client().id}`} class={settingsAction} disabled={disabled() || !!client().revokedAt} onPress={() => { void mutate('revoke', client().id); }}><Text class="text-destructive">{t('settings.remoteInstances.clientAuth.actions.revoke')}</Text></Button></View>
      </View>}</Each>
    </SettingsGroup></SettingsTarget>
    <NativeSheet open={panelOpen()} closeOnSwipe={!dirty() && !state.busy()} closeOnBackdropPress={!dirty() && !state.busy()} closeOnEscape={false} onOpen={() => panelVisible.set(true)} onOpenChange={event => { if (!event.open) void closePanel(); }} onClose={() => { panelVisible.set(false); if (!panelOpen()) { panel.set(null); clearSecret(); } }} popupClass="bg-background" popupStyle={{ height: 720 }}>
      <Scroll testID="remote-instances-panel" class="flex-1" contentClass="p-5 gap-5 pb-10"><SettingsFeedback state={state} />
        <If when={panel() === 'rename'}><SettingsGroup title={t('settings.remoteInstances.clientAuth.edit.title')}>
          <SettingsInput testID="remote-client-name" title={t('settings.remoteInstances.clientAuth.edit.name')} value={rename().label} disabled={disabled()} onChange={label => { if (!disabled()) rename.set({ ...rename(), label }); }} />
          <Button testID="remote-client-name-save" class={settingsAction} disabled={disabled() || !rename().label.trim() || rename().label === rename().before} onPress={() => { void saveName(); }}><Text>{t('settings.common.actions.saveChanges')}</Text></Button>
        </SettingsGroup></If>
        <If when={panel() === 'pair'}><SettingsGroup title={t('settings.remoteInstances.clientAuth.actions.addDevice')}>
          <If when={!pairResult()}><SettingsInput testID="remote-pair-name" title={t('settings.remoteInstances.pairing.name')} value={pair().label} disabled={disabled() || pairAttempted()} onChange={label => editPair({ label })} />
            <SettingsChoice testID="remote-pair-transport" title={t('settings.remoteInstances.clientAuth.addDevice.transportLabel')} value={pair().transport} items={(['relay', 'lan', 'local'] as const).filter(value => value === 'relay' ? transports()?.relayAvailable : !!transports()?.[value]).map(value => ({ value, title: t(`settings.remoteInstances.clientAuth.addDevice.transport.${value}`) }))} disabled={disabled() || pairAttempted() || errors().transports} onChange={transport => { if (transport === 'relay' || transport === 'lan' || transport === 'local') editPair({ transport }); }} />
            <If when={pair().transport !== 'local' && transports()?.relayAvailable}><SettingsToggle testID="remote-pair-fallback" title={t(pair().transport === 'relay' ? 'settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal' : 'settings.remoteInstances.clientAuth.addDevice.fallback.relay')} value={pair().fallback} disabled={disabled() || pairAttempted()} onChange={fallback => editPair({ fallback })} />
              <SettingsInput testID="remote-pair-relay" title={t('settings.remoteInstances.clientAuth.addDevice.relayUrlLabel')} value={pair().relayUrl} disabled={disabled() || pairAttempted() || transports()?.relayUrlLocked} onChange={relayUrl => editPair({ relayUrl })} /><If when={transports()?.relayUrlLocked}><Text class="text-xs text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.relayUrlLockedHint')}</Text></If></If>
            <Button testID="remote-pair-create" class={settingsAction} disabled={disabled() || !transports() || errors().transports || pairAttempted()} onPress={() => { void createPairing(); }}><Text>{t('settings.remoteInstances.clientAuth.addDevice.create')}</Text></Button>
          </If>
          <If when={!!pairResult()}><Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.clientAuth.qrScanHint')}</Text><Text class="text-xs text-muted-foreground">{t('settings.remoteInstances.relay.pair.warning')}</Text>
            <If when={!!qr()}><Button testID="remote-pair-qr-enlarge" accessibilityLabel={t('settings.remoteInstances.clientAuth.qrEnlarge')} onPress={() => enlarged.set(!enlarged())}><Image testID="remote-pair-qr" src={qr()} accessibilityLabel={t('settings.remoteInstances.clientAuth.qrAlt')} style={{ width: enlarged() ? 480 : 280, height: enlarged() ? 480 : 280, maxWidth: '100%' }} /></Button></If>
            <Text class="text-xs text-muted-foreground">{pairResult()?.expiresAt ?? ''}</Text>
            <Button testID="remote-pair-copy" class={settingsAction} disabled={disabled()} onPress={() => { const value = pairResult(); if (value && state.current()) void Clipboard.writeText(value.url).then(() => { if (state.current() && pairResult() === value) copied.set(true); }, () => state.error.set(t('common.unavailable'))); }}><Text>{t(copied() ? 'settings.remoteInstances.clientAuth.actions.copied' : 'sessions.sidebar.session.menu.copyLink')}</Text></Button>
          </If>
        </SettingsGroup></If>
        <Button testID="remote-instances-panel-close" class={settingsAction} disabled={disabled()} onPress={() => { void closePanel(); }}><Text>{t(pairResult() ? 'settings.remoteInstances.clientAuth.addDevice.done' : 'settings.common.actions.cancel')}</Text></Button>
      </Scroll>
    </NativeSheet>
  </Scroll>;
}

import { cleanup, effect, lifecycle, signal, Text, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction } from './settings-controls';
import { publishSettingsEditor } from './desktop-settings-publisher';
import type { NativeRemoteConnectionsSlot } from './settings-remote-instances';
import { createDesktopRemoteConnectionsController, desktopSshDefaultSelections, desktopSshDirectories, desktopSshInstance, type DesktopRemoteConnectionsController, type DesktopRemoteConnectionsOptions, type DesktopRemoteConnectionsPort, type DesktopSshInstance, type DesktopSshStatus } from './desktop-remote-connections-core';
import type { NativeDesktopRemoteConnectionsPort } from './desktop-remote-connections-native-core';

/** Construct once at the local window root. No capability is invented when no port is supplied. */
export function createDesktopRemoteConnections(port: DesktopRemoteConnectionsPort, options: DesktopRemoteConnectionsOptions = {}) {
  const controller = createDesktopRemoteConnectionsController(port, options);
  const slot: NativeRemoteConnectionsSlot = context => <DesktopRemoteConnections controller={controller} active={context.active} />;
  return { controller, slot, dispose: controller.dispose };
}
/** A discovered connection-only port owns no sync methods or product grant. */
export function createDesktopConnectionOnlyRemoteConnections(port: NativeDesktopRemoteConnectionsPort, options: DesktopRemoteConnectionsOptions = {}) {
  const owner = createDesktopRemoteConnections(port, options);
  return { ...owner, refreshCapabilities: owner.controller.refreshCapabilities,
    dispose() { owner.dispose(); port.dispose(); } };
}
const phaseKeys: Record<DesktopSshStatus['phase'], I18nKey> = {
  idle: 'settings.remoteInstances.sidebar.phase.idle', auth_check: 'settings.remoteInstances.page.phase.checkingAuth',
  remote_probe: 'settings.remoteInstances.page.phase.probingRemote', checked: 'gitView.common.done',
  installing: 'settings.remoteInstances.page.phase.installingYuri', updating: 'settings.remoteInstances.page.phase.updatingYuri',
  server_detecting: 'settings.remoteInstances.page.phase.detectingServer', forwarding: 'settings.remoteInstances.page.phase.forwardingPorts',
  ready: 'settings.remoteInstances.sidebar.phase.ready', reconnecting: 'settings.remoteInstances.page.phase.reconnecting', error: 'settings.remoteInstances.sidebar.phase.error',
};
type Draft = { id: string; label: string; host: string; user: string; port: string; remotePort: string; localPort: string; managed: boolean };
const draftOf = (row: DesktopSshInstance): Draft => ({ ...row, port: String(row.port), remotePort: String(row.remotePort), localPort: String(row.localPort) });
function DesktopRemoteConnections(props: { controller: DesktopRemoteConnectionsController; active: boolean }) {
  const controller = props.controller, state = signal(controller.state()), draft = signal<Draft | null>(null), baseline = signal(''), baselineRevision = signal(-1), invalid = signal(false), confirming = signal(false);
  const selections = signal(desktopSshDefaultSelections());
  const unsubscribe = controller.subscribe(() => state.set(controller.state())); cleanup(unsubscribe);
  const active = () => props.active && lifecycle() === 'active' && controller.current();
  const dirty = () => draft() !== null && JSON.stringify(draft()) !== baseline();
  const selected = () => state().snapshot?.instances.find(row => row.id === draft()?.id);
  const editor = publishSettingsEditor({ current: active, scope: () => controller, dirty, pending: () => { void state(); const row = selected(); return !(row ? controller.canPrepareConnection(row) : controller.canLeave()) || confirming(); }, stamp: () => [draft(), state().unknown, state().sync, controller.connectionOperation()] });
  const disabled = () => !active() || !state().ready || !controller.ready() || state().busy || !!state().unknown || state().sync?.phase === 'unknown' || controller.connectionOperation()?.phase === 'admitting' || confirming() || !state().snapshot;
  const stale = () => !!selected() && !!baseline() && JSON.stringify(draftOf(selected()!)) !== baseline();
  const status = () => state().snapshot?.statuses.find(row => row.id === draft()?.id);
  const locked = () => disabled() || !!status()?.running || status()?.phase === 'ready' || status()?.phase === 'reconnecting';
  effect(() => {
    void controller.ready();
    const enabled = active(); controller.setActive(enabled);
    if (enabled) { void controller.refresh(); const timer = setInterval(() => { void controller.refresh(); }, 3000); cleanup(() => clearInterval(timer)); }
  });
  cleanup(() => controller.setActive(false));
  async function choose(row?: DesktopSshInstance) {
    const revision = state().snapshot?.revision ?? -1;
    if (!active() || !await editor.requestLeave() || !active()) return;
    controller.clearPreview(); invalid.set(false);
    const next = row ? draftOf(row) : { id: controller.newID(), label: '', host: '', user: '', port: '22', remotePort: '3210', localPort: '0', managed: true };
    draft.set(next); baseline.set(row ? JSON.stringify(next) : ''); baselineRevision.set(revision);
  }
  function update(key: keyof Draft, value: string | boolean) {
    const before = draft(); if (!before || locked()) return;
    draft.set({ ...before, [key]: value }); invalid.set(false);
  }
  async function save() {
    const before = draft(); if (!before || locked()) return;
    let row: DesktopSshInstance;
    try {
      if (![before.port, before.remotePort, before.localPort].every(value => /^\d+$/.test(value))) throw new Error('ssh_invalid');
      row = desktopSshInstance({ ...before, label: before.label.trim(), host: before.host.trim(), user: before.user.trim(), port: Number(before.port), remotePort: Number(before.remotePort), localPort: Number(before.localPort) });
    } catch { invalid.set(true); return; }
    if (await controller.save(row, baselineRevision()) && draft() === before) { const next = draftOf(row); draft.set(next); baseline.set(JSON.stringify(next)); baselineRevision.set(state().snapshot?.revision ?? -1); }
  }
  async function remove() {
    const row = selected(); if (!row || locked()) return;
    confirming.set(true);
    try {
      const result = await AlertDialog.show({ title: t('settings.remoteInstances.page.confirm.removeInstance'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'remove', label: t('settings.remoteInstances.sidebar.actions.remove'), role: 'destructive' },
      ] });
      if (result.action === 'remove' && active() && selected()?.id === row.id && await controller.remove(row.id, baselineRevision())) { draft.set(null); baseline.set(''); }
    } finally { confirming.set(false); }
  }
  const actionsDisabled = () => disabled() || !selected() || dirty() || stale();
  const syncDisabled = () => !controller.syncSupported() || actionsDisabled();
  async function connectSelected() {
    const row = selected(), before = draft();
    if (!row || actionsDisabled() || !controller.connectionAvailable('settings')) return;
    await controller.connect(row, { source: 'settings', current: () => active() && draft() === before && !dirty() && !stale() });
  }
  function selectFlag(key: 'fileGroups' | 'singleFiles' | 'directories', index: number, value: boolean) {
    if (syncDisabled()) return;
    controller.clearPreview(); selections.set({ ...selections(), [key]: selections()[key].map((v, i) => i === index ? value : v) });
  }
  function selectAgents(value: boolean) { if (!syncDisabled()) { controller.clearPreview(); selections.set({ ...selections(), agentsRoot: value }); } }
  return <View testID="desktop-ssh-owner" class="gap-3">
    <Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.native.security')}</Text>
    <If when={!state().ready || !controller.ready()}><Text testID="desktop-ssh-unavailable" class="text-sm text-muted-foreground">{t('settings.view.unavailable.title')}</Text></If>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="desktop-ssh-add" class={settingsAction} disabled={disabled()} onPress={() => { void choose(); }}><Text>{t('settings.remoteInstances.sidebar.actions.addSshInstance')}</Text></Button>
      <Button testID="desktop-ssh-refresh" class={settingsAction} disabled={!active() || state().busy} onPress={() => { void controller.refresh(); if (controller.syncSupported()) void controller.refreshSync(); }}><Text>{t('chat.questionDelegate.retry')}</Text></Button>
    </View>
    <If when={state().unknown || state().sync?.phase === 'unknown'}><Text testID="desktop-ssh-unknown" class="text-sm text-destructive">{t('settings.remoteInstances.native.unknown')}</Text></If>
    <If when={state().failed || invalid() || stale()}><Text testID="desktop-ssh-error" class="text-sm text-destructive">{t('settings.remoteInstances.quick.error')}</Text></If>
    <Each of={state().snapshot?.instances ?? []}>{item => <Button testID={`desktop-ssh-${item().id}`} class={settingsAction} disabled={disabled()} onPress={() => { void choose(item()); }}><Text>{item().label}</Text></Button>}</Each>
    <If when={draft()}><SettingsGroup title={t('settings.remoteInstances.page.section.instance')}>
      <SettingsInput testID="desktop-ssh-label" title={t('settings.remoteInstances.page.field.nickname')} value={draft()?.label ?? ''} onChange={value => update('label', value)} disabled={locked()} />
      <SettingsInput testID="desktop-ssh-host" title={t('settings.remoteInstances.native.host')} value={draft()?.host ?? ''} onChange={value => update('host', value)} disabled={locked()} />
      <SettingsInput testID="desktop-ssh-user" title={t('settings.remoteInstances.native.user')} value={draft()?.user ?? ''} onChange={value => update('user', value)} disabled={locked()} />
      <SettingsInput testID="desktop-ssh-port" title={t('settings.remoteInstances.native.port')} value={draft()?.port ?? ''} onChange={value => update('port', value)} disabled={locked()} />
      <SettingsInput testID="desktop-ssh-remote-port" title={t('settings.remoteInstances.page.field.preferredRemotePort')} value={draft()?.remotePort ?? ''} onChange={value => update('remotePort', value)} disabled={locked()} />
      <SettingsInput testID="desktop-ssh-local-port" title={t('settings.remoteInstances.page.field.preferredLocalPort')} value={draft()?.localPort ?? ''} onChange={value => update('localPort', value)} disabled={locked()} />
      <SettingsChoice testID="desktop-ssh-mode" title={t('settings.remoteInstances.page.field.mode')} value={draft()?.managed ? 'managed' : 'external'} items={[{ value: 'managed', title: t('settings.remoteInstances.page.field.modeManaged') }, { value: 'external', title: t('settings.remoteInstances.page.field.modeExternal') }]} disabled={locked()} onChange={value => update('managed', value === 'managed')} />
      <View class="flex-row flex-wrap gap-2">
        <Button testID="desktop-ssh-save" class={settingsAction} disabled={locked() || !dirty()} onPress={() => { void save(); }}><Text>{t('settings.common.actions.saveChanges')}</Text></Button>
        <Button testID="desktop-ssh-remove" class={settingsAction} disabled={locked() || !selected()} onPress={() => { void remove(); }}><Text>{t('settings.remoteInstances.sidebar.actions.remove')}</Text></Button>
        <Button testID="desktop-ssh-check" class={settingsAction} disabled={actionsDisabled() || locked()} onPress={() => { if (selected()) void controller.start(selected()!.id, 'check'); }}><Text>{t('settings.remoteInstances.native.check')}</Text></Button>
        <Button testID="desktop-ssh-connect" class={settingsAction} disabled={!controller.connectionAvailable('settings') || actionsDisabled() || !controller.canLeave() || !!status()?.running} onPress={() => { void connectSelected(); }}><Text>{t('settings.remoteInstances.sidebar.actions.connect')}</Text></Button>
        <Button testID="desktop-ssh-cancel" class={settingsAction} disabled={actionsDisabled() || !status()} onPress={() => { const row = status(); if (row) void controller.cancel(row.id, row.attempt); }}><Text>{t(status()?.phase === 'ready' ? 'settings.remoteInstances.sidebar.actions.disconnect' : 'settings.remoteInstances.page.actions.cancel')}</Text></Button>
      </View>
      <If when={status()}><Text testID="desktop-ssh-status" class="text-sm text-muted-foreground">{t(phaseKeys[status()!.phase])}</Text></If>
      <If when={status()?.error}><Text class="text-sm text-destructive">{t('settings.remoteInstances.sidebar.toast.connectFailed')}</Text></If>
      <If when={status()?.phase === 'ready' && !controller.syncSupported()}><Text testID="desktop-ssh-sync-unavailable" class="text-sm text-muted-foreground">{t('settings.view.unavailable.title')}</Text></If>
      <If when={controller.syncSupported() && status()?.phase === 'ready'}>
        <Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.description')}</Text>
        <SettingsToggle testID="desktop-ssh-select-config" title="config.json / opencode.json / opencode.jsonc" value={selections().fileGroups[0]} disabled={syncDisabled()} onChange={value => selectFlag('fileGroups', 0, value)} />
        <Each of={['AGENTS.md', 'cursor-models.json']}>{(name, index) => <SettingsToggle title={name()} value={selections().singleFiles[index()]} disabled={syncDisabled()} onChange={value => selectFlag('singleFiles', index(), value)} />}</Each>
        <Each of={desktopSshDirectories}>{(name, index) => <SettingsToggle title={name()} value={selections().directories[index()]} disabled={syncDisabled()} onChange={value => selectFlag('directories', index(), value)} />}</Each>
        <SettingsToggle title={t('settings.remoteInstances.page.sync.section.agentsRoot')} value={selections().agentsRoot} disabled={syncDisabled()} onChange={selectAgents} />
        <Each of={['settings.remoteInstances.page.sync.section.providerCredentials', 'settings.remoteInstances.page.sync.section.magpie'] as const}>{key => <View class="gap-1"><SettingsToggle title={t(key())} value={false} disabled onChange={() => {}} /><Text class="text-sm text-muted-foreground">{t('settings.view.unavailable.title')}</Text></View>}</Each>
        <Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.note.backup')}</Text>
        <View class="flex-row flex-wrap gap-2"><Each of={['push', 'pull'] as const}>{direction => <View class="gap-2"><Button testID={`desktop-ssh-sync-${direction()}`} class={settingsAction} disabled={syncDisabled()} onPress={() => { if (selected()) void controller.preview(selected()!.id, direction(), selections()); }}><Text>{t(direction() === 'push' ? 'settings.remoteInstances.page.sync.direction.push' : 'settings.remoteInstances.page.sync.direction.pull')}</Text></Button><Button testID={`desktop-ssh-history-${direction()}`} class={settingsAction} disabled={!controller.syncSupported() || !active() || state().busy || !selected()} onPress={() => { if (selected()) void controller.history(selected()!.id, direction()); }}><Text>{t('settings.remoteInstances.page.sync.runs.title')} · {t(direction() === 'push' ? 'settings.remoteInstances.page.sync.direction.push' : 'settings.remoteInstances.page.sync.direction.pull')}</Text></Button></View>}</Each></View>
      </If>
      <If when={controller.syncSupported() && state().preview}>
        <Text class="text-sm text-foreground">{t('settings.remoteInstances.page.sync.step.confirm')}</Text>
        <Each of={state().preview?.files ?? []}>{file => <Text class="text-sm text-muted-foreground">{file().name} · {file().bytes}</Text>}</Each>
        <Each of={state().preview?.directories ?? []}>{directory => <Text testID={`desktop-ssh-review-${directory().name}`} class="text-sm text-muted-foreground">{directory().name} · {t('settings.remoteInstances.page.sync.section.agentsRootCount', { count: directory().fileCount })} · {directory().bytes}</Text>}</Each>
        <If when={state().preview?.agentsRoot}><Text testID="desktop-ssh-review-agents-root" class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.section.agentsRoot')} · {t('settings.remoteInstances.page.sync.section.agentsRootCount', { count: state().preview!.agentsRoot!.fileCount })} · {state().preview!.agentsRoot!.bytes}</Text></If>
        <Each of={state().preview?.deletes ?? []}>{name => <Text class="text-sm text-destructive">{t('settings.common.actions.delete')} · {name()}</Text>}</Each>
        <Button testID="desktop-ssh-sync-apply" class={settingsAction} disabled={syncDisabled() || !!state().sync} onPress={() => { void controller.apply(); }}><Text>{t('settings.remoteInstances.page.sync.actions.syncNow')}</Text></Button>
      </If>
      <If when={controller.syncSupported() && state().sync?.phase === 'success'}><Text testID="desktop-ssh-sync-success" class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.runs.result.success')}</Text></If>
      <If when={controller.syncSupported() && state().sync?.phase === 'failure'}><Text class="text-sm text-destructive">{t('settings.remoteInstances.page.sync.runs.result.failure')}</Text></If>
      <If when={controller.syncSupported() && state().history}>
        <Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.runs.title')}</Text>
        <If when={!state().history?.runs.length}><Text class="text-sm text-muted-foreground">{t('settings.remoteInstances.page.sync.runs.empty')}</Text></If>
        <Each of={state().history?.runs ?? []}>{run => <Text testID={`desktop-ssh-history-${run().runID}`} class="text-sm text-muted-foreground">{run().runID} · {t(run().phase === 'success' ? 'settings.remoteInstances.page.sync.runs.result.success' : run().phase === 'failure' ? 'settings.remoteInstances.page.sync.runs.result.failure' : 'settings.remoteInstances.native.unknown')} · {run().bytes}</Text>}</Each>
      </If>
    </SettingsGroup></If>
  </View>;
}

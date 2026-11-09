import { colorScheme, Scroll, Text, token, View } from 'nsh';
import { Button, Progress, Switch, Tooltip } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import light from '../ui/src/lib/theme/themes/yuri-2-light.json';
import { desktopHeaderInstanceDisplay, desktopHeaderInstanceVersion, type DesktopHeaderInstance, type DesktopHeaderInstanceAction, type DesktopHeaderMcpRow, type DesktopHeaderServicesOwner, type DesktopHeaderServicesSnapshot } from './desktop-header-services';

type Props = { owner: DesktopHeaderServicesOwner; snapshot: DesktopHeaderServicesSnapshot; directory?: string };
const quiet = 'items-center justify-center rounded-md hover:bg-secondary active:bg-accent focus:border focus:border-ring disabled:opacity-50';
const action = 'rounded-md bg-secondary px-2 py-1 hover:bg-accent focus:border focus:border-ring disabled:opacity-50';
const labelStyle = { fontSize: 13, lineHeight: 20 };
const metaStyle = { fontSize: 11, lineHeight: 17 };
function Hint(props: { text: string }) { return <Tooltip><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{props.text}</Text></View></Tooltip>; }
function stale() { return <Text testID="desktop-header-services-stale" class="px-4 py-1 text-xs text-muted-foreground">{t('chat.questionDelegate.stale')}</Text>; }
function feedback(retry: () => void, disabled: boolean) {
  return <View testID="desktop-header-services-error" class="flex-row items-center gap-2 px-4 py-2">
    <Text class="flex-1 text-destructive" style={metaStyle}>{t('mcpDropdown.status.unknownError')}</Text>
    <Button accessibilityLabel={t('desktopHostSwitcher.actions.retry')} class={action} disabled={disabled} onPress={retry}><Text class="text-foreground" style={metaStyle}>{t('desktopHostSwitcher.actions.retry')}</Text></Button>
  </View>;
}
function mcpLabel(row: DesktopHeaderMcpRow) {
  switch (row.status?.status) {
    case 'connected': return t('mcpDropdown.status.connected');
    case 'failed': return t('mcpDropdown.status.failed', { error: row.status.error || t('mcpDropdown.status.unknownError') });
    case 'needs_auth': return t('mcpDropdown.status.needsAuth');
    case 'needs_client_registration': return t('mcpDropdown.status.needsRegistration', { error: row.status.error || '' });
    case 'pending': return t('common.loading');
    case 'disabled': return t('guiPlugins.disabled');
    default: return t('mcpDropdown.status.unknown');
  }
}
function mcpTone(row: DesktopHeaderMcpRow) {
  const colors = (colorScheme() === 'dark' ? dark : light).colors;
  switch (row.status?.status) {
    case 'connected': return colors.status.success;
    case 'failed': return colors.status.error;
    case 'needs_auth': case 'needs_client_registration': return colors.status.warning;
    default: return String(token('muted-foreground'));
  }
}

/** Data-only slots. Mount/unmount performs ZERO reads and never owns demand. */
export function NativeDesktopHeaderMcp(props: Props) {
  const interactive = () => props.snapshot.active && props.snapshot.tab === 'mcp';
  const loading = () => props.snapshot.statuses.loading || props.snapshot.configs.loading;
  const canToggle = (name: string) => interactive() && !props.snapshot.statuses.stale && !props.snapshot.statuses.failed && !props.snapshot.statuses.loading && !['pending', 'unknown'].includes(props.snapshot.mutations[name]);
  return <View testID="desktop-header-services-mcp">
    <View class="flex-row items-center gap-3 px-4 py-2.5 border-b border-border">
      <Text class="text-foreground" style={{ ...labelStyle, fontWeight: '600' }}>{t('mcpDropdown.title')}</Text>
      <Text class="flex-1 text-muted-foreground" style={{ ...metaStyle, numberOfLines: 1 }}>{props.directory?.replace(/\/$/, '').split('/').pop() || ''}</Text>
      <Button testID="desktop-header-services-mcp-refresh" accessibilityLabel={t('mcpDropdown.actions.refreshAria')} class={quiet} style={{ width: 28, height: 28 }} disabled={!interactive() || loading()} onPress={() => { void props.owner.refreshMcp(); }}><Icon name="refresh" size={16} /></Button>
    </View>
    <If when={loading()}><Text class="px-4 py-1 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
    <If when={props.snapshot.statuses.failed || props.snapshot.configs.failed}>{feedback(() => { void props.owner.refreshMcp(true); }, !interactive() || loading())}</If>
    <If when={props.snapshot.statuses.stale && props.snapshot.statuses.value !== null}>{stale()}</If>
    <Scroll testID="desktop-header-services-mcp-list" style={{ maxHeight: 256 }}>
      <View class="px-3 py-2.5"><View class={props.snapshot.mcp.length ? 'rounded-xl bg-muted p-1.5' : ''}>
        <Each of={props.snapshot.mcp} key={row => row.name}>{row => <View>
          <View testID={`desktop-header-services-mcp-row-${row().name}`} class="flex-row items-center gap-2 px-2.5 py-2 rounded-lg">
            <View tooltip={<Hint text={mcpLabel(row())} />} accessibilityLabel={mcpLabel(row())} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: mcpTone(row()) }} />
            <Text class="flex-1 min-w-0 text-foreground" style={{ ...labelStyle, numberOfLines: 1 }}>{row().name}</Text>
            <Switch testID={`desktop-header-services-mcp-toggle-${row().name}`} accessibilityLabel={`${row().name}: ${mcpLabel(row())}`} checked={row().status?.status === 'connected'} disabled={!canToggle(row().name)}
              class="flex-row items-center disabled:opacity-50 focus:border focus:border-ring rounded-full" trackClass="w-8 h-4 rounded-full bg-border checked:bg-ring" thumbClass="w-3 h-3 m-0.5 rounded-full bg-background checked:translate-x-4"
              onChange={event => { void props.owner.toggleMcp(row().name, event.checked); }} />
          </View>
          <If when={props.snapshot.mutations[row().name] && props.snapshot.mutations[row().name] !== 'pending'}><View class="flex-row items-center gap-2 px-2.5 pb-2">
            <Text class="flex-1 text-destructive" style={metaStyle}>{props.snapshot.mutations[row().name] === 'unknown' ? t('mcpDropdown.status.unknown') : t('mcpDropdown.status.unknownError')}</Text>
            <Button testID={`desktop-header-services-mcp-retry-${row().name}`} class={action} disabled={!interactive() || loading()} onPress={() => { void props.owner.reconcileMcp(row().name); }}><Text class="text-foreground" style={metaStyle}>{t('desktopHostSwitcher.actions.retry')}</Text></Button>
          </View></If>
        </View>}</Each>
        <If when={!loading() && !props.snapshot.mcp.length && !props.snapshot.statuses.failed && !props.snapshot.configs.failed && props.snapshot.statuses.value !== null && props.snapshot.configs.value !== null}><Text testID="desktop-header-services-mcp-empty" class="px-4 py-5 text-muted-foreground" style={labelStyle}>{t('mcpDropdown.empty.configureInConfig')}</Text></If>
        <If when={!loading() && !props.snapshot.mcp.length && props.snapshot.statuses.value === null && !props.snapshot.statuses.failed}><Text class="px-4 py-5 text-muted-foreground" style={labelStyle}>{t('common.unavailable')}</Text></If>
      </View></View>
    </Scroll>
  </View>;
}

const statusKeys: Record<string, I18nKey> = { ok: 'desktopHostSwitcher.status.connected', auth: 'desktopHostSwitcher.status.authRequired', checking: 'desktopHostSwitcher.status.checking', incompatible: 'desktopHostSwitcher.status.incompatible', 'wrong-service': 'desktopHostSwitcher.status.wrongService', unreachable: 'desktopHostSwitcher.status.unreachable', 'update-recommended': 'desktopHostSwitcher.status.updateRecommended' };
function hostStatus(row: DesktopHeaderInstance) {
  const phase = row.transport === 'ssh' && !row.display.isActive ? row.display.sshPhase : undefined;
  const phaseKeys: Record<string, I18nKey> = { idle: 'desktopHostSwitcher.sshPhase.idle', ready: 'desktopHostSwitcher.sshPhase.ready', error: 'desktopHostSwitcher.sshPhase.error', auth_check: 'desktopHostSwitcher.sshPhase.checkingAuth', remote_probe: 'desktopHostSwitcher.sshPhase.probingRemote', installing: 'desktopHostSwitcher.sshPhase.installing', updating: 'desktopHostSwitcher.sshPhase.updating', server_detecting: 'desktopHostSwitcher.sshPhase.detectingServer', forwarding: 'desktopHostSwitcher.sshPhase.forwardingPorts', reconnecting: 'desktopHostSwitcher.sshPhase.reconnecting', checked: 'desktopHostSwitcher.sshPhase.probingRemote' };
  return t(phase && phaseKeys[phase] || statusKeys[desktopHeaderInstanceDisplay(row).statusKind || ''] || 'desktopHostSwitcher.status.unknown');
}
function hostStatusColor(row: DesktopHeaderInstance) {
  const status = desktopHeaderInstanceDisplay(row).statusKind;
  const colors = (colorScheme() === 'dark' ? dark : light).colors;
  return status === 'auth' || status === 'update-recommended' ? colors.status.warning : ['unreachable', 'incompatible', 'wrong-service'].includes(status || '') ? colors.status.error : String(token('muted-foreground'));
}
export function NativeDesktopHeaderInstance(props: Props) {
  const interactive = () => props.snapshot.active && props.snapshot.tab === 'instance';
  const update = () => props.snapshot.update.value;
  // Owner is intentionally pure/non-reactive; subscribe to its retained signal
  // projection before asking event-time capability gates.
  const instanceAvailable = (name: DesktopHeaderInstanceAction, id?: string) => props.snapshot.active && props.owner.instanceAvailable(name, id);
  const updateAvailable = () => props.snapshot.active && props.owner.updateAvailable();
  const version = () => desktopHeaderInstanceVersion(update()) || t('common.unavailable');
  function rowAction(row: DesktopHeaderInstance, actionName: DesktopHeaderInstanceAction, label: string, icon: Parameters<typeof Icon>[0]['name']) {
    const available = () => instanceAvailable(actionName, row.id);
    return <Button testID={`desktop-header-services-instance-${actionName}-${row.id}`} accessibilityLabel={label} selected={actionName === 'default' && row.isDefault} disabled={!available()} class={quiet + (actionName === 'default' && row.isDefault ? ' bg-accent' : '')}
      style={{ width: 32, height: 32 }} tooltip={<Hint text={available() ? label : `${label} · ${t('common.unavailable')}`} />} onPress={() => { void props.owner.runInstance(actionName, row.id); }}><Icon name={icon} size={16} /></Button>;
  }
  return <View testID="desktop-header-services-instance">
    <View class="flex-row items-center gap-3 px-4 py-2.5 border-b border-border">
      <Text class="flex-1 text-foreground" style={{ ...labelStyle, fontWeight: '500' }}>Yuri</Text>
      <Text testID="desktop-header-services-instance-version" class="text-foreground font-mono" style={labelStyle}>{version()}</Text>
      <If when={!!update()?.hostUpdate.value?.plan}><View accessibilityLabel={t('settings.yuri.about.hostUpdate.available')} class="bg-destructive rounded-full" style={{ width: 6, height: 6 }} /></If>
      <Button testID="desktop-header-services-instance-refresh" class={quiet} style={{ width: 28, height: 28 }} disabled={!interactive() || props.snapshot.update.loading || props.snapshot.instances.loading} accessibilityLabel={t('settings.yuri.about.hostUpdate.title')} onPress={() => { void props.owner.refreshInstance(); }}><Icon name="refresh" size={16} /></Button>
    </View>
    <If when={props.snapshot.update.failed || props.snapshot.instances.failed}>{feedback(() => { void props.owner.refreshInstance(); }, !interactive() || props.snapshot.update.loading || props.snapshot.instances.loading)}</If>
    <If when={props.snapshot.instances.stale && props.snapshot.instances.value !== null || props.snapshot.update.stale && props.snapshot.update.value !== null}>{stale()}</If>
    <If when={props.snapshot.instances.loading}><Text class="px-4 py-2 text-sm text-muted-foreground">{t('desktopHostSwitcher.state.loading')}</Text></If>
    <If when={!props.snapshot.instances.loading && props.snapshot.instances.value === null && !props.snapshot.instances.failed}><Text class="px-4 py-2 text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
    <View class="gap-1.5 px-3 py-1">
      <Each of={props.snapshot.instances.value || []} key={row => row.id}>{row => <View testID={`desktop-header-services-instance-row-${row().id}`} class={`flex-row items-center gap-2 px-3 py-3 rounded-xl ${row().display.isActive ? 'bg-accent' : ''}`}>
        <Button testID={`desktop-header-services-instance-switch-${row().id}`} selected={row().display.isActive} accessibilityLabel={t('desktopHostSwitcher.actions.switchToAria', { instance: row().label })} disabled={!instanceAvailable('switch', row().id)} class="flex-row flex-1 min-w-0 items-center gap-2 rounded-md hover:bg-secondary focus:border focus:border-ring disabled:opacity-50" onPress={() => { void props.owner.runInstance('switch', row().id); }}>
          <Icon name={row().transport === 'unknown' ? 'stack' : row().transport === 'local' ? 'connection-local' : row().transport === 'ssh' ? 'connection-ssh' : desktopHeaderInstanceDisplay(row()).showViaRelay || row().transport === 'relay' ? 'connection-relay' : 'connection-lan'} size={32} color={String(token('muted-foreground'))} />
          <View class="flex-1 min-w-0"><Text class="text-foreground" style={{ ...labelStyle, fontWeight: '500', numberOfLines: 1 }}>{row().label}</Text>
            <View class="flex-row items-center gap-2"><Text class="text-muted-foreground" style={metaStyle}>{row().transport === 'unknown' ? t('desktopHostSwitcher.status.unknown') : row().transport === 'local' ? t('desktopHostSwitcher.instance.local') : row().transport === 'ssh' ? 'SSH' : desktopHeaderInstanceDisplay(row()).showViaRelay || row().transport === 'relay' ? 'Relay' : 'LAN'}</Text>
              <If when={desktopHeaderInstanceDisplay(row()).latencyMs !== null}><Text class="text-muted-foreground" style={metaStyle}>{desktopHeaderInstanceDisplay(row()).latencyMs} ms</Text></If>
              <If when={desktopHeaderInstanceDisplay(row()).statusKind !== 'ok'}><Text style={{ ...metaStyle, color: hostStatusColor(row()), numberOfLines: 1 }}>{hostStatus(row())}</Text></If>
            </View>
          </View>
        </Button>
        <If when={row().display.isActive}><Icon name="check" size={16} /></If>
        <If when={row().transport === 'ssh' && (!row().display.sshPhase || row().display.sshPhase === 'idle')}>
          <Button testID={`desktop-header-services-instance-connect-${row().id}`} class={action} disabled={!instanceAvailable('connect', row().id)} onPress={() => { void props.owner.runInstance('connect', row().id); }}><Text class="text-foreground" style={metaStyle}>{t('desktopHostSwitcher.actions.connect')}</Text></Button>
        </If>
        {rowAction(row(), 'default', t(row().isDefault ? 'desktopHostSwitcher.actions.defaultInstanceAria' : 'desktopHostSwitcher.actions.setAsDefaultAria'), row().isDefault ? 'home-fill' : 'home')}
        {rowAction(row(), 'new-window', t('desktopHostSwitcher.actions.openInNewWindowAria'), 'window')}
      </View>}</Each>
    </View>
    <If when={!!update()?.hostUpdate.value?.plan || !!update()?.hostUpdate.value?.task || !!update()?.updateUncertain}>
      <View class="gap-2 px-4 py-2">
        <Text class="text-muted-foreground" style={metaStyle}>{update()?.hostUpdate.value?.plan?.version || update()?.hostUpdate.value?.task?.version}</Text>
        <If when={!!update()?.hostUpdate.value?.task}><Progress testID="desktop-header-services-update-progress" value={update()?.hostUpdate.value?.task?.progress ?? undefined} indeterminate={update()?.hostUpdate.value?.task?.progress == null} accessibilityLabel={t('updateDialog.header.updating')} trackClass="h-1.5 bg-border rounded-full" indicatorClass="h-1.5 bg-ring rounded-full" /></If>
        <Button testID="desktop-header-services-update" class={action} disabled={!updateAvailable()} onPress={() => { void props.owner.runUpdate(); }}><Text class="text-foreground" style={labelStyle}>{t('settings.yuri.about.hostUpdate.title')}</Text></Button>
        <If when={!updateAvailable()}><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></If>
      </View>
    </If>
    <If when={update()?.hostUpdate.value?.supported === false}><Text class="px-4 py-2 text-xs text-muted-foreground">{t('settings.yuri.about.hostUpdate.unsupported')}</Text></If>
    <If when={!!update()?.updateFailed || !!update()?.hostUpdate.value?.checkFailed}><Text class="px-4 py-2 text-xs text-destructive">{t('updateDialog.error.updateFailed')}</Text></If>
    <If when={props.snapshot.instanceResult && props.snapshot.instanceResult !== 'accepted'}><Text class="px-4 py-2 text-xs text-destructive">{t(props.snapshot.instanceResult === 'unsupported' ? 'common.unavailable' : 'mcpDropdown.status.unknownError')}</Text></If>
    <View class="border-t border-border px-3 py-1"><Button testID="desktop-header-services-instance-add" class={quiet + ' flex-row gap-2 px-3 py-3'} disabled={!instanceAvailable('add')} onPress={() => { void props.owner.runInstance('add'); }}><Icon name="add" size={16} /><Text class="text-muted-foreground" style={labelStyle}>{t('desktopHostSwitcher.actions.addInstance')}</Text></Button></View>
  </View>;
}

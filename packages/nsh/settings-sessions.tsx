import { cleanup, effect, lifecycle, locale, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { language, t } from './i18n';
import { nativeAppearance } from './appearance';
import { native } from './runtime';
import { SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, type SettingsOperation } from './settings-controls';
import { createSettingsSessions, type NativePasskeyRegistration, type SessionsState } from './settings-sessions-core';
import { SettingsTarget } from './settings-target';
import { passkeyManagementLabels } from './settings-passkey-native';

export function SettingsSessions(props: { operation: () => SettingsOperation | null; active: () => boolean; target?: string; onReveal?: (node: ViewRef) => void; passkeys?: NativePasskeyRegistration }) {
  const snapshot = signal<SessionsState>({ settings: null, browsers: null, passkeys: null, enabled: null, registering: false });
  const path = signal(''), edited = signal(false), busy = signal(''), errors = signal<Record<string, boolean>>({});
  let viewGeneration = 0;
  let busyFlight: object | null = null;
  const current = () => props.active() && lifecycle() === 'active' && props.operation()?.current() === true;
  function timestamp(value: number | null) {
    if (!value || !Number.isFinite(value)) return t('settings.yuri.passkeys.time.neverUsed');
    const preference = nativeAppearance.current()?.timeFormatPreference;
    return new Intl.DateTimeFormat(language() === 'system' ? locale() : language(), { dateStyle: 'medium', timeStyle: 'short', hour12: preference === '12h' ? true : preference === '24h' ? false : undefined }).format(value);
  }
  const bridge: NativePasskeyRegistration = props.passkeys ?? {
    authorizeManagement: async () => { await native('passkey.authorizeManagement', { expectedHost: props.operation()?.scope, labels: passkeyManagementLabels(t) }); },
    register: async input => {
      const result = await native('passkey.register', { ...input, expectedHost: props.operation()?.scope });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('passkey-response-invalid');
      return result as Record<string, unknown>;
    },
    cancel: async ceremonyID => { await native('passkey.cancel', { ceremonyID }); },
    authReset: async () => { await native('passkey.authReset', { expectedHost: props.operation()?.scope }); },
  };
  const owner = createSettingsSessions({ current, capture: props.operation, native: bridge, send: (path, method, body) => {
    const operation = props.operation();
    if (!operation?.current()) return Promise.reject(new Error('settings_operation_stale'));
    return operation.request(path, method, body);
  }, changed: value => { snapshot.set(value); if (!edited() && value.settings) path.set(typeof value.settings.opencodeBinary === 'string' ? value.settings.opencodeBinary : ''); } });
  async function run(resource: string, work: () => Promise<unknown>) {
    if (!current() || busy()) return;
    const ticket = viewGeneration;
    const flight = {}; busyFlight = flight;
    busy.set(resource); errors.set({ ...errors(), [resource]: false });
    try { await work(); } catch { if (busyFlight === flight && ticket === viewGeneration && current()) errors.set({ ...errors(), [resource]: true }); }
    finally { if (busyFlight === flight && ticket === viewGeneration) { busyFlight = null; busy.set(''); } }
  }
  async function cancelRegistration() {
    const ticket = viewGeneration;
    busyFlight = null; busy.set('');
    try { await owner.cancel(); } catch { if (ticket === viewGeneration && current()) errors.set({ ...errors(), passkeys: true }); }
  }
  async function load() {
    const ticket = viewGeneration;
    await Promise.allSettled((['cli', 'browser', 'passkeys'] as const).map(async resource => {
      try { await ({ cli: owner.settings, browser: owner.browsers, passkeys: owner.passkeys }[resource])(); if (ticket === viewGeneration && current()) errors.set({ ...errors(), [resource]: false }); }
      catch { if (ticket === viewGeneration && current()) errors.set({ ...errors(), [resource]: true }); }
    }));
  }
  effect(() => { const active = current(), operation = props.operation(); untracked(() => { const ticket = ++viewGeneration; busyFlight = null; busy.set(''); void owner.invalidate().then(() => { if (ticket === viewGeneration && active && operation) void load(); }, () => { if (ticket === viewGeneration && active) errors.set({ ...errors(), passkeys: true }); }); }); });
  cleanup(() => { viewGeneration++; void owner.invalidate().catch(() => {}); });
  return <View class="gap-5">
    <SettingsTarget id="sessions.opencode-binary" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.yuri.opencodeCli.title')}>
      <SettingsInput testID="settings-sessions-cli-path" title={t('settings.yuri.opencodeCli.field.binaryPath')} value={path()} disabled={!!busy() || !snapshot().settings} onChange={value => { path.set(value); edited.set(true); }} />
      <Button testID="settings-sessions-cli-save" class={settingsAction} disabled={!!busy() || !snapshot().settings} onPress={() => { void run('cli', async () => { await owner.saveCli(path()); edited.set(false); }); }}><Text class="text-foreground">{t('settings.yuri.opencodeCli.actions.saveAndReload')}</Text></Button>
    </SettingsGroup></SettingsTarget>
    <SettingsTarget id="sessions.opencode-update-notifications" target={props.target} onReveal={props.onReveal}><SettingsToggle testID="settings-sessions-update-notifications" title={t('settings.yuri.opencodeCli.field.showUpdateNotifications')} value={snapshot().settings?.showOpenCodeUpdateNotifications !== false} disabled={!!busy() || !snapshot().settings} onChange={value => { void run('cli', () => owner.notifications(value)); }} /></SettingsTarget>
    <If when={!!snapshot().browsers?.providers.length}><SettingsTarget id="sessions.browser-provider" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.yuri.browserProvider.label')}><Text class="text-xs text-muted-foreground">{t('settings.yuri.browserProvider.info')}</Text><SettingsChoice testID="settings-sessions-browser" title={t('settings.yuri.browserProvider.label')} value={snapshot().browsers?.selectedId ?? ''} items={(snapshot().browsers?.providers ?? []).map(row => ({ value: row.id, title: row.name }))} disabled={!!busy()} onChange={id => { void run('browser', () => owner.selectBrowser(id)); }} /></SettingsGroup></SettingsTarget></If>
    <SettingsTarget id="sessions.passkeys" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.yuri.passkeys.title')}>
      <If when={snapshot().enabled === false}><Text class="text-muted-foreground">{t('settings.yuri.passkeys.state.uiPasswordRequired')}</Text></If>
      <Button testID="settings-sessions-passkey-add" class={settingsAction} disabled={snapshot().enabled !== true || (!!busy() && !snapshot().registering)} onPress={() => { if (snapshot().registering) void cancelRegistration(); else void run('passkeys', owner.register); }}><Text class="text-foreground">{t(snapshot().registering ? 'settings.yuri.passkeys.actions.cancelSetup' : 'settings.yuri.passkeys.actions.add')}</Text></Button>
      <If when={snapshot().passkeys?.length === 0}><Text class="text-muted-foreground">{t('settings.yuri.passkeys.state.noneSaved')}</Text></If>
      <Each of={snapshot().passkeys ?? []}>{row => <View class="gap-2"><Text class="text-foreground">{row().label}</Text><Text class="text-xs text-muted-foreground">{row().lastUsedAt ? t('settings.yuri.passkeys.item.lastUsed', { time: timestamp(row().lastUsedAt) }) : t('settings.yuri.passkeys.item.added', { time: timestamp(row().createdAt) })}</Text><Button testID={`settings-sessions-passkey-delete-${row().id}`} class={settingsAction} disabled={!!busy()} onPress={() => { void run('passkeys', () => owner.removePasskey(row().id)); }}><Text class="text-foreground">{t('settings.common.actions.delete')}</Text></Button></View>}</Each>
      <Button testID="settings-sessions-auth-reset" class={settingsAction} disabled={!!busy() || snapshot().enabled === null} onPress={() => { void run('passkeys', async () => { const result = await AlertDialog.show({ title: t('settings.yuri.passkeys.actions.signOutEverywhere'), actions: [{ id: 'cancel', role: 'cancel', label: t('settings.common.actions.cancel') }, { id: 'reset', role: 'destructive', label: t('settings.yuri.passkeys.actions.signOutEverywhere') }] }); if (result.action === 'reset' && current()) await owner.resetAuth(); }); }}><Text class="text-foreground">{t('settings.yuri.passkeys.actions.signOutEverywhere')}</Text></Button>
    </SettingsGroup></SettingsTarget>
    <Each of={Object.keys(errors()).filter(key => errors()[key])}>{resource => <View class="gap-2"><Text class="text-destructive">{t('common.unavailable')}</Text><Button testID={`settings-sessions-retry-${resource()}`} class={settingsAction} disabled={!!busy()} onPress={() => { if (resource() === 'passkeys') void run('passkeys', owner.retryPasskeys); else void load(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></View>}</Each>
  </View>;
}

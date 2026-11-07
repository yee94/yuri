import { cleanup, effect, lifecycle, openUrl, Scroll, signal, Text, untracked, View, type ScrollRef } from 'nsh';
import { AlertDialog, Button, Progress } from 'nsh/base';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { bindRawRequest, native } from './runtime';
import { app } from './state';
import { SettingsGroup, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { aboutReadResponse, aboutSubmitResponse, aboutUpdateActive, createSettingsAbout, type AboutState, type AboutDependencies } from './settings-about-core';
import { aboutDiagnosticsCall } from './settings-about-diagnostics';

/** Main owns route registration. No request, event or timer is added to the root. */
export function SettingsAbout(props: { target?: string; active?: boolean; dependencies?: Omit<AboutDependencies, 'changed'> }) {
  const lifetime = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active');
  let authority: object | null = null;
  const dependencies = (op: SettingsOperation | null): AboutDependencies => {
    const token = {}; authority = token;
    const send = bindRawRequest(op?.scope ?? null);
    const current = () => authority === token && op?.current() === true;
    const raw: typeof send = async (path, method, body) => {
      if (!current()) throw new Error('settings_operation_stale');
      const result = await send(path, method, body);
      if (!current()) throw new Error('settings_operation_stale');
      return result;
    };
    return { current, hostID: op?.scope?.hostID ?? null,
      read: async path => aboutReadResponse(path, await raw(path)),
      submitUpdate: async body => aboutSubmitResponse(await raw('/api/system/update', 'POST', body)),
      call: (name, body) => aboutDiagnosticsCall(async (method, input) => {
        if (!current()) throw new Error('settings_operation_stale');
        const result = await native(method, input);
        if (!current()) throw new Error('settings_operation_stale');
        return result;
      }, name, body),
    };
  };
  const pageCurrent = () => lifetime.current() && props.active !== false;
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, lifetime.current);
  const controller = createSettingsAbout({
    ...(props.dependencies ?? dependencies(lifetime.operation())), changed: next => state.set(next),
  });
  const state = signal<AboutState>(controller.state());
  cleanup(() => controller.dispose());
  let assigned = lifetime.operation(), loaded = false;
  effect(() => {
    const op = lifetime.current() ? lifetime.operation() : null;
    untracked(() => {
      if (!props.dependencies && assigned !== op) {
        assigned = op; loaded = false; controller.replaceLane({ ...dependencies(op), changed: next => state.set(next) });
      }
      if (props.active === false || !op?.current() || loaded) return;
      loaded = true; void controller.refresh();
    });
  });
  effect(() => {
    const visible = props.active !== false && lifecycle() === 'active';
    const op = lifetime.operation();
    const watching = aboutUpdateActive(state().hostUpdate.value) || state().updateUncertain;
    if (!visible || !watching) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(() => {
        if (stopped || !op?.current()) return;
        void controller.reconcileUpdate().finally(() => { if (!stopped && op.current()) poll(); });
      }, 2_000);
    };
    untracked(poll);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  });
  async function update() {
    const op = lifetime.operation();
    const token = authority;
    const current = () => authority === token && op?.current() === true;
    if (!op?.current()) return;
    await controller.prepareUpdate();
    const confirmation = controller.state().updateConfirm;
    if (!confirmation?.plan || !current() || !pageCurrent()) return;
    const plan = confirmation.plan;
    try {
      const answer = await AlertDialog.show({ title: t('settings.yuri.about.hostUpdate.title'),
        description: [t('settings.yuri.about.hostUpdate.description'), plan.version, confirmation.channel,
          t(`settings.yuri.about.hostUpdate.kind.${plan.kind}`), plan.rollback ? t('settings.yuri.about.hostUpdate.downgrade') : ''].filter(Boolean).join('\n'),
        actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'confirm', label: t('settings.yuri.about.hostUpdate.confirm') }] });
      if (!current()) return;
      if (answer.action === 'confirm' && pageCurrent()) await controller.confirmUpdate();
      else controller.cancelUpdate();
    } catch { if (current()) controller.cancelUpdate(); }
  }
  const unknown = () => t('settings.yuri.about.state.unknown');
  const clientLabel = () => {
    const client = state().client.value;
    return client?.version ? client.build ? `${client.version} (${client.build})` : client.version : unknown();
  };
  const managementLabel = () => {
    const value = state().opencode.value;
    const version = value?.version ?? unknown();
    return value?.canManage === false && value.management
      ? t('settings.yuri.about.opencodeVersionWithManagement', { version, management: t(`settings.yuri.about.opencodeManagement.${value.management}`) }) : version;
  };
  const guidance = (): I18nKey | null => {
    const value = state().opencode.value;
    if (value?.canManage !== false) return null;
    return value.management === 'manual-global' ? 'settings.yuri.about.opencodeGuidance.manualGlobal'
      : value.management === 'manual-external' ? 'settings.yuri.about.opencodeGuidance.manualExternal'
      : value.management === 'bundled' ? 'settings.yuri.about.opencodeGuidance.bundled' : null;
  };
  const updateLabel = () => {
    const resource = state().hostUpdate, value = resource.value;
    if (resource.refreshing) return t('settings.yuri.about.state.checking');
    if (resource.status === 'failed' || value?.checkFailed) return t('settings.yuri.about.toast.checkFailed');
    if (!value) return unknown();
    if (value.operation) return t(`settings.yuri.about.hostUpdate.status.${value.operation}`);
    if (!value.supported) return t('settings.yuri.about.hostUpdate.unsupported');
    if (value.availableVersion) return `${t('settings.yuri.about.hostUpdate.available')} · ${value.availableVersion}`;
    return value.currentVersion && value.available === false ? t('settings.yuri.about.state.upToDate') : unknown();
  };
  const failedVersion = () => (['client', 'host', 'opencode', 'diagnostics'] as const).some(key => state()[key].status === 'failed');
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10">
    <View class="items-center gap-3"><Text class="text-2xl font-semibold text-foreground">Yuri</Text></View>
    <SettingsGroup title={t('settings.page.about.title')}>
      <View class="gap-1"><Text class="text-sm text-muted-foreground">{t('settings.yuri.about.field.clientVersion')}</Text><Text testID="about-client-version" class="text-sm font-mono text-foreground">{clientLabel()}</Text></View>
      <View class="gap-1"><Text class="text-sm text-muted-foreground">{t('settings.yuri.about.field.instanceYuriVersion')}</Text><Text testID="about-host-version" class="text-sm font-mono text-foreground">{state().host.value?.version ?? unknown()}</Text></View>
      <View class="gap-1"><Text class="text-sm text-muted-foreground">{t('settings.yuri.about.field.instanceOpenCodeVersion')}</Text><Text testID="about-opencode-version" class="text-sm font-mono text-foreground">{managementLabel()}</Text><If when={!!guidance()}><Text class="text-xs text-muted-foreground">{guidance() ? t(guidance()!) : ''}</Text></If></View>
      <If when={failedVersion()}><Text class="text-sm text-destructive">{t('settings.nsh.about.versionFailed')}</Text></If>
      <Button testID="about-refresh" class={settingsAction} disabled={props.active === false || Object.values({ client: state().client, host: state().host, opencode: state().opencode, diagnostics: state().diagnostics }).some(value => value.refreshing)} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('settings.usage.sidebar.actions.refreshTitle')}</Text></Button>
      <SettingsTarget id="about.feedback" target={props.target} onReveal={navigation.reveal}><Button class={settingsAction} onPress={() => { const op = lifetime.operation(), token = authority; const current = () => authority === token && op?.current() === true; if (!current()) return; void openUrl('https://github.com/yee94/yuri/issues/new').then(result => { if (!result.opened && current()) lifetime.error.set(t('settings.view.unavailable.description')); }).catch(() => { if (current()) lifetime.error.set(t('settings.view.unavailable.description')); }); }}><Text class="text-foreground">{t('settings.yuri.about.actions.submitFeedback')}</Text></Button></SettingsTarget>
      <If when={!!lifetime.error()}><Text class="text-destructive">{lifetime.error()}</Text></If>
    </SettingsGroup>
    <SettingsTarget id="about.host-update" target={props.target} onReveal={navigation.reveal}><SettingsGroup title={t('settings.yuri.about.hostUpdate.title')}>
      <Text testID="about-host-update-status" class="text-sm text-foreground">{updateLabel()}</Text>
      <Text class="text-xs text-muted-foreground">{t('settings.yuri.about.hostUpdate.description')}</Text>
      <If when={aboutUpdateActive(state().hostUpdate.value)}><Progress testID="about-host-progress" value={state().hostUpdate.value?.task?.progress ?? undefined} indeterminate={state().hostUpdate.value?.task?.progress == null} accessibilityLabel={updateLabel()} trackClass="h-1 overflow-hidden rounded-full bg-border" indicatorClass={state().hostUpdate.value?.task?.progress == null ? 'h-full w-1/3 rounded-full bg-foreground' : 'h-full rounded-full bg-foreground'} /></If>
      <If when={!!state().hostUpdate.value?.plan}><Text class="text-sm text-foreground">{state().hostUpdate.value?.plan?.version} · {state().hostUpdate.value?.channel} · {state().hostUpdate.value?.plan ? t(`settings.yuri.about.hostUpdate.kind.${state().hostUpdate.value!.plan!.kind}`) : ''}</Text><Text class="text-sm text-muted-foreground">{state().hostUpdate.value?.plan?.releaseNotes || t('settings.yuri.about.hostUpdate.noNotes')}</Text><If when={state().hostUpdate.value?.plan?.rollback}><Text class="text-sm text-destructive">{t('settings.yuri.about.hostUpdate.downgrade')}</Text></If></If>
      <If when={state().updateFailed}><Text testID="about-host-update-error" class="text-sm text-destructive">{t('settings.yuri.about.hostUpdate.status.failed')}</Text></If>
      <If when={state().updateUncertain || state().hostUpdate.status === 'failed' && aboutUpdateActive(state().hostUpdate.value)}><Text class="text-xs text-muted-foreground">{t('settings.yuri.about.hostUpdate.reconnecting')}</Text></If>
      <Button testID="about-host-check" class={settingsAction} disabled={state().hostUpdate.refreshing || state().updateBusy || props.active === false} onPress={() => { void controller.reconcileUpdate(); }}><Text class="text-foreground">{t(state().hostUpdate.refreshing ? 'settings.yuri.about.state.checking' : 'settings.yuri.about.actions.checkForUpdates')}</Text></Button>
      <If when={!aboutUpdateActive(state().hostUpdate.value) && (state().hostUpdate.value?.plan || state().hostUpdate.value?.operation === 'failed')}><Button testID="about-host-update" class={settingsAction} disabled={state().updateBusy || state().updateUncertain || !!state().updateConfirm || state().hostUpdate.refreshing || props.active === false} onPress={() => { void update(); }}><Text class="text-foreground">{t(state().hostUpdate.value?.operation === 'failed' ? 'settings.voice.volcengine.retry' : 'settings.yuri.about.hostUpdate.confirm')}</Text></Button></If>
    </SettingsGroup></SettingsTarget>
    <SettingsGroup title={t('settings.yuri.about.field.clientVersion')}>
      <SettingsTarget id="about.check-updates" target={props.target} onReveal={navigation.reveal}><Button testID="about-client-update" class={settingsAction} disabled={state().client.refreshing || props.active === false} onPress={() => { void controller.client(); }}><Text class="text-foreground">{t('settings.usage.sidebar.actions.refreshTitle')}</Text></Button></SettingsTarget>
      <SettingsTarget id="about.beta-updates" target={props.target} onReveal={navigation.reveal}><Text class="text-sm text-muted-foreground">{t('settings.yuri.about.betaUpdates.label')} · {unknown()}</Text></SettingsTarget>
      <Text testID="about-client-unsupported" class="text-sm text-muted-foreground">{t('settings.nsh.about.clientUnsupported')}</Text>
    </SettingsGroup>
    <SettingsGroup title={t('settings.yuri.about.diagnostics.label')}>
      <Text class="text-xs text-muted-foreground">{t('settings.yuri.about.diagnostics.description')}</Text>
      <SettingsTarget id="about.diagnostics" target={props.target} onReveal={navigation.reveal}><SettingsToggle testID="about-diagnostics-toggle" title={t('settings.yuri.about.diagnostics.label')} value={state().diagnostics.value?.enabled === true} disabled={state().diagnostics.status !== 'ready' || state().diagnostics.refreshing || state().diagnosticsBusy || state().exporting || props.active === false} onChange={enabled => { void controller.setDiagnostics(enabled); }} /></SettingsTarget>
      <If when={state().diagnosticsFailed}><Text class="text-sm text-destructive">{t('settings.nsh.about.preferenceFailed')}</Text></If>
      <If when={state().diagnostics.value?.enabled === true || props.target === 'about.export-diagnostics'}><SettingsTarget id="about.export-diagnostics" target={props.target} onReveal={navigation.reveal}><Button testID="about-export" class={settingsAction} disabled={state().exporting || state().diagnosticsBusy || state().diagnostics.value?.enabled !== true || !(props.dependencies?.hostID ?? app.connection()?.id) || props.active === false} onPress={() => { void controller.exportDiagnostics(); }}><Text class="text-foreground">{t(state().exporting ? 'settings.yuri.about.diagnostics.exporting' : 'settings.yuri.about.diagnostics.export')}</Text></Button></SettingsTarget></If>
      <If when={state().exportOutcome === 'failed'}><Text testID="about-export-error" class="text-sm text-destructive">{t('settings.yuri.about.diagnostics.toast.failed')}</Text></If>
      <If when={state().exportOutcome === 'shared'}><Text testID="about-export-success" class="text-sm text-muted-foreground">{t(state().exportEventCount === 0 ? 'settings.yuri.about.diagnostics.toast.empty' : 'settings.yuri.about.diagnostics.toast.exported')}</Text></If>
    </SettingsGroup>
  </Scroll>;
}

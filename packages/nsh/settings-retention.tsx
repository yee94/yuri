import { cleanup, effect, signal, Storage, Text, untracked, View, type ViewRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import { SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createRetentionController, type RetentionController, type RetentionPreferences, type RetentionResult, type RetentionStorage } from './settings-retention-controller';
import { createRetentionScheduler } from './settings-retention-scheduler';
import type { RetentionAction, RetentionRequest } from './settings-retention-core';
import { RETENTION_DEFAULT_DAYS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from '../ui/src/lib/session-retention-policy';
import { publishSettingsEditor } from './desktop-settings-publisher';

const nativeOwners = new Map<string, () => boolean>();

/** Call once in the captured Host root. Only this owner may opt into automatic cleanup. */
export function createNativeRetentionOwner(options: { scope: string; current: () => boolean; active: () => boolean; protectedIDs: () => ReadonlySet<string>; autoRun?: boolean; send?: RetentionRequest; storage?: RetentionStorage; now?: () => number }) {
  if (nativeOwners.get(options.scope)?.()) throw new Error('Retention Host root already owned');
  let alive = true;
  const lifetime = settingsPageLifetime();
  const operation = lifetime.operation();
  const current = () => alive && (options.send ? options.current() : lifetime.current());
  const send = options.send ?? operation?.request ?? (async () => { throw new Error('Runtime changed'); });
  nativeOwners.set(options.scope, current);
  const controller = createRetentionController({ ...options, send, storage: options.storage ?? Storage, current: options.send ? current : operation?.current ?? (() => false), available: options.send ? options.active : lifetime.current });
  lifetime.observeOperation(next => { if (!options.send) { controller.replaceLane(next); if (next) { if (controller.snapshot().ready) void controller.resume(); else void controller.load(); } } });
  const scheduler = options.autoRun === true ? createRetentionScheduler(controller, { now: options.now ?? Date.now, set: (delay, run) => setTimeout(run, delay), clear: timer => clearTimeout(timer) }) : null;
  effect(() => {
    const active = options.send ? options.active() : lifetime.current();
    untracked(() => {
      scheduler?.update(active);
      if (active && !controller.snapshot().ready) void controller.load();
    });
  });
  cleanup(() => { alive = false; scheduler?.dispose(); if (nativeOwners.get(options.scope) === current) nativeOwners.delete(options.scope); });
  return controller;
}

/** Section only: main keeps Defaults, deletion confirmation and small-model fields in the existing Sessions page. */
export function SettingsSessionRetentionSection(props: { controller: RetentionController; active: boolean; target?: string; onReveal?: (node: ViewRef) => void }) {
  const controller = props.controller, state = signal(controller.snapshot());
  const dirty = signal(false), enabled = signal(false), days = signal(String(RETENTION_DEFAULT_DAYS)), action = signal<RetentionAction>('archive');
  const formError = signal(false), confirming = signal(false);
  let assigned = controller.captureLane();
  const syncDraft = () => {
    const nextLane = controller.captureLane();
    if (nextLane !== assigned) { assigned = nextLane; confirming.set(false); }
    const next = controller.snapshot(); state.set(next);
    if (!dirty()) { enabled.set(next.preferences.autoDeleteEnabled); days.set(String(next.preferences.autoDeleteAfterDays)); action.set(next.preferences.sessionRetentionAction); }
  };
  cleanup(controller.subscribe(syncDraft)); syncDraft();
  async function refresh() {
    const operation = controller.captureLane();
    if (!operation?.current()) return;
    if (!controller.snapshot().ready) await controller.load();
    if (operation.current() && props.active && controller.snapshot().ready) await controller.scan();
  }
  effect(() => { const active = props.active; untracked(() => { if (active) void refresh(); else controller.cancel(); }); });
  const disabled = () => !props.active || state().busy || confirming();
  const controlsDisabled = () => disabled() || !state().ready;
  publishSettingsEditor({ current: () => props.active && controller.captureLane()?.current() === true, scope: controller.captureLane,
    pending: () => state().busy || confirming(), dirty: () => dirty() && (enabled() !== state().preferences.autoDeleteEnabled || days() !== String(state().preferences.autoDeleteAfterDays) || action() !== state().preferences.sessionRetentionAction),
    stamp: () => [enabled(), days(), action()],
  });
  const admissionBlocked = () => state().admission === 'server-atomic-required';
  const edit = () => { dirty.set(true); formError.set(false); controller.cancel(); };
  async function save() {
    const operation = controller.captureLane();
    if (!operation?.current()) return;
    const number = Number(days());
    if (!days().trim() || !Number.isFinite(number) || number < RETENTION_MIN_DAYS || number > RETENTION_MAX_DAYS) { formError.set(true); return; }
    const preferences: RetentionPreferences = { autoDeleteEnabled: enabled(), autoDeleteAfterDays: number, sessionRetentionAction: action() };
    await controller.save(preferences);
    if (operation.current() && controller.snapshot().preferences.autoDeleteAfterDays === number && controller.snapshot().preferences.sessionRetentionAction === action() && controller.snapshot().preferences.autoDeleteEnabled === enabled()) dirty.set(false);
  }
  async function confirmAction(selected: RetentionAction, count: number, operation: NonNullable<ReturnType<RetentionController['captureLane']>>) {
    const result = await AlertDialog.show({
      title: t('settings.yuri.sessionRetention.manualCleanup.title'), description: t(selected === 'archive' ? 'settings.yuri.sessionRetention.confirm.archive' : 'settings.yuri.sessionRetention.confirm.delete', { count }),
      actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'clean', label: t(selected === 'archive' ? 'settings.yuri.sessionRetention.action.archive' : 'settings.yuri.sessionRetention.action.delete'), role: selected === 'delete' ? 'destructive' : 'default' }],
    });
    return result.action === 'clean' && props.active && operation.current();
  }
  async function run() {
    const operation = controller.captureLane();
    if (!operation?.current()) return;
    if (disabled() || dirty() || admissionBlocked()) return;
    confirming.set(true);
    try {
      const plan = await controller.prepare();
      if (!operation.current()) return;
      if (plan && plan.count > 0 && await confirmAction(plan.action, plan.count, operation)) { if (operation.current()) await controller.confirm(plan); }
      else if (operation.current()) controller.cancel();
    } finally { if (operation.current()) confirming.set(false); }
  }
  async function retry(item: RetentionResult) {
    const operation = controller.captureLane();
    if (!operation?.current()) return;
    if (disabled() || dirty() || item.status === 'failed' && admissionBlocked()) return;
    confirming.set(true);
    try { if ((item.status !== 'failed' || await confirmAction(item.action, 1, operation)) && operation.current()) await controller.retry(item.id); }
    finally { if (operation.current()) confirming.set(false); }
  }
  const errorText = () => {
    const error = state().error;
    return error ? t(`settings.yuri.sessionRetention.error.${error === 'host-preferences' ? 'hostPreferences' : error}`) : '';
  };
  const countText = () => state().count === null ? t('settings.yuri.sessionRetention.state.unknown') : t(state().preferences.sessionRetentionAction === 'archive' ? 'settings.yuri.sessionRetention.manualCleanup.eligibleArchiveNow' : 'settings.yuri.sessionRetention.manualCleanup.eligibleDeleteNow', { count: state().count ?? 0 });
  return <View class="gap-5">
    <SettingsGroup title={t('settings.yuri.sessionRetention.title')}>
      <Text class="text-xs text-muted-foreground">{t('settings.yuri.sessionRetention.description.safety')}</Text>
      <SettingsTarget id="sessions.autoDeleteEnabled" target={props.target} onReveal={props.onReveal}><SettingsToggle testID="retention-enabled" title={t('settings.yuri.sessionRetention.field.enableAutoCleanup')} value={enabled()} disabled={controlsDisabled()} onChange={value => { edit(); enabled.set(value); }} /></SettingsTarget>
      <SettingsTarget id="sessions.autoDeleteAfterDays" target={props.target} onReveal={props.onReveal}>
        <SettingsInput testID="retention-days" title={t('settings.yuri.sessionRetention.field.retentionPeriodAria')} value={days()} disabled={controlsDisabled()} onChange={value => { edit(); days.set(value); }} />
        <Button testID="retention-reset" class={settingsAction} disabled={controlsDisabled()} onPress={() => { edit(); days.set(String(RETENTION_DEFAULT_DAYS)); }}><Text class="text-foreground">{t('settings.yuri.sessionRetention.actions.resetRetentionAria')}</Text></Button>
      </SettingsTarget>
      <SettingsTarget id="sessions.sessionRetentionAction" target={props.target} onReveal={props.onReveal}><SettingsChoice testID="retention-action" title={t('settings.yuri.sessionRetention.field.whenSessionsExpire')} value={action()} items={[{ value: 'archive', title: t('settings.yuri.sessionRetention.action.archive') }, { value: 'delete', title: t('settings.yuri.sessionRetention.action.delete') }]} disabled={controlsDisabled()} onChange={value => { if (value === 'archive' || value === 'delete') { edit(); action.set(value); } }} /></SettingsTarget>
      <If when={formError()}><Text class="text-sm text-destructive">{t('settings.yuri.sessionRetention.error.invalidDays')}</Text></If>
      <Button testID="retention-save" class={settingsAction} disabled={controlsDisabled()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
      <If when={state().ready && !state().hostSynced}><Text testID="retention-unsynced" class="text-sm text-destructive">{t('settings.yuri.sessionRetention.state.unsynced')}</Text></If>
    </SettingsGroup>
    <SettingsTarget id="sessions.retention-cleanup" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.yuri.sessionRetention.manualCleanup.title')}>
      <Text testID="retention-count" class="text-sm text-muted-foreground">{countText()}</Text>
      <If when={!!state().error}><Text testID="retention-error" class="text-sm text-destructive">{errorText()}</Text></If>
      <Button testID="retention-refresh" class={settingsAction} disabled={disabled() || dirty()} onPress={() => { void refresh(); }}><Text class="text-foreground">{t('settings.yuri.sessionRetention.actions.scan')}</Text></Button>
      <Button testID="retention-run" class={settingsAction} disabled={controlsDisabled() || dirty() || state().count === null || admissionBlocked()} onPress={() => { void run(); }}><Text class="text-foreground">{t(state().busy ? 'settings.yuri.sessionRetention.actions.cleaningUp' : 'settings.yuri.sessionRetention.actions.runCleanupNow')}</Text></Button>
      <Each of={state().results}>{item => <View testID={`retention-result-${item().id}`} class="gap-2">
        <Text class="text-sm text-foreground">{item().id}</Text>
        <Text class="text-xs text-muted-foreground">{t(item().action === 'archive' ? 'settings.yuri.sessionRetention.action.archive' : 'settings.yuri.sessionRetention.action.delete')}</Text>
        <Text class={item().status === 'failed' || item().status === 'uncertain' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{t(`settings.yuri.sessionRetention.result.${item().status}`)}</Text>
        <If when={item().status === 'failed' || item().status === 'uncertain' || item().status === 'ack'}><Button testID={`retention-retry-${item().id}`} class={settingsAction} disabled={disabled() || dirty() || item().status === 'failed' && admissionBlocked()} onPress={() => { void retry(item()); }}><Text class="text-foreground">{item().status === 'failed' ? t('settings.voice.volcengine.retry') : t('settings.yuri.sessionRetention.actions.verify')}</Text></Button></If>
      </View>}</Each>
    </SettingsGroup></SettingsTarget>
  </View>;
}

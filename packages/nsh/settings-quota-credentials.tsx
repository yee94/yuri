import { cleanup, effect, lifecycle, Scroll, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { bindRawRequest } from './runtime';
import { app, captureHostOperation, epoch } from './state';
import { SettingsGroup, SettingsInput, settingsAction, settingsOperationLifetime } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createQuotaCredentials, quotaCredentialFields, quotaCredentialResponse, type QuotaCredentialAction, type QuotaCredentialField, type QuotaCredentialProvider, type QuotaCredentialsDependencies, type QuotaCredentialsState } from './settings-quota-credentials-core';
import { publishSettingsEditor } from './desktop-settings-publisher';

export type SettingsQuotaCredentialsProps = {
  providerId: QuotaCredentialProvider; providerName: string; active: boolean;
  /** Directory fences the page lifetime, but is not appended to these Host-global routes. */
  directory?: string; target?: string;
  dependencies?: Pick<QuotaCredentialsDependencies, 'send' | 'current'>;
};
const fieldLabels: Record<QuotaCredentialField, I18nKey> = {
  workspaceId: 'settings.providers.page.openCodeGo.workspaceId', authCookie: 'settings.providers.page.openCodeGo.authCookie',
  cookie: 'settings.providers.page.openCodeGo.authCookie', accessToken: 'settings.providers.quota.accessToken', refreshToken: 'settings.providers.quota.refreshToken',
};
function quotaOwner(props: SettingsQuotaCredentialsProps, form: boolean) {
  const provider = props.providerId, directory = props.directory, mounted = app.connection();
  const identity = mounted && [mounted.id, mounted.url, mounted.authorizationID];
  let alive = true, retired = false;
  const lifetime = settingsOperationLifetime(null, () => props.active && lifecycle() === 'active');
  const current = () => alive && !retired && provider === props.providerId && directory === props.directory
    && (props.dependencies ? props.dependencies.current() : !!app.connection());
  const controller = createQuotaCredentials({ providerId: provider, current,
    send: props.dependencies?.send ?? (async () => { throw new Error('quota_operation_unavailable'); }),
    changed: next => state.set(next),
  });
  const state = signal<QuotaCredentialsState>(controller.state());
  const navigation = publishSettingsEditor({ current: () => current() && props.active, scope: lifetime.operation,
    pending: () => state().loading || !!state().busy || state().recovery === 'read-required',
    dirty: () => form && state().open && Object.entries(state().values).some(([key, value]) => key === 'workspaceId' ? value !== (state().status?.workspaceId ?? '') : !!value),
    stamp: () => [state().values],
  });
  async function refresh() {
    await controller.read();
    if (form && !controller.state().open && (!controller.state().notice || controller.state().notice === 'validate')) controller.open();
  }
  let wasActive = false;
  effect(() => {
    const connection = app.connection(); app.runtimeScope(); epoch();
    const confirmed = props.dependencies ? null : captureHostOperation();
    const admitted = props.dependencies ? props.dependencies.current() : confirmed?.current() === true;
    const enabled = props.active && lifecycle() === 'active';
    untracked(() => {
      if (connection && (!identity || connection.id !== identity[0] || connection.url !== identity[1] || connection.authorizationID !== identity[2])) retired = true;
      if (!current()) { controller.dispose(); lifetime.retireOperation(); wasActive = false; return; }
      if (!enabled || !admitted) {
        controller.setActive(false); wasActive = false;
        controller.replaceOperation(null); lifetime.retireOperation();
        return;
      }
      const previous = lifetime.operation();
      const renewed = !props.dependencies && confirmed && (!previous || previous.generation !== confirmed.generation || previous.scope?.hostID !== confirmed.scope?.hostID || previous.scope?.lease !== confirmed.scope?.lease);
      if (renewed) {
        const operation = lifetime.replaceOperation(confirmed);
        if (!operation) return;
        const raw = bindRawRequest(operation.scope);
        controller.replaceOperation({ current: operation.current, send: async (path, method = 'GET', body) => {
          if (!operation.current()) throw new Error('quota_operation_stale');
          const result = await raw(path, method, body);
          if (!operation.current()) throw new Error('quota_operation_stale');
          return quotaCredentialResponse(result);
        } });
      } else if (props.dependencies) controller.replaceOperation(props.dependencies);
      controller.setActive(true);
      if (!wasActive || renewed) void refresh();
      wasActive = true;
    });
  });
  cleanup(() => { alive = false; controller.dispose(); });
  return { controller, state, refresh, navigation };
}
function statusLabel(state: QuotaCredentialsState) {
  return t(state.error === 'load' ? 'settings.providers.quota.loadFailed' : state.loading || !state.status
    ? 'settings.providers.page.state.loading' : state.status.configured ? 'settings.providers.quota.configured' : 'settings.providers.quota.optional');
}

/** Provider-detail row only. Main owns navigation; no nested NavStack or credential modal. */
export function SettingsQuotaCredentials(props: SettingsQuotaCredentialsProps & { onManage: () => void; onReveal?: (node: ViewRef) => void }) {
  const { state, refresh } = quotaOwner(props, false);
  return <SettingsTarget id={`providers.${props.providerId}-credentials`} target={props.target} onReveal={props.onReveal}>
    <SettingsGroup title={t('settings.providers.quota.title')}>
      <Text testID={`quota-${props.providerId}-status`} class="text-sm text-muted-foreground">{statusLabel(state())}</Text>
      <Button testID={`quota-${props.providerId}-manage`} class={settingsAction} disabled={!props.active || state().loading || (!state().status && state().error !== 'load')}
        onPress={() => { if (state().error === 'load') void refresh(); else props.onManage(); }}>
        <Text class="text-foreground">{t(state().error === 'load' ? 'settings.providers.quota.retry' : 'settings.providers.quota.manage')}</Text>
      </Button>
    </SettingsGroup>
  </SettingsTarget>;
}

/** Owns exactly one NavPage. Mount directly in the existing native route stack. */
export function SettingsQuotaCredentialsPage(props: SettingsQuotaCredentialsProps & {
  onBack: () => void;
  onSaved?: (status: NonNullable<QuotaCredentialsState['status']>, action: 'save' | 'import' | 'delete') => void;
}) {
  const { controller, state, refresh, navigation } = quotaOwner(props, true);
  const blocked = () => !props.active || lifecycle() !== 'active' || !!state().busy || state().loading || !state().open
    || state().error === 'load' || state().recovery === 'read-required';
  const close = () => { void navigation.requestLeave().then(allowed => { if (allowed) { controller.close(); props.onBack(); } }); };
  async function perform(action: QuotaCredentialAction) {
    if (blocked()) return;
    const current = controller.captureOperation();
    await controller.act(action);
    if (!current()) return;
    const result = controller.state();
    if (action !== 'validate' && result.notice === action && !result.open && result.status) {
      props.onSaved?.(result.status, action); props.onBack();
    }
  }
  return <NavPage title={`${props.providerName} · ${t('settings.providers.quota.title')}`} headerBackTitle="" class="flex-1 bg-background" popOnBack={false} onBackPress={close}>
    <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
      <Text class="text-sm text-muted-foreground">{t('settings.providers.quota.description')}</Text>
      <Text testID="quota-form-status" class="text-sm text-muted-foreground">{statusLabel(state())}</Text>
      <If when={state().error !== null || state().recovery !== null}><Text testID="quota-form-error" class="text-sm text-destructive">{t(state().error === 'load' ? 'settings.providers.quota.loadFailed' : 'settings.providers.quota.failed')}</Text></If>
      <If when={state().error === 'load' || state().recovery !== null}>
        <Button testID="quota-form-read" class={settingsAction} disabled={state().loading || !!state().busy || !props.active} onPress={() => { void refresh(); }}><Text class="text-foreground">{t('settings.providers.quota.retry')}</Text></Button>
      </If>
      <If when={state().notice === 'validate'}><Text testID="quota-form-validated" class="text-sm text-muted-foreground">{t('settings.providers.quota.validated')}</Text></If>
      <If when={state().open}>
        <SettingsGroup title={t('settings.providers.quota.title')}>
          <Each of={quotaCredentialFields[props.providerId]}>{field => <SettingsInput testID={`quota-field-${field()}`} title={t(fieldLabels[field()])}
            value={state().values[field()] ?? ''} masked={field() !== 'workspaceId'} disabled={blocked()}
            onChange={value => controller.change(field(), value)} />}</Each>
        </SettingsGroup>
        <If when={props.providerId === 'opencode-go'}><Text class="text-xs text-muted-foreground">{t('settings.providers.page.openCodeGo.help')}</Text></If>
        <If when={props.providerId === 'cursor'}><Button testID="quota-form-import" class={settingsAction} disabled={blocked()} onPress={() => { void perform('import'); }}><Text class="text-foreground">{t('settings.providers.quota.importCursor')}</Text></Button></If>
        <If when={state().status?.configured === true}>
          <Button testID="quota-form-validate" class={settingsAction} disabled={blocked()} onPress={() => { void perform('validate'); }}><Text class="text-foreground">{t('settings.providers.page.openCodeGo.validate')}</Text></Button>
          <Button testID="quota-form-delete" class={settingsAction} disabled={blocked()} onPress={() => controller.confirmDelete(!state().confirmDelete)}><Text class="text-destructive">{t('settings.providers.page.openCodeGo.delete')}</Text></Button>
        </If>
        <If when={state().confirmDelete && state().status?.configured === true}>
          <View class="gap-3"><Text class="text-sm text-muted-foreground">{t('settings.providers.quota.deleteHint')}</Text>
            <Button testID="quota-form-delete-confirm" class={settingsAction} disabled={blocked()} onPress={() => { void perform('delete'); }}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button>
          </View>
        </If>
        <Button testID="quota-form-save" class={settingsAction} disabled={blocked()} onPress={() => { void perform('save'); }}><Text class="text-foreground">{t(state().busy === 'save' ? 'settings.providers.page.actions.saving' : 'settings.providers.page.openCodeGo.save')}</Text></Button>
      </If>
      <Button testID="quota-form-cancel" class={settingsAction} onPress={close}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
    </Scroll>
  </NavPage>;
}

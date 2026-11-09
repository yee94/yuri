import { cleanup, Clipboard, effect, lifecycle, openUrl, signal, Text, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import { record, text, type Row } from './model';
import { SettingsFeedback, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { integrationPayload, integrationSettingsPath, settingsAuthorizationCode, settingsRows } from './settings-protocol';
import { integrationForm, type IntegrationFormDraft, type IntegrationFormValue } from './settings-integration-form';
import { SettingsIntegrationFields } from './settings-integration-fields';
import { publishSettingsEditor } from './desktop-settings-publisher';

/** Official integration transport. OAuth URLs and user-entered secrets live only in this page. */
export function SettingsIntegration(props: { integrationID: string; directory?: string; disabled?: boolean; onSaved?: () => void }) {
  const state = settingsPageLifetime(), info = signal<Row>({}), key = signal(''), showKey = signal(false);

  const attempt = signal<Row | null>(null), code = signal('');
  const answers = signal<Record<string, IntegrationFormDraft>>({}), showErrors = signal<Record<string, boolean>>({});
  let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let polling: SettingsOperation | null = null, attemptOperation: SettingsOperation | null = null;
  const path = (suffix = '') => integrationSettingsPath(props.integrationID, suffix, props.directory);
  const methods = () => Array.isArray(info().methods) ? settingsRows(info().methods) : [];
  const keyMethod = () => methods().find(method => method.type === 'key' || method.type === 'api');
  const methodID = (method: Row) => text(method.id) || text(method.type);
  const fields = (method: Row) => method.form === undefined ? [] : settingsRows(method.form);
  const disabled = () => state.busy() || !!props.disabled || !!attempt();
  const attemptPath = (value: Row, suffix = '') => path(`/connect/${value.kind === 'command' ? 'command' : 'oauth'}/${encodeURIComponent(text(value.attemptID))}${suffix}`);
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: () => state.busy() || !!attempt(),
    dirty: () => !!key() || !!code() || Object.values(answers()).some(fields => Object.keys(fields).length > 0), stamp: () => [key(), code(), answers()],
  });
  async function snapshot(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const value = integrationPayload(await operation.request(path()));
    if (operation.current()) { info.set(value); state.ready.set(true); }
  }
  async function reload(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return; await state.perform(snapshot, operation); }
  function formAnswer(method: Row) {
    const id = methodID(method);
    const value = integrationForm(fields(method), answers()[id] || {});
    showErrors.set({ ...showErrors(), [id]: true });
    if (value.invalid.length) throw new Error(t('chat.questionCard.inputNeeded'));
    return value.answer;
  }
  function formFields(method: Row) {
    const id = methodID(method);
    return <SettingsIntegrationFields fields={fields(method)} draft={answers()[id] || {}} disabled={disabled()} showErrors={showErrors()[id] === true} onChange={(name: string, value: IntegrationFormValue) => answers.set({ ...answers(), [id]: { ...answers()[id], [name]: value } })} onError={() => state.error.set(t('settings.providers.page.toast.oauthStartFailed'))} />;
  }
  function clearTimers() { clearTimeout(timer); clearTimeout(expiry); }
  async function cancel(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    clearTimers();
    const active = attempt(); attempt.set(null); code.set('');
    if (active && operation.current()) await operation.request(attemptPath(active), 'DELETE');
  }
  async function succeeded(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    clearTimers(); attempt.set(null); code.set(''); key.set(''); answers.set({}); showErrors.set({});
    state.notice.set(t('settings.providers.page.toast.oauthCompleted'));
    // Commit is not repeated when a subsequent metadata read fails.
    try { await snapshot(operation); } catch { if (operation.current()) state.error.set(t('settings.providers.page.toast.authMethodsLoadFailed')); }
    if (operation.current()) props.onSaved?.();
  }
  async function poll(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const active = attempt();
    if (!active || !operation.current() || lifecycle() !== 'active' || polling === operation) return;
    polling = operation;
    try {
      if (Number(record(active.time).expires) <= Date.now()) throw new Error('expired');
      const result = integrationPayload(await operation.request(attemptPath(active)));
      if (!operation.current() || attempt() !== active) return;
      if (result.status === 'complete') { await succeeded(operation); return; }
      if (result.status !== 'pending') throw new Error('failed');
      if (typeof result.message === 'string') attempt.set({ ...active, instructions: result.message });
      if (lifecycle() === 'active') timer = setTimeout(() => { void poll(operation); }, 1500);
    } catch {
      if (operation.current()) { state.error.set(t('settings.providers.page.toast.oauthCompleteFailed')); if (attemptOperation === operation) await cancel(operation).catch(() => undefined); }
    } finally { if (polling === operation) polling = null; }
  }
  effect(() => {
    const active = attempt(), phase = lifecycle(), operation = state.operation();
    clearTimeout(timer); clearTimeout(expiry);
    if (!active || !operation?.current() || phase !== 'active') return;
    const remaining = Math.min(10 * 60_000, Number(record(active.time).expires) - Date.now());
    if (!(remaining > 0)) {
      state.error.set(t('settings.providers.page.toast.oauthCompleteFailed'));
      if (attemptOperation === operation) void cancel(operation).catch(() => undefined); return;
    }
    expiry = setTimeout(() => {
      if (!operation.current()) return;
      state.error.set(t('settings.providers.page.toast.oauthCompleteFailed'));
      if (attemptOperation === operation) void cancel(operation).catch(() => undefined);
    }, remaining);
    if (phase === 'active' && (active.mode === 'auto' || active.kind === 'command')) timer = setTimeout(() => { void poll(operation); }, 0);
  });
  cleanup(() => {
    clearTimers(); key.set(''); code.set(''); answers.set({}); attempt.set(null);
  });
  async function start(method: Row, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (disabled()) return;
    await state.perform(async (operation) => {
      const answer = formAnswer(method);
      if (method.type === 'command') {
        const command = Array.isArray(method.command) ? method.command.map(String).join(' ') : '';
        const choice = await AlertDialog.show({ title: text(method.label) || t('settings.providers.page.actions.connect'), description: command, actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'connect', label: t('settings.providers.page.actions.connect') }] });
        if (choice.action !== 'connect' || !operation.current()) return;
      }
      const kind = method.type === 'command' ? 'command' : method.type === 'external' ? 'external' : 'oauth';
      let response: Row;
      try { response = await operation.transaction(path(`/connect/${kind}`), 'POST', { methodID: method.id, ...(kind === 'command' ? {} : { answer }) }); }
      catch { throw new Error(t('settings.providers.page.toast.oauthStartFailed')); }
      if (kind === 'external') { await succeeded(operation); return; }
      const result = integrationPayload(response);
      if (!text(result.attemptID) || (kind === 'oauth' && !['auto', 'code'].includes(text(result.mode)))) throw new Error(t('settings.providers.page.toast.oauthStartFailed'));
      attemptOperation = operation; attempt.set({ ...result, kind });
    }, operation);
  }
  async function saveKey(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const method = keyMethod(); if (!method || disabled() || !key().trim()) return;
    await state.perform(async (operation) => {
      const answer = formAnswer(method);
      try { await operation.transaction(path('/connect/key'), 'POST', { key: key().trim(), answer }); }
      catch { throw new Error(t('settings.providers.page.toast.apiKeySaveFailed')); }
      await succeeded(operation); if (operation.current()) state.notice.set(t('settings.providers.page.toast.apiKeySaved'));
    }, operation);
  }
  async function copy(value: string, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    try { await Clipboard.writeText(value); } catch { if (operation.current()) state.error.set(t('settings.providers.page.toast.oauthLinkCopyFailed')); }
  }
  void reload();
  state.observeOperation(operation => { clearTimers(); polling = null; if (operation) void reload(operation); });
  return <SettingsGroup title={t('settings.providers.page.auth.title')}>
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void reload(); } : undefined} />
    <If when={state.ready() && !methods().length}><Text class="text-muted-foreground">{t('settings.providers.auth.noMethods')}</Text></If>
    <Each of={methods().filter(method => method.type === 'env')}>{method => <View class="gap-2"><Text class="text-sm text-foreground">{t('settings.providers.auth.environment')}</Text><Each of={Array.isArray(method().names) ? method().names as string[] : []}>{name => <Text class="text-xs text-muted-foreground">{name()}</Text>}</Each></View>}</Each>
    <If when={!!keyMethod()}>
      {formFields(keyMethod() || {})}
      <SettingsInput testID="integration-api-key" title={t('settings.voice.page.field.apiKey')} value={key()} masked={!showKey()} disabled={disabled()} onChange={next => key.set(next)} />
      <Button class={settingsAction} disabled={disabled()} onPress={() => showKey.set(!showKey())}><Text class="text-foreground">{t('settings.providers.custom.toggleKey')}</Text></Button>
      <Button testID="integration-save-key" class={settingsAction} disabled={disabled() || !key().trim()} onPress={() => { void saveKey(); }}><Text class="text-foreground">{t('settings.providers.page.actions.saveKey')}</Text></Button>
    </If>
    <Each of={methods().filter(method => ['oauth', 'external', 'command'].includes(text(method.type)))}>{method => <SettingsGroup title={text(method().label) || text(method().name) || text(method().id)}>
      <If when={!!method().description || !!method().help}><Text class="text-xs text-muted-foreground">{text(method().description) || text(method().help)}</Text></If>
      {formFields(method())}
      <Button testID={`integration-start-${methodID(method())}`} class={settingsAction} disabled={disabled()} onPress={() => { void start(method()); }}><Text class="text-foreground">{t('settings.providers.page.actions.connect')}</Text></Button>
    </SettingsGroup>}</Each>
    <If when={!!attempt()}><View class="gap-3">
      <Text class="text-sm text-muted-foreground">{t('settings.providers.page.auth.waiting')}</Text>
      <Text class="text-sm text-muted-foreground">{text(attempt()?.instructions)}</Text>
      <If when={!!attempt()?.userCode}><SettingsInput title={t('settings.providers.page.actions.copyCode')} value={text(attempt()?.userCode)} disabled onChange={() => undefined} /><Button class={settingsAction} onPress={() => { void copy(text(attempt()?.userCode)); }}><Text class="text-foreground">{t('settings.providers.page.actions.copyCode')}</Text></Button></If>
      <If when={!!attempt()?.url}><SettingsInput title={t('settings.providers.page.actions.copy')} value={text(attempt()?.url)} disabled onChange={() => undefined} /><Button class={settingsAction} onPress={() => { void state.perform(async (operation) => { const url = text(attempt()?.url); if (!/^https?:\/\//i.test(url)) throw new Error(t('settings.providers.page.toast.oauthStartFailed')); const result = await openUrl(url); if (!result.opened) throw new Error(t('settings.providers.page.toast.oauthStartFailed')); }); }}><Text class="text-foreground">{t('settings.mcp.page.actions.openInBrowser')}</Text></Button><Button class={settingsAction} onPress={() => { void copy(text(attempt()?.url)); }}><Text class="text-foreground">{t('settings.providers.page.actions.copy')}</Text></Button></If>
      <If when={attempt()?.mode === 'code'}><SettingsInput testID="integration-oauth-code" title={t('settings.mcp.page.auth.callbackInputPlaceholder')} value={code()} disabled={state.busy()} onChange={next => code.set(next)} /><Button class={settingsAction} disabled={state.busy() || !code().trim()} onPress={() => { void state.perform(async (operation) => {
        const active = attempt(); if (!active) return;
        try { await operation.transaction(attemptPath(active, '/complete'), 'POST', { code: settingsAuthorizationCode(code()) }); }
        catch { throw new Error(t('settings.providers.page.toast.oauthCompleteFailed')); }
        await succeeded(operation);
      }); }}><Text class="text-foreground">{t('settings.mcp.page.actions.completeAuthorization')}</Text></Button></If>
      <Button class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform(cancel); }}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
    </View></If>
  </SettingsGroup>;
}

import { signal, Text, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { record, text, type Row } from './model';
import type { SettingsRoute } from './settings';
import { modelLabel, modelVariants, type PickerModel } from './chat-models-helpers';
import { readSettingsModels, settingsDefaultModelPatch, settingsDefaultVariantPatch, settingsModelValue, settingsSummaryDefaults, settingsSummaryPrompts, settingsVisibleAgents } from './settings-defaults-core';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsObject } from './settings-protocol';
import { SettingsTarget } from './settings-target';
import { publishSettingsEditor } from './desktop-settings-publisher';

/** Defaults are Host-wide; only the Sessions catalogs carry the current directory. */
export function SettingsDefaults(props: SettingsRoute & { directory?: string; onReveal?: (node: ViewRef) => void }) {
  const summary = props.page === 'summary-ai', state = settingsPageLifetime();

  const settings = signal<Row>({}), models = signal<PickerModel[]>([]), agents = signal<Row[]>([]);
  const catalogError = signal(''), catalogBusy = signal(false), catalogReady = signal(false), agentsReady = signal(false);
  const prompts = signal({ ...settingsSummaryDefaults }), savedPrompts = signal({ ...settingsSummaryDefaults });
  const modelValue = () => summary
    ? text(settings().summaryProviderID) && text(settings().summaryModelID) ? `${text(settings().summaryProviderID)}/${text(settings().summaryModelID)}` : ''
    : text(settings().defaultModel);
  const directory = summary ? undefined : props.directory;
  async function loadCatalog(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (catalogBusy() || !operation.current()) return;
    catalogBusy.set(true); catalogError.set('');
    const results = await Promise.allSettled([
      operation.request('/api/config/settings').then(settingsObject).then(preferences => readSettingsModels(operation.request, preferences, directory)),
      summary ? Promise.resolve([]) : operation.request(`/api/agent${directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ''}`).then(settingsVisibleAgents),
    ]);
    if (!operation.current()) return;
    const errors: string[] = [];
    if (results[0].status === 'fulfilled') { models.set(results[0].value); catalogReady.set(true); }
    else errors.push(t('common.unavailable'));
    if (results[1].status === 'fulfilled') { agents.set(results[1].value); agentsReady.set(true); }
    else errors.push(t('common.unavailable'));
    catalogError.set(errors.join('\n')); catalogBusy.set(false);
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const value = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      settings.set(value);
      if (!promptsDirty()) { const initial = settingsSummaryPrompts(value); prompts.set(initial); savedPrompts.set(initial); }
      state.ready.set(true);
    }, operation);
    if (state.ready()) await loadCatalog(operation);
  }
  void load();
  state.observeOperation(operation => { catalogBusy.set(false); if (operation) void load(operation); });
  async function savePatch(patch: Row, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      await operation.transaction('/api/config/settings', 'PUT', patch);
      if (!operation.current()) return;
      settings.set({ ...settings(), ...patch });
      state.notice.set(t('filesView.editor.saved'));
    }, operation);
  }
  const busy = () => state.busy() || !state.ready();
  const modelOptions = () => [
    { value: '', title: t(summary ? 'settings.yuri.defaults.summary.providerModelDefault' : 'settings.agents.modelSelector.notSelected') },
    ...models().map(entry => ({ value: settingsModelValue(entry), title: `${text(entry.provider.name) || entry.providerID} / ${modelLabel(entry)}` })),
    ...(modelValue() && !models().some(entry => settingsModelValue(entry) === modelValue()) ? [{ value: modelValue(), title: `${modelValue()} · ${t('common.unavailable')}` }] : []),
  ];
  const selected = () => models().find(entry => settingsModelValue(entry) === modelValue());
  const variants = () => selected() ? modelVariants(selected()!) : [];
  const promptsDirty = () => Object.keys(settingsSummaryDefaults).some(key => prompts()[key as keyof typeof settingsSummaryDefaults] !== savedPrompts()[key as keyof typeof settingsSummaryDefaults]);
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: () => state.busy() || catalogBusy(), dirty: promptsDirty, stamp: () => [prompts()] });
  const fields = summary ? ['summaryModel', 'summaryTest', 'summaryCommitPrompt', 'summarySessionTitlePrompt'] : ['defaultModel', 'defaultVariant', 'defaultAgent'];
  const ids: Record<string, string> = { summaryModel: 'summary-ai.configuration', summaryTest: 'summary-ai.test-connection', summaryCommitPrompt: 'summary-ai.commit-prompt', summarySessionTitlePrompt: 'summary-ai.title-prompt', defaultModel: 'sessions.default-model', defaultVariant: 'sessions.default-thinking', defaultAgent: 'sessions.default-agent' };
  return <View class="gap-5">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!summary}><Text class="text-xs text-muted-foreground">{t('settings.gitIdentities.editor.field.host')} · {t('settings.yuri.visual.field.iosNativeUi')} · {t('common.unavailable')}</Text></If>
    <If when={!!catalogError()}><Text class="text-sm text-destructive">{catalogError()}</Text></If>
    <Button class={settingsAction} disabled={catalogBusy() || busy()} onPress={() => { void loadCatalog(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    <If when={state.ready()}><Each of={fields}>{field => <SettingsTarget id={ids[field()]} target={props.target} onReveal={props.onReveal}>
      <If when={field() === 'defaultModel' || field() === 'summaryModel'}><SettingsGroup title={t(summary ? 'settings.yuri.defaults.summary.providerModel' : 'settings.yuri.defaults.field.defaultModel')}>
        <SettingsChoice testID="settings-defaults-model" title={t(summary ? 'settings.yuri.defaults.summary.providerModel' : 'settings.yuri.defaults.field.defaultModel')} value={modelValue()} items={modelOptions()} disabled={busy() || !catalogReady() || catalogBusy()} onChange={value => { void state.perform(async (operation) => {
          const patch = settingsDefaultModelPatch(value, models(), summary);
          await operation.transaction('/api/config/settings', 'PUT', patch);
          if (operation.current()) { settings.set({ ...settings(), ...patch }); state.notice.set(t('filesView.editor.saved')); }
        }); }} />
      </SettingsGroup></If>
      <If when={field() === 'defaultVariant'}><SettingsGroup title={t('settings.yuri.defaults.field.defaultThinking')}>
        <SettingsChoice testID="settings-defaults-variant" title={t('settings.yuri.defaults.field.defaultThinking')} value={text(settings().defaultVariant)} items={[{ value: '', title: t('chat.modelControls.default') }, ...variants().map(value => ({ value, title: value })), ...(text(settings().defaultVariant) && !variants().includes(text(settings().defaultVariant)) ? [{ value: text(settings().defaultVariant), title: `${text(settings().defaultVariant)} · ${t('common.unavailable')}` }] : [])]} disabled={busy() || !catalogReady() || catalogBusy()} onChange={value => { void state.perform(async (operation) => {
          const patch = settingsDefaultVariantPatch(modelValue(), value, models());
          await operation.transaction('/api/config/settings', 'PUT', patch);
          if (operation.current()) { settings.set({ ...settings(), ...patch }); state.notice.set(t('filesView.editor.saved')); }
        }); }} />
      </SettingsGroup></If>
      <If when={field() === 'defaultAgent'}><SettingsGroup title={t('settings.yuri.defaults.field.defaultAgent')}>
        <SettingsChoice testID="settings-defaults-agent" title={t('settings.yuri.defaults.field.defaultAgent')} value={text(settings().defaultAgent)} items={[{ value: '', title: t('chat.modelControls.default') }, ...agents().map(agent => ({ value: text(agent.name), title: text(agent.name) })), ...(text(settings().defaultAgent) && !agents().some(agent => agent.name === settings().defaultAgent) ? [{ value: text(settings().defaultAgent), title: `${text(settings().defaultAgent)} · ${t('common.unavailable')}` }] : [])]} disabled={busy() || !agentsReady() || catalogBusy()} onChange={value => { if (!value || agents().some(agent => agent.name === value)) void savePatch({ defaultAgent: value }); }} />
      </SettingsGroup></If>
      <If when={field() === 'summaryTest'}><Button class={settingsAction} disabled={busy()} onPress={() => { void state.perform(async (operation) => {
        const result = record(await operation.request('/api/small-model/test', 'POST', { mode: 'provider', providerID: text(settings().summaryProviderID), modelID: text(settings().summaryModelID) }));
        if (result.ok !== true) throw new Error(t('settings.yuri.defaults.summary.testError.provider', { code: text(result.code) || 'generation_failed' }));
        if (operation.current()) state.notice.set(t('settings.yuri.defaults.summary.testConnectionOk'));
      }); }}><Text class="text-foreground">{t(state.busy() ? 'settings.yuri.defaults.summary.testingConnection' : 'settings.yuri.defaults.summary.testConnection')}</Text></Button></If>
      <If when={field() === 'summaryCommitPrompt' || field() === 'summarySessionTitlePrompt'}><SettingsGroup title={t(field() === 'summaryCommitPrompt' ? 'settings.yuri.defaults.summary.commitPrompt' : 'settings.yuri.defaults.summary.sessionTitlePrompt')}>
        <SettingsInput testID={`settings-basics-${field()}`} title={t(field() === 'summaryCommitPrompt' ? 'settings.yuri.defaults.summary.commitPrompt' : 'settings.yuri.defaults.summary.sessionTitlePrompt')} multiline disabled={busy()} value={prompts()[field() as keyof typeof settingsSummaryDefaults]} onChange={value => prompts.set({ ...prompts(), [field()]: value })} />
        <Button class={settingsAction} disabled={busy()} onPress={() => prompts.set({ ...prompts(), [field()]: settingsSummaryDefaults[field() as keyof typeof settingsSummaryDefaults] })}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button>
      </SettingsGroup></If>
    </SettingsTarget>}</Each></If>
    <If when={summary && state.ready()}><Button testID="settings-summary-save-prompts" class={settingsAction} disabled={busy() || !promptsDirty()} onPress={() => { void state.perform(async (operation) => {
      const patch = { ...prompts() };
      await operation.transaction('/api/config/settings', 'PUT', patch);
      if (operation.current()) { savedPrompts.set(patch); state.notice.set(t('filesView.editor.saved')); }
    }); }}><Text class="text-foreground">{t('settings.yuri.defaults.summary.save')}</Text></Button></If>
  </View>;
}

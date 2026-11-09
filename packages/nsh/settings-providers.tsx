import { cleanup, effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { t } from './i18n';
import { record, text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsEntityLayout, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { readSettingsCollection, settingsObject, settingsRows, settingsProviderModelsPatch } from './settings-protocol';
import { customProviderProtocols, resolveCustomProviderURL } from '../web/shared/custom-provider-protocol';
import { SettingsIntegration } from './settings-integration';
import { createProviderRemoval, providerRemovalBlock, ProviderRemovalError, type ProviderRemovalSnapshot } from './settings-provider-removal';
import { SettingsQuotaCredentials } from './settings-quota-credentials';
import { quotaCredentialProviderFor } from './settings-quota-credentials-core';
import { publishSettingsEditor, publishSettingsPicker } from './desktop-settings-publisher';

type ModelDraft = { id: string; name: string; context: string; output: string; tools: boolean; vision: boolean };
const newModel = (): ModelDraft => ({ id: '', name: '', context: '', output: '', tools: true, vision: false });
const providerCatalogRevision = signal({ key: '', serial: 0 });
export function SettingsProviders(props: SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean }) {
  const state = settingsPageLifetime(), providers = signal<Row[]>([]);

  const providerName = signal(''), baseURL = signal(''), apiKey = signal('');
  const protocol = signal(customProviderProtocols[0].package);
  const models = signal<ModelDraft[]>([]), edit = signal<ModelDraft | null>(null), editingID = signal<string | null>(null);
  const savedProvider = signal(''), modelSaved = signal(false);
  let creationAttempted = false;
  const hiddenModels = signal<Row[]>([]), filter = signal(''), removedModel = signal('');
  const removalSnapshot = signal<ProviderRemovalSnapshot | null>(null), removalMetadataFailed = signal(false), removalStarted = signal(false);
  const initialOperation = state.operation();
  const removal = createProviderRemoval(initialOperation?.request ?? (async () => { throw new Error('Runtime changed'); }), { providerID: props.entity || '', directory: props.directory, current: initialOperation?.current ?? (() => false) });
  state.observeOperation(operation => { removal.replaceLane(operation); if (operation) void load(operation); });
  const revisionKey = `${state.identityKey}:${props.directory || ''}`;
  const currentProvider = () => providers().find(item => item.id === props.entity);
  const quotaProvider = () => quotaCredentialProviderFor(props.entity || '');
  const quotaProviderName = () => quotaProvider() === 'opencode-go' ? 'OpenCode Go' : quotaProvider() === 'ollama-cloud' ? 'Ollama Cloud' : 'Cursor';
  const initialEdit = signal<ModelDraft | null>(null);
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: state.busy,
    dirty: () => !!props.create && !savedProvider() && (!!providerName() || !!baseURL() || !!apiKey() || protocol() !== customProviderProtocols[0].package || models().length > 0),
    stamp: () => [providerName(), baseURL(), apiKey(), protocol(), models()],
  });
  const modelNavigation = publishSettingsEditor({ current: state.current, scope: state.operation, pending: state.busy,
    dirty: () => !!edit() && JSON.stringify(edit()) !== JSON.stringify(initialEdit()), stamp: () => [edit(), editingID()],
  });
  publishSettingsPicker(() => !!edit());
  function beginModel(model: ModelDraft, id: string | null) { editingID.set(id); initialEdit.set(model); edit.set({ ...model }); }
  async function closeModel() { if (await modelNavigation.requestLeave()) edit.set(null); }
  cleanup(() => apiKey.set(''));
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (props.entity && removal.started()) { await state.perform(loadRemoval, operation); return; }
    await state.perform(async (operation) => {
      const rows = await readSettingsCollection(operation.request, 'providers', props.directory);
      const preferences = props.entity ? settingsObject(await operation.request('/api/config/settings')) : {};
      if (!operation.current()) return;
      hiddenModels.set(preferences.hiddenModels === undefined ? [] : settingsRows(preferences.hiddenModels));
      providers.set(rows); state.ready.set(true);
      if (props.entity && !rows.some(item => item.id === props.entity)) throw new Error(t('common.unavailable'));
      if (props.entity) await loadRemoval(operation);
    }, operation);
  }
  async function loadRemoval(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    try {
      const snapshot = await removal.inspect();
      if (operation.current()) { removalSnapshot.set(snapshot); removalMetadataFailed.set(false); }
    } catch { if (operation.current()) removalMetadataFailed.set(true); }
  }
  void load();
  let seenRevision = providerCatalogRevision().serial;
  effect(() => {
    const next = providerCatalogRevision();
    if (next.serial === seenRevision) return;
    seenRevision = next.serial;
    if (!props.entity && !props.create && next.key === revisionKey) untracked(() => { if (state.current()) void load(); });
  });
  const removalHint = () => removalMetadataFailed() ? t('settings.providers.page.toast.providerSourcesLoadFailed')
    : !removalSnapshot() ? t('settings.providers.page.state.loading')
      : removalSnapshot()?.environment ? t('settings.providers.delete.environmentHint')
        : !removalStarted() && providerRemovalBlock(removalSnapshot()!) ? t('settings.providers.delete.runtimeHint') : '';
  async function deleteProvider(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    let removed = false;
    await state.perform(async (operation) => {
      try {
        if (!removal.started()) {
          const consent = await removal.inspect();
          if (!operation.current()) return;
          removalSnapshot.set(consent); removalMetadataFailed.set(false);
          const block = providerRemovalBlock(consent);
          if (block) throw new ProviderRemovalError(block);
          const choice = await AlertDialog.show({ title: t('mobile.instances.delete'), description: t('settings.providers.delete.description'), actions: [
            { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
            { id: 'remove', label: t('settings.common.actions.delete'), role: 'destructive' },
          ] });
          if (choice.action !== 'remove' || !operation.current()) return;
          await removal.remove(consent);
        } else await removal.remove();
        if (!operation.current()) return;
        providerCatalogRevision.set({ key: revisionKey, serial: providerCatalogRevision().serial + 1 });
        removed = true;
      } catch (error) {
        if (!operation.current()) return;
        removalStarted.set(removal.started());
        if (error instanceof ProviderRemovalError && error.reason === 'environment') {
          const previous = removalSnapshot(); if (previous) removalSnapshot.set({ ...previous, environment: true });
        }
        if (error instanceof ProviderRemovalError && error.reason === 'metadata') removalMetadataFailed.set(true);
        throw new Error(t(error instanceof ProviderRemovalError && error.reason === 'environment' ? 'settings.providers.delete.environmentHint'
          : error instanceof ProviderRemovalError && error.reason === 'unavailable' ? 'settings.providers.delete.unavailable'
            : 'settings.providers.delete.failed'));
      }
    }, operation);
    if (removed && operation.current()) props.onBack();
  }
  const isAdded = (modelID: string) => !hiddenModels().some(item => item.providerID === props.entity && item.modelID === modelID);
  const providerModels = () => Object.entries(record(currentProvider()?.models));
  const visibleModels = () => providerModels().filter(([id, value]) => `${id} ${text(record(value).name)}`.toLocaleLowerCase().includes(filter().trim().toLocaleLowerCase()));
  async function setAdded(modelIDs: string[], added: boolean, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (removal.started()) return;
    await state.perform(async (operation) => {
      const fresh = await operation.request('/api/config/settings');
      if (!operation.current()) return;
      const patch = settingsProviderModelsPatch(fresh, props.entity || '', modelIDs, added);
      const result = await operation.transaction('/api/config/settings', 'PUT', patch);
      if (!operation.current()) return;
      hiddenModels.set(settingsRows(result.hiddenModels));
      removedModel.set(added || modelIDs.length !== 1 ? '' : modelIDs[0] || '');
    }, operation);
  }
  const endpoint = () => resolveCustomProviderURL(baseURL(), protocol(), models()[0]?.id);
  function editValue<K extends keyof ModelDraft>(key: K, next: ModelDraft[K]) { if (state.busy()) return; const current = edit(); if (current) edit.set({ ...current, [key]: next }); }
  function validModel(model: ModelDraft) {
    if (!model.id.trim() || /\s/.test(model.id) || (model.context && (!Number.isSafeInteger(Number(model.context)) || Number(model.context) < 1)) || (model.output && (!Number.isSafeInteger(Number(model.output)) || Number(model.output) < 1)) || (model.context && model.output && Number(model.output) > Number(model.context))) throw new Error(t('settings.providers.custom.invalidModel'));
    if (models().some(item => item.id === model.id && item.id !== editingID())) throw new Error(t('settings.providers.custom.invalidModels'));
  }
  async function saveModel(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (removal.started()) return;
    await state.perform(async (operation) => {
      const model = edit(); if (!model) return;
      validModel(model);
      if (!props.create) {
        const original = record(record(currentProvider()?.models)[editingID() || model.id]);
        const capabilities = record(original.capabilities);
        await operation.transaction('/api/config/providers/model', 'PUT', { directory: props.directory, providerId: props.entity, modelId: editingID(), name: model.name, tools: model.tools, vision: model.vision, inputModalities: Array.isArray(capabilities.input) ? capabilities.input : ['text'], context: model.context ? Number(model.context) : null, output: model.output ? Number(model.output) : null });
        if (!operation.current()) return;
        modelSaved.set(true); edit.set(null);
        state.notice.set(t('settings.agents.page.toast.savedNextRequest'));
        const refreshed = await readSettingsCollection(operation.request, 'providers', props.directory);
        if (!operation.current()) return;
        providers.set(refreshed); modelSaved.set(false);
      } else {
        models.set(editingID() ? models().map(item => item.id === editingID() ? model : item) : [...models(), model]);
        edit.set(null); editingID.set(null);
      }
    }, operation);
  }
  async function saveProvider(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (savedProvider()) { props.onBack(); return; }
    await state.perform(async (operation) => {
      if (creationAttempted) {
        const refreshed = await readSettingsCollection(operation.request, 'providers', props.directory);
        if (!operation.current()) return;
        providers.set(refreshed);
        throw new Error(t('settings.providers.custom.saveFailed'));
      }
      const resolved = endpoint();
      if (!resolved || !providerName().trim()) throw new Error(t('settings.providers.custom.saveFailed'));
      if (!models().length) throw new Error(t('settings.providers.custom.modelsEmpty'));
      if (new Set(models().map(model => model.id.trim())).size !== models().length) throw new Error(t('settings.providers.custom.invalidModels'));
      const config = { name: providerName().trim(), package: protocol(), settings: { baseURL: resolved.baseURL }, models: Object.fromEntries(models().map(model => [model.id.trim(), { ...(model.name.trim() ? { name: model.name.trim() } : {}), capabilities: { tools: model.tools, input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] }, ...(model.context || model.output ? { limit: { ...(model.context ? { context: Number(model.context) } : {}), ...(model.output ? { output: Number(model.output) } : {}) } } : {}) }])) };
      creationAttempted = true;
      let result: Row;
      try { result = await operation.transaction('/api/config/providers/custom', 'POST', { config, ...(apiKey().trim() ? { apiKey: apiKey().trim() } : {}), directory: props.directory }); }
      catch (error) { if (operation.current() && (error instanceof Error && error.message === 'scope_required' || error && typeof error === 'object' && 'status' in error && error.status === 400)) creationAttempted = false; throw error; }
      if (!operation.current()) return;
      savedProvider.set(text(result.providerId)); apiKey.set('');
      if (!savedProvider()) throw new Error(t('settings.providers.custom.refreshFailed'));
      state.notice.set(t('settings.agents.page.toast.savedNextRequest'));
    }, operation);
  }
  const providerList = () => <Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <Button testID="settings-entity-create" class={settingsAction} disabled={!state.current() || state.busy()} onPress={() => { if (state.current()) props.onOpen({ page: 'providers', create: true }); }}><Text class="text-foreground">{t('settings.providers.custom.title')}</Text></Button>
    <SettingsGroup title={t('settings.page.providers.title')}><Each of={providers()}>{provider => <Button testID={`settings-entity-${text(provider().id)}`} selected={props.entity === text(provider().id)} disabled={!state.current() || state.busy()} class="min-h-12 py-3 gap-1 selected:bg-accent" onPress={() => { if (state.current()) props.onOpen({ page: 'providers', entity: text(provider().id) }); }}><Text class="text-base text-foreground">{text(provider().name) || text(provider().id)}</Text><Text class="text-xs text-muted-foreground">{text(provider().id)}</Text></Button>}</Each></SettingsGroup>
  </Scroll>;
  return <SettingsEntityLayout editing={!!props.entity || !!props.create} list={providerList}><Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!!props.create && !edit()}>
      <SettingsGroup title={t('settings.providers.custom.title')}>
        <SettingsChoice title={t('settings.providers.custom.protocol')} value={protocol()} items={customProviderProtocols.map(item => ({ value: item.package, title: item.label }))} disabled={!!savedProvider()} onChange={next => protocol.set(next)} />
        <SettingsInput testID="settings-provider-name" title={t('settings.providers.custom.name')} value={providerName()} disabled={!!savedProvider()} onChange={next => providerName.set(next)} />
        <SettingsInput title={t('settings.providers.custom.baseURL')} value={baseURL()} disabled={!!savedProvider()} onChange={next => baseURL.set(next)} />
        <If when={!!endpoint()}><Text class="text-xs text-muted-foreground">{t(endpoint()?.inferredVersion ? 'settings.providers.custom.urlAuto' : 'settings.providers.custom.urlExact', { url: endpoint()?.requestURL || '' })}</Text></If>
        <SettingsInput title={t('settings.voice.page.field.apiKey')} value={apiKey()} masked disabled={!!savedProvider()} onChange={next => apiKey.set(next)} />
        <Button class={settingsAction} disabled={state.busy() || !!savedProvider()} onPress={() => { void state.perform(async (operation) => { const resolved = endpoint(); if (!resolved) throw new Error(t('settings.providers.custom.discoveryFailed')); const response = settingsObject(await operation.request('/api/config/providers/custom/models', 'POST', { package: protocol(), baseURL: resolved.baseURL, apiKey: apiKey() })); if (!operation.current()) return; const discovered = settingsRows(response.models); const existing = new Set(models().map(model => model.id)); models.set([...models(), ...discovered.filter(item => !existing.has(text(item.id))).map(item => ({ ...newModel(), id: text(item.id), name: text(item.name), context: item.context ? String(item.context) : '', output: item.output ? String(item.output) : '' }))]); }); }}><Text class="text-foreground">{t('settings.providers.custom.fetchModels')}</Text></Button>
      </SettingsGroup>
      <SettingsGroup title={t('settings.providers.custom.modelsCount', { count: models().length })}><Each of={models()}>{model => <View class="flex-row items-center gap-2"><Button class="flex-1 min-h-12" onPress={() => beginModel(model(), model().id)}><Text class="text-foreground">{model().name || model().id}</Text></Button><Button class={settingsAction} disabled={!!savedProvider()} onPress={() => models.set(models().filter(item => item.id !== model().id))}><Text class="text-foreground">−</Text></Button></View>}</Each><Button class={settingsAction} disabled={!!savedProvider()} onPress={() => beginModel(newModel(), null)}><Text class="text-foreground">{t('settings.providers.custom.addModel')}</Text></Button></SettingsGroup>
      <Button class={settingsAction} disabled={state.busy()} onPress={() => { void saveProvider(); }}><Text class="text-foreground">{t(savedProvider() ? 'gitView.common.done' : 'settings.plugins.page.action.save')}</Text></Button>
    </If>
    <If when={!!props.entity && !!currentProvider()}>
      <SettingsIntegration integrationID={text(currentProvider()?.integrationID) || props.entity || ''} directory={props.directory} disabled={state.busy() || removalStarted() || !!edit()} onSaved={() => { void load(); }} />
      <If when={!!quotaProvider() && !!props.onManageQuotaCredentials && !removalStarted()}>
        <SettingsQuotaCredentials providerId={quotaProvider()!} providerName={quotaProviderName()} active={props.active === true} directory={props.directory} target={props.target}
          onManage={() => { const provider = quotaProvider(); if (provider && state.current() && props.active === true && !state.busy() && !removalStarted()) props.onManageQuotaCredentials?.(provider, quotaProviderName(), props.directory); }} />
      </If>
      <SettingsGroup title={t('settings.providers.custom.modelsCount', { count: providerModels().filter(([id]) => isAdded(id)).length })}>
        <SettingsInput testID="settings-provider-filter" title={t('settings.providers.page.models.filterPlaceholder')} value={filter()} onChange={next => filter.set(next)} />
        <Button class={settingsAction} disabled={state.busy() || removalStarted() || !providerModels().length} onPress={() => { void setAdded(providerModels().map(([id]) => id), false); }}><Text class="text-foreground">{t('settings.providers.models.removeAll')}</Text></Button>
        <Each of={visibleModels()}>{pair => <View class="flex-row items-center gap-2"><Button class="flex-1 min-h-12 py-3 gap-1" disabled={state.busy() || removalStarted()} onPress={() => { const row = record(pair()[1]), limit = record(row.limit), capabilities = record(row.capabilities); beginModel({ id: pair()[0], name: text(row.name), context: limit.context ? String(limit.context) : '', output: limit.output ? String(limit.output) : '', tools: capabilities.tools !== false, vision: Array.isArray(capabilities.input) && capabilities.input.includes('image') }, pair()[0]); }}><Text class="text-foreground">{text(record(pair()[1]).name) || pair()[0]}</Text><Text class="text-xs text-muted-foreground">{pair()[0]}</Text></Button><Button testID={`settings-provider-toggle-${pair()[0]}`} class={settingsAction} disabled={state.busy() || removalStarted()} accessibilityLabel={t(isAdded(pair()[0]) ? 'settings.providers.custom.removeModel' : 'settings.providers.custom.addModel')} onPress={() => { void setAdded([pair()[0]], !isAdded(pair()[0])); }}><Text class="text-foreground">{isAdded(pair()[0]) ? '−' : '+'}</Text></Button></View>}</Each>
        <If when={!visibleModels().length}><Text class="text-muted-foreground">{t('settings.providers.page.models.noModelsMatchFilter')}</Text></If>
        <If when={!!removedModel() && !isAdded(removedModel())}><Text class="text-sm text-muted-foreground">{t('settings.providers.models.removed', { name: removedModel() })}</Text><Button class={settingsAction} disabled={state.busy() || removalStarted()} onPress={() => { void setAdded([removedModel()], true); }}><Text class="text-foreground">{t('settings.providers.models.undo')}</Text></Button></If>
      </SettingsGroup>
      <If when={modelSaved()}><Button class={settingsAction} onPress={() => { void load(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
      <If when={!!removalHint()}><Text testID="settings-provider-delete-hint" class="text-sm text-muted-foreground">{removalHint()}</Text></If>
      <If when={removalMetadataFailed() || removalSnapshot()?.environment === true}><Button testID="settings-provider-delete-metadata-retry" class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform(loadRemoval); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
      <Button testID="settings-provider-delete" class={settingsAction} disabled={state.busy() || !!removalHint()} onPress={() => { void deleteProvider(); }}><Text class="text-destructive">{t(removalStarted() ? 'settings.voice.volcengine.retry' : 'mobile.instances.delete')}</Text></Button>
    </If>
    <Sheet open={!!edit()} closeOnSwipe={false} closeOnEscape={false} closeOnBackdropPress={false} onCancel={() => { void closeModel(); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: '85%' }} backdropClass="bg-background/50"><Scroll class="flex-1" contentClass="p-5 gap-4 pb-10">
      <SettingsFeedback state={state} />
      <SettingsGroup title={t('settings.providers.custom.editModel')}>
        <SettingsInput title={t('settings.providers.custom.modelId')} value={edit()?.id || ''} disabled={!props.create} onChange={next => editValue('id', next)} />
        <SettingsInput testID="settings-model-name" title={t('settings.providers.custom.modelName')} value={edit()?.name || ''} onChange={next => editValue('name', next)} />
        <SettingsInput title={t('settings.providers.custom.context')} value={edit()?.context || ''} onChange={next => editValue('context', next)} />
        <SettingsInput title={t('settings.providers.custom.output')} value={edit()?.output || ''} onChange={next => editValue('output', next)} />
        <SettingsToggle title={t('settings.providers.custom.tools')} value={edit()?.tools === true} onChange={next => editValue('tools', next)} />
        <SettingsToggle title={t('settings.providers.custom.vision')} value={edit()?.vision === true} onChange={next => editValue('vision', next)} />
      </SettingsGroup>
      <Button class={settingsAction} disabled={state.busy()} onPress={() => { void saveModel(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
      <Button testID="settings-model-cancel" class={settingsAction} disabled={state.busy()} onPress={() => { void closeModel(); }}><Text class="text-foreground">{t('settings.plugins.dialog.add.action.cancel')}</Text></Button>
    </Scroll></Sheet>
  </Scroll></SettingsEntityLayout>;
}

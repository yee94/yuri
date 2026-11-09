import { cleanup, computed, locale, signal, Scroll, Text, View } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { NativeSheetSearch } from './sheet-search';
import { createNewSessionCatalog } from './new-session-selection';
import { language, t } from './i18n';
import { app, captureHostRequest, epoch } from './state';
import { assistantPath, query, sessionPath } from './runtime';
import { list, record, text, unwrap, type ChatTarget, type Row } from './model';
import { Icon } from './Icon';
import { NativeAgentAvatar, NativeModelLogo, nativeAgentAccent } from './chat-identity';
import { NativeProviderLogo } from './provider-logo';
import { NativeModelPickerHandle, NativeModelVariants, NativeModelVariantHeader, type ModelPickerSheet } from './model-picker-presentation';
import { openModelVariantMemory, rememberedModelVariant } from './model-variant-memory';
import { variantLabel as formatPickerVariantLabel } from './chat-models-helpers';
import { contextLabel, modelCapabilities, modelKey, modelLabel, modelMatches, modelRefs, modelVariants, pickerLists, pickerModels, pickerPreferences, preferenceUpdate, resolvedVariant, sameModel, type ModelRef, type PickerModel } from './chat-models-helpers';

const rowClass = 'min-h-11 px-2 py-2 flex-row items-center gap-2 active:bg-accent disabled:opacity-40';

/** Selection is read from the session, never inferred from persisted message history. */
export function ChatModels(props: { target: ChatTarget; onDone: () => void; initialTab?: 'model' | 'agent'; embedded?: boolean; sheet?: ModelPickerSheet }) {
  const request = captureHostRequest();
  const generation = epoch(), tab = props.initialTab ?? 'model';
  let alive = true, attempt = 0, initialized = false;
  let retryOperation: (() => Promise<void>) | undefined;
  cleanup(() => { alive = false; attempt++; });
  const current = () => alive && epoch() === generation;
  const catalog = createNewSessionCatalog(props.target.directory, current, request, app.runtimeScope() ? JSON.stringify(app.runtimeScope()) : undefined);
  cleanup(catalog.dispose);
  const { providers, agents, preferences, preferencesReady, partial } = catalog;
  const selection = signal<Row>({});
  const search = signal(''), expanded = signal<string[]>([]), expandedModel = signal('');
  const readingSelection = signal(false), pending = signal(false), error = signal('');
  const selectionReady = signal(false);
  const loading = () => catalog.busy() || readingSelection();
  const variantTarget = signal<PickerModel | null>(null), memory = signal<Row>({});
  const variantMemory = openModelVariantMemory(props.target.kind === 'session' && app.runtimeScope() ? { hostID: app.runtimeScope()!.hostID, directory: props.target.directory, sessionID: props.target.id } : null);
  const selectedModel = (): ModelRef => {
    const model = props.target.kind === 'session' ? record(selection().model) : { providerID: selection().providerID, id: selection().modelID, variant: selection().variant };
    return { providerID: text(model.providerID), modelID: text(model.id), ...(text(model.variant) ? { variant: text(model.variant) } : {}) };
  };
  async function load(preserveError = false) {
    const serial = ++attempt;
    if (!current()) return;
    readingSelection.set(!selectionReady()); if (!preserveError) error.set('');
    const applySelection = async () => {
      const value = props.target.kind === 'session'
        ? await request(`/api/session/${encodeURIComponent(props.target.id)}?${query(props.target.directory)}`)
        : await request('/api/yuri/assistants/snapshot');
      if (!current() || serial !== attempt) return;
      const result = props.target.kind === 'session' ? record(unwrap(value)) : list(record(value).assistants).find(bot => bot.id === props.target.id);
      if (!result || result.id !== props.target.id) throw new Error(t('assistants.state.invalidConfiguration'));
      selection.set(result); selectionReady.set(true); readingSelection.set(false);
      if (!initialized) { expanded.set(selectedModel().providerID ? [selectedModel().providerID] : []); initialized = true; }
    };
    const results = await Promise.allSettled([
      catalog.load(tab),
      applySelection(),
      tab === 'model' ? variantMemory.read().then(value => { if (current() && serial === attempt) memory.set(record(value)); }) : Promise.resolve(),
    ]);
    if (!current() || serial !== attempt) return;
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === 'rejected') { failures.push(String(result.reason instanceof Error ? result.reason.message : result.reason)); continue; }
    }
    if (catalog.error()) failures.push(catalog.error());
    if (failures.length) error.set([preserveError ? error() : '', ...failures].filter(Boolean).join('\n'));
    readingSelection.set(false);
  }
  const entries = computed(() => tab === 'model' && preferencesReady() ? pickerModels(providers(), preferences()) : []);
  const lists = computed(() => pickerLists(entries(), preferences(), selectedModel()));
  const groups = computed(() => {
    const matching = entries().filter(entry => modelMatches(entry, search()));
    return [...new Set(matching.map(entry => entry.providerID))].map(providerID => ({ providerID, provider: matching.find(entry => entry.providerID === providerID)!.provider, entries: matching.filter(entry => entry.providerID === providerID) }));
  });
  const filteredAgents = computed(() => agents().filter(agent => `${text(agent.name)} ${text(agent.description)}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase())));
  const favorite = (entry: ModelRef) => modelRefs(preferences().favoriteModels).some(ref => sameModel(ref, entry));
  const resolveVariant = (entry: PickerModel, clickRemembered = false) => resolvedVariant(entry, selectedModel(), preferences(), clickRemembered, rememberedModelVariant(memory(), text(selection().agent), entry));
  const displayVariant = (entry: PickerModel, showProvider = false) => resolveVariant(entry, showProvider && !sameModel(entry, selectedModel()));
  async function persistPreference(action: 'favorite' | 'recent', entry: ModelRef) {
    const latest = pickerPreferences(await request('/api/config/settings'));
    if (!current()) return;
    if (!latest) throw new Error(t('assistants.state.invalidConfiguration'));
    const patch = preferenceUpdate(latest, action, entry);
    const response = record(await request('/api/config/settings', 'PUT', patch));
    if (!current()) return;
    if (response.ok === false || response.success === false) throw new Error(t('assistants.composer.selectionSaveFailed'));
    catalog.setPreferences({ ...latest, ...patch });
  }
  async function toggleFavorite(entry: PickerModel) {
    if (!current() || pending() || loading() || !preferencesReady() || retryOperation) return;
    pending.set(true); error.set(''); retryOperation = undefined;
    const remembered = modelRefs(preferences().favoriteModels).find(ref => sameModel(ref, entry))?.variant ?? modelRefs(preferences().recentModels).find(ref => sameModel(ref, entry))?.variant;
    const variant = sameModel(entry, selectedModel()) ? selectedModel().variant : remembered;
    const ref = { providerID: entry.providerID, modelID: entry.modelID, ...(variant ? { variant } : {}) };
    try { await persistPreference('favorite', ref); }
    catch (cause) { if (current()) { error.set(cause instanceof Error ? cause.message : String(cause)); await load(true); } }
    finally { if (current()) pending.set(false); }
  }
  async function save(body: { model?: Row; agent?: string }) {
    if (!current() || pending() || loading() || !selectionReady() || retryOperation) return;
    pending.set(true); error.set(''); retryOperation = undefined;
    try {
      if (props.target.kind === 'session') {
        await request(`${sessionPath(props.target.id, body.model ? 'model' : 'agent')}?${query(props.target.directory)}`, 'POST', body);
      } else {
        const bot = typeof selection().revision === 'number' ? selection() : app.bots().find(item => item.id === props.target.id);
        if (!bot || typeof bot.revision !== 'number') throw new Error(t('assistants.composer.selectionSaveFailed'));
        await request(assistantPath(props.target.id, '').replace(/\/$/, ''), 'PATCH', {
          expectedRevision: bot.revision,
          ...(body.model ? { providerID: body.model.providerID, modelID: body.model.id, variant: text(body.model.variant) } : { agent: body.agent }),
        });
      }
      if (!current()) return;
      if (body.model) {
        const ref: ModelRef = { providerID: text(body.model.providerID), modelID: text(body.model.id), ...(text(body.model.variant) ? { variant: text(body.model.variant) } : {}) };
        // The model is already saved. A failed recent-list write retries only that write.
        const agent = text(selection().agent);
        retryOperation = async () => {
          const saved = await variantMemory.save(agent, ref, current);
          if (!current()) return;
          memory.set(saved);
          await persistPreference('recent', ref);
          if (current()) props.onDone();
        };
        await retryOperation(); retryOperation = undefined;
      } else props.onDone();
    } catch (cause) {
      if (current()) { error.set(cause instanceof Error ? cause.message : String(cause)); await load(true); }
    } finally { if (current()) pending.set(false); }
  }
  async function retry() {
    if (!current() || pending() || loading()) return;
    if (!retryOperation) { await load(); return; }
    pending.set(true); error.set('');
    try { await retryOperation(); retryOperation = undefined; }
    catch (cause) { if (current()) error.set(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) pending.set(false); }
  }
  const selectModel = (entry: PickerModel, variant?: string) => { void save({ model: { providerID: entry.providerID, id: entry.modelID, ...(variant ? { variant } : {}) } }); };
  const variantLabel = (variant?: string) => formatPickerVariantLabel(variant, t('chat.modelControls.default'));
  const contextText = (entry: PickerModel) => contextLabel(entry.model, language() === 'system' ? locale() : language());
  const renderModel = (entry: PickerModel, showProvider = false) => <View class={sameModel(entry, selectedModel()) ? 'bg-accent/15 rounded-lg' : ''}>
    <View class="flex-row items-center gap-1 px-2">
      <Button testID={`model-${entry.providerID}-${entry.modelID}`} class="flex-1 flex-row items-center active:bg-accent disabled:opacity-40" style={{ minHeight: showProvider ? 66 : 54, paddingVertical: 6 }} disabled={pending() || loading() || !selectionReady() || !!retryOperation} onPress={() => selectModel(entry, resolveVariant(entry, showProvider))}>
        <View class="flex-1 gap-0.5">
          <If when={showProvider}><Text class="text-muted-foreground" style={{ fontSize: 10, lineHeight: 10, opacity: 0.6, numberOfLines: 1 }}>{text(entry.provider.name) || entry.providerID}</Text></If>
          <View class="flex-row items-center gap-1.5"><NativeModelLogo modelID={entry.modelID} providerID={entry.providerID} size={14} /><Text class="text-foreground" style={{ fontSize: 14, lineHeight: 21, fontWeight: '500', flexShrink: 1, numberOfLines: 1 }}>{modelLabel(entry)}</Text><If when={sameModel(entry, selectedModel())}><Icon name="check" size={16} /></If></View>
          <View class="flex-row items-center gap-1.5">
            <If when={contextText(entry)}><Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 19.5 }}>{contextText(entry)}</Text></If>
            <If when={contextText(entry) && modelCapabilities(entry.model).length > 0}><View class="bg-border/50" style={{ width: 1, height: 12 }} /></If>
            <View class="flex-row items-center gap-1 pl-0.5"><Each of={modelCapabilities(entry.model)}>{capability => <View class="items-center justify-center" style={{ width: 16, height: 16, opacity: 0.6 }} accessibilityLabel={t(`chat.modelControls.${capability().label}`)}><Icon name={capability().icon} size={12} /></View>}</Each></View>
          </View>
        </View>
      </Button>
      <If when={modelVariants(entry).length > 0}><Button testID={`model-variant-${entry.providerID}-${entry.modelID}`} class="min-h-11 px-1 flex-row items-center gap-1" accessibilityLabel={t(expandedModel() === modelKey(entry) ? 'chat.modelControls.hideThinkingModes' : 'chat.modelControls.showThinkingModes')} disabled={pending()} onPress={() => expandedModel.set(expandedModel() === modelKey(entry) ? '' : modelKey(entry))}><Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 19.5, fontWeight: '500' }}>{variantLabel(displayVariant(entry, showProvider))}</Text><Icon name={expandedModel() === modelKey(entry) ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></Button></If>
      <Button testID={`model-favorite-${entry.providerID}-${entry.modelID}`} class="min-h-11 min-w-9 items-center justify-center" accessibilityLabel={t(favorite(entry) ? 'chat.modelControls.removeFromFavorites' : 'chat.modelControls.addToFavorites')} disabled={pending() || loading() || !preferencesReady()} onPress={() => { void toggleFavorite(entry); }}><View style={{ opacity: favorite(entry) ? 1 : 0.6 }}><Icon name={favorite(entry) ? 'star-fill' : 'star'} size={16} /></View></Button>
    </View>
    <If when={expandedModel() === modelKey(entry) && modelVariants(entry).length > 0}><NativeModelVariants entry={entry} selected={displayVariant(entry, showProvider)} disabled={pending() || loading() || !selectionReady() || !!retryOperation} id={`model-effort-${entry.providerID}-${entry.modelID}`} onSelect={variant => selectModel(entry, variant)} onMore={() => variantTarget.set({ ...entry, variant: displayVariant(entry, showProvider) })} /></If>
  </View>;
  void load();
  const content = <View class="flex-1 gap-2">
    <If when={props.embedded}><NativeModelPickerHandle sheet={props.sheet} /></If>
    <If when={variantTarget()}><NativeModelVariantHeader entry={variantTarget()!} onBack={() => variantTarget.set(null)} onClose={props.onDone} /></If>
    <If when={tab === 'model' || error() || loading()}><View class="px-2 gap-2">
      <If when={tab === 'model' && !variantTarget()}><NativeSheetSearch testID="model-search" value={search()} onChange={event => { search.set(event.value); expandedModel.set(''); }} placeholder={t('chat.modelControls.searchProvidersOrModels')} accessibilityLabel={t('chat.modelControls.searchProvidersOrModels')} clearTestID="model-search-clear" onClear={() => { search.set(''); expandedModel.set(''); }} /></If>
      <If when={error()}><Text class="text-sm text-destructive">{error()}</Text><Button testID="model-picker-retry" class={rowClass + ' bg-secondary rounded-xl'} disabled={loading() || pending()} onPress={() => { void retry(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      <If when={loading() || catalog.refreshing()}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={partial() && tab === 'model'}><Text class="text-sm text-muted-foreground">{t('chat.modelControls.partialCatalog')}</Text></If>
    </View></If>
    <Scroll class="flex-1" contentClass="px-2 pb-6 gap-2">
      <If when={variantTarget()}><NativeModelVariants entry={variantTarget()!} selected={sameModel(variantTarget()!, selectedModel()) ? resolveVariant(variantTarget()!) : variantTarget()!.variant} disabled={pending() || loading() || !selectionReady() || !!retryOperation} id="model-variant-option" full onSelect={variant => selectModel(variantTarget()!, variant)} /></If>
      <If when={tab === 'model' && !variantTarget()}>
        <If when={lists().favorites.filter(entry => modelMatches(entry, search())).length > 0}><View class="bg-card rounded-xl"><View class="px-3 flex-row items-center gap-2" style={{ height: 28 }}><Icon name="star" size={12} /><Text class="text-xs text-muted-foreground">{t('chat.modelControls.favorites')}</Text></View><Each of={lists().favorites.filter(entry => modelMatches(entry, search()))}>{entry => renderModel(entry(), true)}</Each></View></If>
        <If when={lists().recents.filter(entry => modelMatches(entry, search())).length > 0}><View class="bg-card rounded-xl"><View class="px-3 flex-row items-center gap-2" style={{ height: 28 }}><Icon name="time" size={12} /><Text class="text-xs text-muted-foreground">{t('chat.modelControls.recent')}</Text></View><Each of={lists().recents.filter(entry => modelMatches(entry, search()))}>{entry => renderModel(entry(), true)}</Each></View></If>
        <Each of={groups()}>{group => <View testID={`model-provider-group-${group().providerID}`} class="bg-card rounded-xl">
          <Button testID={`model-provider-${group().providerID}`} class="px-3 flex-row items-center gap-2 active:bg-accent" style={{ height: 36 }} accessibilityLabel={t(expanded().includes(group().providerID) ? 'chat.modelControls.collapseProvider' : 'chat.modelControls.expandProvider')} onPress={() => { if (!search().trim()) expanded.set(expanded().includes(group().providerID) ? expanded().filter(id => id !== group().providerID) : [...expanded(), group().providerID]); }}><NativeProviderLogo providerID={group().providerID} /><Text class="text-foreground" style={{ fontSize: 14, lineHeight: 21, fontWeight: '500' }}>{text(group().provider.name) || group().providerID}</Text><If when={selectedModel().providerID === group().providerID}><Text class="text-primary" style={{ fontSize: 13, lineHeight: 19.5 }}>{t('chat.modelControls.current')}</Text></If><View class="flex-1" /><Icon name={search().trim() || expanded().includes(group().providerID) ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></Button>
          <If when={search().trim() || expanded().includes(group().providerID)}><Each of={group().entries}>{entry => renderModel(entry())}</Each></If>
        </View>}</Each>
        <If when={!loading() && preferencesReady() && groups().length === 0}><Text class="p-4 text-sm text-muted-foreground">{t('chat.modelControls.noProvidersOrModelsFound')}</Text></If>
      </If>
      <If when={tab === 'agent'}><Each of={filteredAgents()}>{agent => <Button testID={`model-agent-${text(agent().id) || text(agent().name)}`} class={'p-3 flex-row items-start gap-2 rounded-xl border ' + (selection().agent === (agent().id || agent().name) ? ' bg-card border-primary' : 'border-border/40')} disabled={pending() || loading() || !selectionReady()} onPress={() => { void save({ agent: text(agent().id) || text(agent().name) }); }}><NativeAgentAvatar name={text(agent().name)} size={18} /><View class="flex-1 gap-1.5"><Text style={{ color: nativeAgentAccent(text(agent().name)), fontSize: 14, lineHeight: 18, fontWeight: '600' }}>{text(agent().name).charAt(0).toUpperCase() + text(agent().name).slice(1)}</Text><Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 19 }}>{text(agent().description)}</Text></View><If when={selection().agent === (agent().id || agent().name)}><Icon name="check" size={16} /></If></Button>}</Each><If when={!loading() && filteredAgents().length === 0}><Text class="p-4 text-sm text-muted-foreground">{t('commandPalette.empty.noResults')}</Text></If></If>
    </Scroll>
  </View>;
  return props.embedded ? <View class="flex-1 bg-background" role="group" accessible={false} accessibilityLabel={t(tab === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent')}>{content}</View> : <NavPage title={t(tab === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent')} class="flex-1 bg-background">{content}</NavPage>;
}

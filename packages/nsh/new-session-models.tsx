import { cleanup, computed, effect, locale, platform, signal, Scroll, Text, token, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeAgentAvatar, NativeModelLogo } from './chat-identity';
import { contextLabel, modelCapabilities, modelKey, modelLabel, modelMatches, modelRefs, modelVariants, pickerLists, pickerModels, pickerPreferences, resolvedVariant, sameModel, type ModelRef, type PickerModel } from './chat-models-helpers';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { NativeProviderLogo } from './provider-logo';
import { NativeModelPickerHandle, NativeModelVariants, NativeModelVariantHeader, type ModelPickerSheet } from './model-picker-presentation';
import { preferenceUpdate, variantLabel } from './chat-models-helpers';
import { record, text } from './model';
import type { NativeNewSessionOwner } from './new-session';
import { newSessionText } from './new-session-copy';
import { createNewSessionCatalog } from './new-session-selection';
import { agentDraftSelection, favoriteDraftPatch } from './new-session-ui-helpers';
import { captureHostRequest } from './state';
import { NativeNewSessionInputAX } from './new-session-native-owners';

/** Local draft selection: unlike ChatModels, this never reads/writes a session. */
export function NativeNewSessionModels(props: { owner: Pick<NativeNewSessionOwner, 'directory' | 'current' | 'selection' | 'select'>; mode: 'model' | 'agent'; active: () => boolean; onDone: () => void; sheet?: ModelPickerSheet }) {
  const request = captureHostRequest();
  const catalog = createNewSessionCatalog(props.owner.directory, () => props.active() && props.owner.current(), request);
  const search = signal(''), expanded = signal<string[]>([]), effort = signal(''), saving = signal(false), error = signal('');
  const variantTarget = signal<PickerModel | null>(null);
  let retryOperation: (() => Promise<void>) | undefined;
  cleanup(catalog.dispose);
  void catalog.load(props.mode).then(() => { if (props.owner.current() && props.owner.selection().model) expanded.set([props.owner.selection().model!.providerID]); });
  effect(() => {
    const active = props.active();
    if (platform?.desktop && active) untracked(() => { if (!catalog.resolved() && !catalog.busy()) void catalog.load(props.mode); });
  });
  const selected = (): ModelRef => ({ providerID: props.owner.selection().model?.providerID ?? '', modelID: props.owner.selection().model?.id ?? '', variant: props.owner.selection().model?.variant });
  const entries = computed(() => props.mode === 'model' && catalog.resolved() ? pickerModels(catalog.providers(), catalog.preferences()) : []);
  const favorites = computed(() => pickerLists(entries(), catalog.preferences(), selected()).favorites.filter(entry => modelMatches(entry, search())));
  const recents = computed(() => pickerLists(entries(), catalog.preferences(), selected()).recents.filter(entry => modelMatches(entry, search())));
  const groups = computed(() => {
    const matching = entries().filter(entry => modelMatches(entry, search()));
    return [...new Set(matching.map(entry => entry.providerID))].map(providerID => ({ providerID, name: text(matching.find(entry => entry.providerID === providerID)!.provider.name) || providerID, entries: matching.filter(entry => entry.providerID === providerID) }));
  });
  const agents = computed(() => catalog.agents().filter(agent => `${text(agent.name)} ${text(agent.description)}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase())));
  const favorite = (entry: ModelRef) => modelRefs(catalog.preferences().favoriteModels).some(ref => sameModel(ref, entry));
  const resolveVariant = (entry: PickerModel, clickRemembered = false) => resolvedVariant(entry, selected(), catalog.preferences(), clickRemembered, text(catalog.preferences().defaultVariant));
  const displayVariant = (entry: PickerModel, prefix: string) => resolveVariant(entry, prefix !== 'all' && !sameModel(entry, selected()));
  const contextText = (entry: PickerModel) => contextLabel(entry.model, language() === 'system' ? locale() : language());
  async function persistRecent(ref: ModelRef) {
    const latest = pickerPreferences(await request('/api/config/settings'));
    if (!props.active() || !props.owner.current()) return;
    if (!latest) throw new Error('invalid-settings');
    const patch = preferenceUpdate(latest, 'recent', ref);
    const response = record(await request('/api/config/settings', 'PUT', patch));
    if (!props.active() || !props.owner.current()) return;
    if (response.ok === false || response.success === false) throw new Error('save-failed');
    catalog.preferences.set({ ...latest, ...patch });
  }
  async function retry() {
    if (!props.active() || !props.owner.current() || saving() || catalog.busy()) return;
    if (!retryOperation) { error.set(''); await catalog.load(props.mode); return; }
    saving.set(true); error.set('');
    try { await retryOperation(); retryOperation = undefined; }
    catch { if (props.active() && props.owner.current()) error.set(newSessionText('operationFailed')); }
    finally { saving.set(false); }
  }
  async function toggleFavorite(entry: PickerModel) {
    if (!props.active() || !props.owner.current() || saving() || catalog.busy() || retryOperation) return;
    saving.set(true); error.set('');
    try {
      const latest = pickerPreferences(await request('/api/config/settings'));
      if (!props.active() || !props.owner.current()) return;
      if (!latest) throw new Error('invalid-settings');
      const patch = favoriteDraftPatch(latest, entry, props.owner.selection());
      const response = record(await request('/api/config/settings', 'PUT', patch));
      if (!props.active() || !props.owner.current()) return;
      if (response.ok === false || response.success === false) throw new Error('save-failed');
      catalog.preferences.set({ ...latest, ...patch });
    } catch { if (props.active() && props.owner.current()) error.set(newSessionText('operationFailed')); }
    finally { saving.set(false); }
  }
  async function choose(model?: PickerModel, variant?: string, agent?: string, reset = false) {
    if (!props.active() || !props.owner.current() || saving() || catalog.busy() || retryOperation) return;
    saving.set(true); error.set('');
    try {
      if (props.mode === 'agent' && agent && record(catalog.agents().find(row => row.name === agent)?.model).modelID) {
        await catalog.load('model');
        if (!props.active() || !props.owner.current()) return;
        if (catalog.error()) throw new Error('catalog-unavailable');
      }
      const selection = props.owner.selection();
      await props.owner.select(props.mode === 'agent'
        ? !reset && agent ? agentDraftSelection(selection, agent, catalog.agents(), catalog.providers(), true) : { ...(selection.model ? { model: selection.model } : {}) }
        : { ...(selection.agent ? { agent: selection.agent } : {}), ...(!reset && model ? { model: { providerID: model.providerID, id: model.modelID, ...(variant !== undefined ? { variant } : {}) } } : {}) });
      if (!props.active() || !props.owner.current()) return;
      if (props.mode === 'model' && model && !reset) {
        const ref = { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) };
        retryOperation = async () => { await persistRecent(ref); if (props.active() && props.owner.current()) props.onDone(); };
        await retryOperation(); retryOperation = undefined;
      } else props.onDone();
    } catch { if (props.active()) error.set(newSessionText('operationFailed')); }
    finally { saving.set(false); }
  }
  const row = (entry: PickerModel, prefix: string) => <View class={'border-t border-border/30 ' + (sameModel(entry, selected()) ? 'bg-accent/15' : '')}>
    <View class="flex-row items-center gap-2 px-2 py-1.5">
      <Button testID={`new-session-${prefix}-model-${entry.providerID}-${entry.modelID}`} class="flex-1 rounded-lg active:bg-accent disabled:opacity-40" style={{ minHeight: prefix === 'all' ? 42 : 54 }} disabled={saving() || catalog.busy() || !!retryOperation} onPress={() => { void choose(entry, resolveVariant(entry, prefix !== 'all')); }}>
        <View class="gap-0.5">
          <If when={prefix !== 'all'}><Text class="text-muted-foreground" style={{ fontSize: 10, lineHeight: 10, opacity: 0.6, numberOfLines: 1 }}>{text(entry.provider.name) || entry.providerID}</Text></If>
          <View class="flex-row items-center gap-1.5"><NativeModelLogo modelID={entry.modelID} providerID={entry.providerID} size={14} /><Text class="text-foreground" style={{ fontSize: 14, lineHeight: 21, fontWeight: '500', flexShrink: 1, numberOfLines: 1 }}>{modelLabel(entry)}</Text><If when={sameModel(entry, selected())}><Icon name="check" size={16} /></If></View>
          <If when={!!contextText(entry) || modelCapabilities(entry.model).length > 0}><View class="flex-row gap-1.5 items-center"><If when={!!contextText(entry)}><Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 19.5 }}>{contextText(entry)}</Text></If><If when={!!contextText(entry) && modelCapabilities(entry.model).length > 0}><View class="bg-border/50" style={{ width: 1, height: 12 }} /></If><View class="flex-row gap-1 pl-0.5"><Each of={modelCapabilities(entry.model)}>{capability => <View class="items-center justify-center" style={{ width: 16, height: 16, opacity: 0.6 }} accessibilityLabel={t(`chat.modelControls.${capability().label}`)}><Icon name={capability().icon} size={12} /></View>}</Each></View></View></If>
        </View>
      </Button>
      <If when={modelVariants(entry).length > 0}><Button testID={`new-session-effort-${prefix}-${entry.providerID}-${entry.modelID}`} class="min-h-11 px-1 flex-row items-center gap-0.5 rounded-lg active:bg-accent disabled:opacity-40" disabled={saving()} accessibilityLabel={t(effort() === `${prefix}:${modelKey(entry)}` ? 'chat.modelControls.hideThinkingModes' : 'chat.modelControls.showThinkingModes')} onPress={() => effort.set(effort() === `${prefix}:${modelKey(entry)}` ? '' : `${prefix}:${modelKey(entry)}`)}><Text class="text-muted-foreground" style={{ fontSize: 13, lineHeight: 19.5, fontWeight: '500' }}>{variantLabel(displayVariant(entry, prefix), t('chat.modelControls.default'))}</Text><Icon name={effort() === `${prefix}:${modelKey(entry)}` ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></Button></If>
      <Button testID={`new-session-favorite-${prefix}-${entry.providerID}-${entry.modelID}`} class="items-center justify-center rounded-md active:bg-accent disabled:opacity-40" style={{ width: 20, height: 20 }} hitSlop={12} selected={favorite(entry)} accessibilityLabel={t(favorite(entry) ? 'chat.modelControls.unfavoriteAria' : 'chat.modelControls.favoriteAria')} disabled={saving() || catalog.busy()} onPress={() => { void toggleFavorite(entry); }}><Icon name={favorite(entry) ? 'star-fill' : 'star'} size={16} color={token(favorite(entry) ? 'primary' : 'muted-foreground')} /></Button>
    </View>
    <If when={effort() === `${prefix}:${modelKey(entry)}`}><NativeModelVariants entry={entry} selected={displayVariant(entry, prefix)} disabled={saving() || catalog.busy() || !!retryOperation} id={`new-session-variant-${prefix}-${entry.providerID}-${entry.modelID}`} onSelect={variant => { void choose(entry, variant); }} onMore={() => variantTarget.set({ ...entry, variant: displayVariant(entry, prefix) })} /></If>
  </View>;
  return <View class="flex-1 gap-2" role="group" accessible={false} accessibilityLabel={t(props.mode === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent')}>
    <If when={!platform?.desktop}><NativeModelPickerHandle sheet={props.sheet} /></If>
    <If when={platform?.desktop && !variantTarget()}><Text class="px-2 py-1 text-sm text-foreground font-semibold">{t(props.mode === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent')}</Text></If>
    <If when={variantTarget()}><NativeModelVariantHeader entry={variantTarget()!} onBack={() => variantTarget.set(null)} onClose={props.onDone} /></If>
    <View class="px-2 gap-2"><If when={!variantTarget()}><View class="rounded-xl border border-border/40 bg-card px-2 flex-row items-center gap-1.5"><View style={{ opacity: 0.6 }}><Icon name="search" size={14} /></View><Input testID="new-session-selection-search" class="flex-1 min-h-9 text-sm text-foreground" value={search()} autoCapitalize="none" autoCorrect={false} placeholder={t(props.mode === 'model' ? 'chat.modelControls.searchProvidersOrModels' : 'chat.modelControls.searchAgents')} accessibilityLabel={t(props.mode === 'model' ? 'chat.modelControls.searchProvidersOrModels' : 'chat.modelControls.searchAgents')} onChange={event => { search.set(event.value); effort.set(''); }} /><NativeNewSessionInputAX field="selection" label={t(props.mode === 'model' ? 'chat.modelControls.searchProvidersOrModels' : 'chat.modelControls.searchAgents')} /><If when={search()}><Button testID="new-session-search-clear" class="min-h-9 min-w-6 items-center justify-center" accessibilityLabel={t('chat.modelControls.clearSearch')} onPress={() => { search.set(''); effort.set(''); }}><Icon name="close-circle" size={16} /></Button></If></View></If>
      <If when={catalog.error() || error()}><Text class="text-sm text-destructive">{error() || t('common.unavailable')}</Text><Button testID="new-session-catalog-retry" class="min-h-11 px-3 rounded-xl bg-secondary" disabled={catalog.busy() || saving()} onPress={() => { void retry(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      <If when={catalog.busy()}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If><If when={catalog.partial() && props.mode === 'model'}><Text class="text-sm text-muted-foreground">{t('chat.modelControls.partialCatalog')}</Text></If>
    </View>
    <Scroll class="flex-1" contentClass="px-2 pb-4 gap-2">
      <If when={variantTarget()}><NativeModelVariants entry={variantTarget()!} selected={sameModel(variantTarget()!, selected()) ? resolveVariant(variantTarget()!) : variantTarget()!.variant} disabled={saving() || catalog.busy() || !!retryOperation} id="new-session-variant-option" full onSelect={variant => { void choose(variantTarget()!, variant); }} /></If>
      <If when={!variantTarget()}>
      <Button testID="new-session-selection-default" class="min-h-11 px-2 rounded-lg active:bg-accent disabled:opacity-40" disabled={saving()} onPress={() => { void choose(undefined, undefined, undefined, true); }}><Text class="text-sm text-muted-foreground">{t('chat.modelControls.resetToDefault')}</Text></Button>
      <If when={props.mode === 'model'}>
        <If when={favorites().length > 0}><View class="bg-card rounded-xl border border-border/40 overflow-hidden"><View class="px-2 py-1.5 flex-row items-center gap-1.5"><Icon name="star-fill" size={12} /><Text class="text-xs text-muted-foreground font-semibold">{t('chat.modelControls.favorites')}</Text></View><Each of={favorites()}>{entry => row(entry(), 'favorite')}</Each></View></If>
        <If when={recents().length > 0}><View class="bg-card rounded-xl border border-border/40 overflow-hidden"><View class="px-2 py-1.5 flex-row items-center gap-1.5"><Icon name="time" size={12} /><Text class="text-xs text-muted-foreground font-semibold">{t('chat.modelControls.recent')}</Text></View><Each of={recents()}>{entry => row(entry(), 'recent')}</Each></View></If>
        <Each of={groups()}>{group => <View class="bg-card rounded-xl border border-border/40 overflow-hidden"><Button testID={`new-session-provider-${group().providerID}`} class="min-h-9 flex-row items-center px-2 py-1.5 gap-1.5 active:bg-accent" onPress={() => { if (!search().trim()) expanded.set(expanded().includes(group().providerID) ? expanded().filter(value => value !== group().providerID) : [...expanded(), group().providerID]); }}><NativeProviderLogo providerID={group().providerID} /><Text class="flex-1 text-sm text-foreground font-medium" style={{ numberOfLines: 1 }}>{group().name}</Text><If when={selected().providerID === group().providerID}><Text class="text-xs text-muted-foreground">{t('chat.modelControls.current')}</Text></If><Icon name={expanded().includes(group().providerID) || !!search() ? 'arrow-down-s' : 'arrow-right-s'} size={12} /></Button><If when={expanded().includes(group().providerID) || !!search()}><Each of={group().entries}>{entry => row(entry(), 'all')}</Each></If></View>}</Each>
        <If when={catalog.resolved() && !groups().length}><Text class="p-3 text-sm text-muted-foreground">{t('chat.modelControls.noModelsFound')}</Text></If>
      </If>
      <If when={props.mode === 'agent'}><Each of={agents()}>{agent => <Button testID={`new-session-agent-${text(agent().name)}`} class={'min-h-14 px-3 py-2.5 gap-2 rounded-xl border border-border/40 flex-row items-start active:bg-accent disabled:opacity-40 ' + (props.owner.selection().agent === text(agent().name) ? 'bg-accent/20' : '')} selected={props.owner.selection().agent === text(agent().name)} disabled={saving() || catalog.busy()} onPress={() => { void choose(undefined, undefined, text(agent().name)); }}><NativeAgentAvatar name={text(agent().name)} size={18} /><View class="flex-1 gap-1"><Text class="text-sm text-foreground font-semibold">{text(agent().name).charAt(0).toUpperCase() + text(agent().name).slice(1)}</Text><If when={text(agent().description)}><Text class="text-xs text-muted-foreground">{text(agent().description)}</Text></If></View><If when={props.owner.selection().agent === text(agent().name)}><Icon name="check" size={16} /></If></Button>}</Each><If when={catalog.resolved() && !agents().length}><Text class="p-3 text-sm text-muted-foreground">{t('chat.commandAutocomplete.empty')}</Text></If></If>
      </If>
    </Scroll>
  </View>;
}

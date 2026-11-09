import { cleanup, computed, locale, signal, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheetSearch } from './sheet-search';
import { Icon } from './Icon';
import { NativeModelLogo } from './chat-identity';
import { NativeProviderLogo } from './provider-logo';
import { NativeSheet } from './native-sheet';
import { createModelPickerSheet, NativeModelPickerHandle, NativeModelVariants, NativeModelVariantHeader } from './model-picker-presentation';
import { contextLabel, modelCapabilities, modelKey, modelLabel, modelMatches, modelRefs, modelVariants, pickerLists, pickerModels, resolvedVariant, sameModel, variantLabel, type ModelRef, type PickerModel } from './chat-models-helpers';
import { language, t } from './i18n';
import { text, type Row } from './model';
import { createFeaturePicker } from './features-picker-core';
import { nativeDensity } from './appearance';

type Props = {
  providers: Row[]; selected: ModelRef; disabled: boolean; loading: boolean; error: string; partial: boolean;
  current: () => boolean; request: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  reload: () => void; onChange: (value: ModelRef) => void;
};

export function FeaturesModelPicker(props: Props) {
  const open = signal(false), mounted = signal(false), ready = signal(false), revision = signal(0);
  const close = () => open.set(false), sheet = createModelPickerSheet(close);
  let alive = true, presentation = 0, actionPresentation = 0;
  cleanup(() => { alive = false; });
  // The editor supplies its captured Host/generation fence. Presentation state
  // must not retire an admitted preference operation when its Sheet closes.
  const ownerCurrent = props.current;
  const current = () => alive && ownerCurrent();
  const picker = createFeaturePicker({ current, changed: () => revision.set(revision() + 1), select: props.onChange, close: () => { if (presentation === actionPresentation) close(); }, request: props.request });
  const canAct = () => open() && ready() && !props.disabled && current() && !picker.busy();
  const choose = async (value: ModelRef) => { if (!canAct() || picker.pending() || !picker.loaded()) return; actionPresentation = presentation; await picker.choose(value); };
  const retry = async () => { if (!canAct()) return; actionPresentation = presentation; await picker.retry(); };
  const clear = () => { if (!canAct() || picker.pending()) return; actionPresentation = presentation; picker.clear(); };
  const show = () => {
    if (!current() || props.disabled) return;
    presentation++; mounted.set(true); ready.set(false); sheet.reset(); open.set(true);
    props.reload(); void picker.load();
  };
  return <View>
    <Button testID="features-model-picker" class="min-h-12 px-3 py-3 rounded-xl bg-secondary flex-row items-center gap-2" style={{ ...nativeDensity().settings.field, ...nativeDensity().forms.inline }} disabled={props.disabled} accessibilityLabel={t('chat.modelControls.selectModel')} onPress={show}>
      <NativeModelLogo providerID={props.selected.providerID} modelID={props.selected.modelID} size={16} />
      <Text class="flex-1 text-foreground">{props.selected.modelID ? `${props.selected.providerID}/${props.selected.modelID}` : t('settings.agents.modelSelector.notSelected')}</Text>
      <Text class="text-muted-foreground">{variantLabel(props.selected.variant, t('chat.modelControls.default'))}</Text>
    </Button>
    <NativeSheet testID="features-model-sheet" open={open()} closeOnSwipe closeOnBackdropPress closeOnEscape detents={[.72, .98]} popupClass="bg-background" popupStyle={{ height: sheet.height() }} onOpen={() => ready.set(true)} onOpenChange={event => open.set(event.open)} onClose={() => { ready.set(false); if (!open()) mounted.set(false); }}>
      <If when={mounted()}><PickerContent {...props} picker={picker} revision={revision} choose={choose} retry={retry} clear={clear} current={() => open() && ready() && current()} close={close} sheet={sheet} /></If>
    </NativeSheet>
  </View>;
}

function PickerContent(props: Props & { close: () => void; picker: ReturnType<typeof createFeaturePicker>; revision: () => number; choose: (value: ModelRef) => Promise<void>; retry: () => Promise<void>; clear: () => void; sheet: ReturnType<typeof createModelPickerSheet> }) {
  const search = signal(''), effort = signal(''), expanded = signal<string[]>([props.selected.providerID]), target = signal<PickerModel | null>(null);
  let alive = true;
  cleanup(() => { alive = false; });
  const picker = props.picker;
  const read = () => { props.revision(); return picker; };
  const entries = computed(() => pickerModels(props.providers, read().preferences()));
  const lists = computed(() => pickerLists(entries(), read().preferences(), props.selected));
  const groups = computed(() => {
    const result = new Map<string, { providerID: string; provider: Row; models: PickerModel[] }>();
    for (const entry of entries()) {
      if (!modelMatches(entry, search())) continue;
      const group = result.get(entry.providerID);
      if (group) group.models.push(entry);
      else result.set(entry.providerID, { providerID: entry.providerID, provider: entry.provider, models: [entry] });
    }
    return [...result.values()];
  });
  const blocked = () => !alive || !props.current() || props.disabled || props.loading || read().busy() || read().pending() || !read().loaded();
  const resolve = (entry: PickerModel, remembered = false) => resolvedVariant(entry, props.selected, read().preferences(), remembered);
  const choose = (entry: PickerModel, variant?: string) => { if (!blocked()) void props.choose({ providerID: entry.providerID, modelID: entry.modelID, variant: variant ?? '' }); };
  const favorite = (entry: PickerModel) => modelRefs(read().preferences().favoriteModels).some(ref => sameModel(ref, entry));
  const row = (entry: PickerModel, section: string) => {
    const key = `${section}:${modelKey(entry)}`, selectedVariant = () => resolve(entry, section !== 'all' && !sameModel(entry, props.selected));
    return <View class={sameModel(entry, props.selected) ? 'rounded-lg bg-accent/15' : ''}>
      <View class="flex-row px-2 gap-1 items-center">
        <Button testID={`features-model-${section}-${entry.providerID}-${entry.modelID}`} class="flex-1 min-h-14 py-2 active:bg-accent" disabled={blocked()} onPress={() => choose(entry, selectedVariant())}>
          <View class="gap-1"><If when={section !== 'all'}><Text class="text-xs text-muted-foreground">{text(entry.provider.name) || entry.providerID}</Text></If><View class="flex-row gap-1.5 items-center"><NativeModelLogo modelID={entry.modelID} providerID={entry.providerID} size={14} /><Text class="text-sm text-foreground" style={{ flexShrink: 1 }}>{modelLabel(entry)}</Text><If when={sameModel(entry, props.selected)}><Icon name="check" size={16} /></If></View>
            <View class="flex-row items-center gap-1.5"><Text class="text-xs text-muted-foreground">{contextLabel(entry.model, language() === 'system' ? locale() : language())}</Text><Each of={modelCapabilities(entry.model)}>{capability => <View accessibilityLabel={t(`chat.modelControls.${capability().label}`)}><Icon name={capability().icon} size={12} /></View>}</Each></View>
          </View>
        </Button>
        <If when={modelVariants(entry).length > 0}><Button testID={`features-effort-${section}-${entry.providerID}-${entry.modelID}`} class="min-h-11 px-1 flex-row gap-1 items-center" disabled={blocked()} accessibilityLabel={t(effort() === key ? 'chat.modelControls.hideThinkingModes' : 'chat.modelControls.showThinkingModes')} onPress={() => effort.set(effort() === key ? '' : key)}><Text class="text-xs text-muted-foreground">{variantLabel(selectedVariant(), t('chat.modelControls.default'))}</Text><Icon name={effort() === key ? 'arrow-down-s' : 'arrow-right-s'} size={12} /></Button></If>
        <Button testID={`features-favorite-${section}-${entry.providerID}-${entry.modelID}`} class="min-h-11 min-w-9 items-center justify-center" disabled={blocked()} accessibilityLabel={t(favorite(entry) ? 'chat.modelControls.removeFromFavorites' : 'chat.modelControls.addToFavorites')} onPress={() => { if (blocked()) return; void picker.favorite({ providerID: entry.providerID, modelID: entry.modelID, variant: sameModel(entry, props.selected) ? props.selected.variant ?? '' : selectedVariant() ?? '' }); }}><Icon name={favorite(entry) ? 'star-fill' : 'star'} size={16} /></Button>
      </View>
      <If when={effort() === key}><NativeModelVariants entry={entry} selected={selectedVariant()} disabled={blocked()} id={`features-variant-${section}-${entry.providerID}-${entry.modelID}`} onSelect={value => choose(entry, value)} onMore={() => target.set({ ...entry, variant: selectedVariant() })} /></If>
    </View>;
  };
  return <View class="flex-1 gap-2"><NativeModelPickerHandle sheet={props.sheet} />
    <If when={target()}><NativeModelVariantHeader entry={target()!} onBack={() => target.set(null)} onClose={props.close} /></If>
    <If when={!target()}><View class="px-3 gap-2 flex-row items-center"><View class="flex-1"><NativeSheetSearch testID="features-model-search" value={search()} placeholder={t('chat.modelControls.searchProvidersOrModels')} accessibilityLabel={t('chat.modelControls.searchProvidersOrModels')} onChange={event => { search.set(event.value); effort.set(''); }} clearTestID="features-model-search-clear" onClear={() => { search.set(''); effort.set(''); }} /></View><Button testID="features-model-close" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={props.close}><Icon name="close" size={18} /></Button></View></If>
    <If when={props.error || read().error()}><Text class="px-3 text-sm text-destructive">{props.error || read().error()}</Text><Button testID="features-model-retry" class="min-h-11 px-3 bg-secondary" disabled={read().busy()} onPress={() => { if (!alive || !props.current() || props.disabled || read().busy()) return; if (props.error) props.reload(); void props.retry(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
    <If when={props.loading || read().busy()}><Text class="px-3 text-muted-foreground">{t('common.loading')}</Text></If><If when={props.partial}><Text class="px-3 text-muted-foreground">{t('chat.modelControls.partialCatalog')}</Text></If>
    <Scroll class="flex-1" contentClass="px-2 pb-6 gap-2" contentStyle={nativeDensity().pages.modelPicker}>
      <If when={target()}><NativeModelVariants entry={target()!} selected={sameModel(target()!, props.selected) ? props.selected.variant : target()!.variant} full disabled={blocked()} id="features-variant-option" onSelect={value => choose(target()!, value)} /></If>
      <If when={!target()}><Button testID="features-model-default" class="min-h-11 px-3" disabled={blocked()} onPress={() => { if (!blocked()) props.clear(); }}><Text class="text-muted-foreground">{t('settings.agents.modelSelector.notSelected')}</Text></Button>
        <Each of={(['favorites', 'recents'] as const)}>{section => <If when={lists()[section()].filter(entry => modelMatches(entry, search())).length > 0}><View class="bg-card rounded-xl"><Text class="px-3 py-2 text-xs text-muted-foreground">{t(section() === 'favorites' ? 'chat.modelControls.favorites' : 'chat.modelControls.recent')}</Text><Each of={lists()[section()].filter(entry => modelMatches(entry, search()))}>{entry => row(entry(), section())}</Each></View></If>}</Each>
        <Each of={groups()}>{group => <View class="bg-card rounded-xl"><Button testID={`features-provider-${group().providerID}`} class="min-h-11 px-3 flex-row items-center gap-2" accessibilityLabel={t(expanded().includes(group().providerID) ? 'chat.modelControls.collapseProvider' : 'chat.modelControls.expandProvider')} onPress={() => { if (!search().trim()) expanded.set(expanded().includes(group().providerID) ? expanded().filter(value => value !== group().providerID) : [...expanded(), group().providerID]); }}><NativeProviderLogo providerID={group().providerID} /><Text class="flex-1 text-foreground">{text(group().provider.name) || group().providerID}</Text><If when={props.selected.providerID === group().providerID}><Text class="text-xs text-muted-foreground">{t('chat.modelControls.current')}</Text></If><Icon name={search() || expanded().includes(group().providerID) ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></Button><If when={search() || expanded().includes(group().providerID)}><Each of={group().models}>{entry => row(entry(), 'all')}</Each></If></View>}</Each>
        <If when={!props.loading && read().loaded() && groups().length === 0}><Text class="p-3 text-muted-foreground">{t('chat.modelControls.noProvidersOrModelsFound')}</Text></If>
      </If>
    </Scroll>
  </View>;
}

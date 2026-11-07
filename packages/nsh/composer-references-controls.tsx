import { cleanup, colorScheme, computed, effect, signal, untracked, windowSize, List, Text, View, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { createMixedReferenceSearch, type MixedReferenceSearchState, type ReferenceCandidate, type ReferenceScope } from './composer-references';
import { Icon } from './Icon';
import { nativeAppearance } from './appearance';
import { referenceDescriptionStyle, referenceHighlightColor, referencePanelMetrics, referenceQuerySpans, referenceQuerySpanStyle, referenceRowDensity, referenceTitleStyle } from './composer-references-presentation';
import type { NativeReferenceKeyboard } from './composer-reference-keyboard-native';
import type { ReferenceKeyboardOwner } from './composer-reference-keyboard';
import { nativeAutocompleteSurface } from './composer-surface';

export function NativeAutocompleteRowText(props: { value: string; query: string; color?: string; description?: boolean; path?: boolean }) {
  const color = () => props.color ?? referenceHighlightColor(nativeAppearance.current()?.cssVars[colorScheme()], nativeAppearance.current()?.themeIDs[colorScheme()], colorScheme() === 'dark');
  return <Text class={props.description ? 'text-muted-foreground' : 'flex-1 text-foreground'} style={{
    ...(props.description ? referenceDescriptionStyle : referenceTitleStyle), numberOfLines: 1,
    textOverflow: props.path ? 'ellipsis-middle' : 'ellipsis',
  }}><Each of={referenceQuerySpans(props.value, props.query)}>{span =>
    <Text style={referenceQuerySpanStyle(span().matched, color())}>{span().text}</Text>
  }</Each></Text>;
}

/** Mount inside the owner's picker presence boundary. No app/catalog subscriptions. */
export function NativeReferencePicker(props: {
  scope: ReferenceScope;
  open: boolean;
  query?: string;
  currentSessionID?: string;
  /** Optional smaller anchor/keyboard budget. The panel otherwise follows Web's 40% viewport cap, up to 320pt. */
  maxHeight?: number;
  keyboard?: NativeReferenceKeyboard;
  request: (path: string) => Promise<unknown>;
  onChoose?: (candidate: ReferenceCandidate) => void;
  onClose: () => void;
}) {
  const state = signal<MixedReferenceSearchState>({ rows: [], busy: false, failed: false });
  const retry = signal(0);
  let owner: ReferenceKeyboardOwner | undefined;
  const search = createMixedReferenceSearch(props.request, value => {
    state.set(value);
    if (owner) props.keyboard?.core.rows(owner, value.rows, value.busy);
  });
  const listRef = signal<ListRef | undefined>(undefined);
  let visible = new Set<string>();
  function revealActive() {
    const active = props.keyboard?.state(), ref = listRef();
    if (active?.id && ref && !visible.has(active.id)) ref.scrollToIndex({ index: active.index, animated: false, viewPosition: 0.5 });
  }
  effect(() => { props.keyboard?.state(); listRef(); untracked(revealActive); });
  // The button token `primary` is intentionally neutral. Query spans use Web's primary-base instead.
  const queryColor = computed(() => {
    const appearance = nativeAppearance.current(), variant = colorScheme();
    return referenceHighlightColor(appearance?.cssVars[variant], appearance?.themeIDs[variant], variant === 'dark');
  });
  cleanup(() => search.dispose());
  effect(() => {
    retry();
    // Read the complete scope, even when its container object keeps identity.
    const scope = { host: props.scope.host, draft: props.scope.draft, directory: props.scope.directory };
    owner = { scope, query: props.query || '' };
    search.update(scope, props.query || '', props.open, props.currentSessionID);
  });
  return <If when={props.open}>
    <View testID="reference-picker" style={{ ...nativeAutocompleteSurface, paddingVertical: referenceRowDensity.panelPadding }}>
      <If when={state().busy && !state().rows.length}><Text class="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={state().failed}><Button testID="reference-retry" class="min-h-8 px-3 py-1" onPress={() => retry.set(retry() + 1)}><Text class="text-xs text-destructive">{t('common.unavailable')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
      <If when={!!state().rows.length}>
        <List testID="reference-mixed-list" ref={node => listRef.set(node)} keyboardDismissMode="none" viewabilityConfig={{ itemVisibleThreshold: 1 }} onViewableItemsChange={info => { visible = new Set(info.viewableItems.filter(item => item.isViewable).map(item => item.key)); }} each={state().rows} keyExtractor={row => row.presentation.id} style={{ height: referencePanelMetrics(state().rows, windowSize().height, props.maxHeight).listHeight }}>{item =>
          // NSH 0.4 Button does not forward focusable; a pressable native row must not take Input focus.
          <View testID={`reference-result-${item().candidate.kind}-${item().candidate.value}`} role="button" accessible focusable={false} accessibilityState={{ selected: props.keyboard?.state().id === item().presentation.id }} class="rounded-lg active:bg-accent" style={{ minHeight: referenceRowDensity.minHeight, marginHorizontal: referenceRowDensity.marginHorizontal, paddingHorizontal: referenceRowDensity.paddingHorizontal, paddingVertical: referenceRowDensity.paddingVertical }} onPress={() => { if (props.keyboard) props.keyboard.choose(item().presentation.id); else props.onChoose?.(item().candidate); }}>
            <View class="flex-row items-center" style={{ gap: referenceRowDensity.gap }}>
              <View class="items-center justify-center" style={{ width: referenceRowDensity.iconWell, height: referenceRowDensity.iconWell }}><Icon name={item().presentation.iconName} size={referenceRowDensity.icon} /></View>
              <View class="flex-1">
                <View class="flex-row items-baseline gap-2">
                  <NativeAutocompleteRowText value={item().presentation.title} query={props.query || ''} color={queryColor()} path={item().candidate.kind === 'file' || item().candidate.kind === 'directory'} />
                  <If when={!!item().presentation.trailingLabel}><Text class="text-muted-foreground" style={{ ...referenceDescriptionStyle, numberOfLines: 1 }}>{item().presentation.trailingLabel}</Text></If>
                </View>
                <If when={!!item().presentation.subtitle}><NativeAutocompleteRowText value={item().presentation.subtitle!} query={props.query || ''} color={queryColor()} description /></If>
              </View>
            </View>
          </View>
        }</List>
      </If>
      <If when={!state().busy && !state().rows.length}>
        <View class="flex-row items-center justify-between px-3 py-1">
          <Text class="text-xs text-muted-foreground">{t('chat.commandAutocomplete.empty')}</Text>
          <Button testID="reference-close" accessibilityLabel={t('gitView.common.close')} class="min-h-8 min-w-8 items-center justify-center" onPress={props.onClose}><Icon name="close" size={14} /></Button>
        </View>
      </If>
    </View>
  </If>;
}

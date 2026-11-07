import { cleanup, computed, effect, List, signal, Text, untracked, View, windowSize, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import type { Row } from './model';
import type { ReferenceScope } from './composer-references';
import type { NativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { nativeCommandRows } from './composer-commands-model';
import { nativeAutocompleteSurface } from './composer-surface';
import { referenceDescriptionStyle, referencePanelMetrics, referenceRowDensity, referenceTitleStyle } from './composer-references-presentation';
import { NativeAutocompleteRowText } from './composer-references-controls';
import { Icon } from './Icon';

/** Presence-owned slash list; the input adapter owns trigger, scope, keys, focus and IME. */
export function NativeCommandSuggestions(props: {
  scope: ReferenceScope;
  keyboard: NativeReferenceKeyboard;
  commands: Row[];
  loadCommands: () => Promise<void>;
  maxHeight?: number;
}) {
  const failure = signal(false), loading = signal(false), retry = signal(0);
  const ref = signal<ListRef | undefined>(undefined);
  let alive = true, attempted = false, flight = false, visible = new Set<string>();
  cleanup(() => { alive = false; });
  const query = () => props.keyboard.commandTrigger()?.query ?? '';
  effect(() => {
    retry();
    if (attempted || flight) return;
    attempted = true; flight = true;
    untracked(() => loading.set(true));
    void props.loadCommands().then(() => { if (alive) failure.set(false); }).catch(() => { if (alive) failure.set(true); })
      .finally(() => { flight = false; if (alive) loading.set(false); });
  });
  const rows = computed(() => nativeCommandRows(props.commands, query(), props.scope, t));
  effect(() => { props.keyboard.commandCore.rows({ scope: props.scope, query: query() }, rows(), loading()); });
  effect(() => {
    const state = props.keyboard.commandState(), list = ref();
    if (state.id && list && !visible.has(state.id)) untracked(() => list.scrollToIndex({ index: state.index, animated: false, viewPosition: .5 }));
  });
  return <View testID="command-suggestions" style={{ ...nativeAutocompleteSurface, paddingVertical: 4 }}>
    <If when={failure()}><Button testID="command-retry" class="min-h-8 px-3 py-1" onPress={() => { if (!flight) { attempted = false; retry.set(retry() + 1); } }}><Text class="text-xs text-destructive">{t('common.unavailable')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
    <If when={loading() && !rows().length}><Text class="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
    <List testID="command-list" ref={node => ref.set(node)} keyboardDismissMode="none" each={rows()} keyExtractor={row => row.presentation.id}
      style={{ height: referencePanelMetrics(rows(), windowSize().height, props.maxHeight).listHeight }}
      viewabilityConfig={{ itemVisibleThreshold: 1 }} onViewableItemsChange={info => { visible = new Set(info.viewableItems.filter(item => item.isViewable).map(item => item.key)); }}>{row =>
      <View testID={`command-${row().command.name}`} role="button" accessible focusable={false} accessibilityState={{ selected: props.keyboard.commandState().id === row().presentation.id }}
        class="rounded-lg active:bg-accent" style={{ minHeight: referenceRowDensity.minHeight, marginHorizontal: 6, paddingHorizontal: 12, paddingVertical: 6 }}
        onPress={() => props.keyboard.chooseCommand(row().presentation.id)}>
        <View class="flex-row items-center gap-2">
          <View class="items-center justify-center" style={{ width: 20, height: 20 }}><Icon name={row().presentation.iconName} size={14} /></View>
          <View class="flex-1">
            <View class="flex-row items-center gap-2"><NativeAutocompleteRowText value={row().presentation.title} query={query()} /><Text class="text-muted-foreground" style={{ ...referenceDescriptionStyle, numberOfLines: 1 }}>{row().presentation.badge}</Text></View>
            <If when={!!row().presentation.subtitle}><NativeAutocompleteRowText description value={row().presentation.subtitle!} query={query()} /></If>
          </View>
        </View>
      </View>
    }</List>
    <If when={!loading() && !rows().length && !failure()}><Text class="px-3 py-2 text-muted-foreground" style={referenceTitleStyle}>{t('chat.commandAutocomplete.empty')}</Text></If>
  </View>;
}

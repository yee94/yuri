import { cleanup, computed, effect, keymap, List, platform, signal, Text, token, untracked, View, type ListRef } from 'nsh';
import { Button, Select, type OpenChangeReason, type SelectProps } from 'nsh/base';
import { NativeSheetSearch } from './sheet-search';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';
import { createSelectKeyboard } from './select-keyboard';
import { nativeDensity } from './appearance';
import { nativeSheetSpacing } from './native-density';

export type NativeSelectProps = SelectProps & {
  searchResults?: (query: string, items: NonNullable<SelectProps['items']>) => { items: NonNullable<SelectProps['items']>; notice?: SelectProps['empty'] };
  listHeader?: SelectProps['empty'];
};

/** Searchable choices keep their content, but UIKit owns the presented container. */
export function NativeSelect(props: NativeSelectProps) {
  if (platform.os !== 'ios' && !props.searchResults && !props.listHeader) return <Select {...props}
    popupStyle={[...nativeSheetSpacing(props.popupClass, nativeDensity()), props.popupStyle]}
    groupStyle={[...nativeSheetSpacing(props.groupClass, nativeDensity()), props.groupStyle]}
    itemStyle={[...nativeSheetSpacing(props.itemClass, nativeDensity()), props.itemStyle]} />;
  const localOpen = signal(props.defaultOpen ?? false), localValue = signal(props.defaultValue ?? null), ready = signal(false), focused = signal(false);
  const value = () => props.value === undefined ? localValue() : props.value;
  const opened = () => props.open ?? localOpen();
  function changeOpen(open: boolean, reason: OpenChangeReason) { localOpen.set(open); props.onOpenChange?.({ open, reason }); }
  function select(next: string | null) {
    if (props.disabled || (next !== null && !props.items?.some(item => item.value === next && !item.disabled))) return;
    if (value() !== next) { localValue.set(next); props.onChange?.({ value: next }); }
    changeOpen(false, 'select');
  }
  const triggerKeyboard = createSelectKeyboard({ items: () => props.items ?? [], selected: value, focus: () => {}, choose: select });
  effect(() => {
    if (focused() && !opened() && !props.disabled) {
      const bindings = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz0123456789'].map(letter => [letter, () => { triggerKeyboard.type(letter); triggerKeyboard.choose(); }]));
      const unbind = keymap.bind(bindings, { when: 'notEditing', repeat: true }); cleanup(unbind);
    }
  });
  return <View class={props.class} style={props.style}>
    <View testID={props.testID} role="combobox" disabled={props.disabled} accessibilityLabel={props.accessibilityLabel ?? undefined}
      onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
      onPress={() => { if (!props.disabled) changeOpen(!opened(), 'triggerPress'); }}>
      {props.trigger}
    </View>
    <If when={props.cleanable && value() != null}><Button disabled={props.disabled} class={props.clearButtonClass ?? undefined} style={props.clearButtonStyle}
      accessibilityLabel={props.clearButtonAccessibilityLabel ?? t('mobile.sessions.clearSearchAria')} onPress={() => select(null)}>{props.clearButton ?? <Icon name="close" size={16} />}</Button></If>
    <NativeSheet open={opened() && !props.disabled} closeOnSwipe onOpen={() => { ready.set(true); props.onOpen?.(); }} onClose={() => { ready.set(false); props.onClose?.(); }} onCancel={props.onCancel}
      onOpenChange={event => changeOpen(event.open, event.reason)} popupClass={props.popupClass ?? 'bg-background'} popupStyle={props.popupStyle} backdropClass={props.backdropClass} backdropStyle={props.backdropStyle}>
      <NativeSelectContent props={props} value={value} active={() => opened() && ready() && !props.disabled} select={select} close={() => { props.onCancel?.(); changeOpen(false, 'cancel'); }} />
    </NativeSheet>
  </View>;
}

function NativeSelectContent(options: { props: NativeSelectProps; value: () => string | null | undefined; active: () => boolean; select: (value: string) => void; close: () => void }) {
  const props = options.props, search = signal(''), highlighted = signal<string | null>(null), composing = signal(false);
  let list: ListRef | undefined;
  effect(() => { if (props.searchResults && !options.active()) untracked(() => search.set('')); });
  const results = computed(() => {
    if (props.searchResults) return options.active() ? props.searchResults(search(), props.items ?? []) : { items: [], notice: undefined };
    return { items: props.items ?? [], notice: undefined };
  });
  const entries = computed(() => {
    const term = props.searchResults ? '' : search().trim().toLocaleLowerCase(), groups = new Set<string>();
    return results().items.map((item, index) => ({ ...item, index })).filter(item => !term || item.title.toLocaleLowerCase().includes(term)).map(item => {
      const header = !!item.group && !groups.has(item.group);
      if (item.group) groups.add(item.group);
      return { ...item, disabled: item.disabled === true, header };
    });
  });
  const keyboard = createSelectKeyboard({ items: entries, selected: options.value, choose: next => { if (options.active() && !composing()) options.select(next); },
    focus: (value, index) => { highlighted.set(value); if (index >= 0) list?.scrollToIndex({ index, animated: false, viewPosition: .5 }); },
  });
  let previousQuery: string | undefined;
  effect(() => {
    const query = props.searchResults ? search() : undefined; entries();
    untracked(() => { keyboard.sync(previousQuery !== undefined && query !== previousQuery); previousQuery = query; });
  });
  effect(() => {
    if (!options.active() || composing()) return;
    const navigation = keymap.bind({ up: () => keyboard.move('up'), down: () => keyboard.move('down'), enter: keyboard.choose, escape: options.close }, { when: 'always', repeat: true });
    const rest: Record<string, () => void> = { home: () => keyboard.move('home'), end: () => keyboard.move('end'), pageup: () => keyboard.move('pageup'), pagedown: () => keyboard.move('pagedown'), space: keyboard.choose };
    for (const letter of 'abcdefghijklmnopqrstuvwxyz0123456789') rest[letter] = () => keyboard.type(letter);
    const letters = keymap.bind(rest, { when: 'notEditing', repeat: true });
    cleanup(() => { navigation(); letters(); });
  });
  return <View class="flex-1 p-4 gap-3" style={nativeDensity().select.content}>
    <View class="flex-row items-center gap-2" style={nativeDensity().select.header}><Text class="flex-1 text-base font-semibold text-foreground">{props.accessibilityLabel}</Text><Button class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={options.close}><Icon name="close" size={20} /></Button></View>
    <If when={props.searchable}><NativeSheetSearch value={search()} onChange={event => search.set(event.value)} onCompositionChange={event => composing.set(event.composing)} onClear={() => search.set('')}
      accessibilityLabel={props.searchAccessibilityLabel ?? props.accessibilityLabel ?? undefined} placeholder={props.searchPlaceholder ?? props.accessibilityLabel ?? undefined} class={props.searchClass ?? undefined} style={props.searchStyle} /></If>
    {props.listHeader}
    {results().notice}
    <List role="listbox" ref={node => { list = node; }} class={`flex-1 ${props.listClass ?? ''}`} style={props.listStyle} each={entries()} keyExtractor={item => item.value} keyboardDismissMode="interactive">
      {entry => <View>
        <If when={entry().header}><View class={props.groupClass ?? 'px-3 py-2'} style={[...(props.groupClass ? nativeSheetSpacing(props.groupClass, nativeDensity()) : [nativeDensity().select.group]), props.groupStyle]}>{props.renderGroup ? props.renderGroup({ title: entry().group! }) : <Text class="text-xs text-muted-foreground">{entry().group}</Text>}</View></If>
        <Button role="option" selected={options.value() === entry().value} disabled={entry().disabled || !options.active()} class={props.itemClass ?? 'min-h-12 px-3 rounded-xl flex-row items-center selected:bg-accent disabled:opacity-40'} style={[props.itemClass ? props.itemClass.split(/\s+/).includes('min-h-11') ? nativeDensity().select.compactItem : { minHeight: nativeDensity().select.item.minHeight } : nativeDensity().select.item, ...nativeSheetSpacing(props.itemClass, nativeDensity()), props.itemStyle, highlighted() === entry().value ? { backgroundColor: token('accent') } : null]}
          accessibilityLabel={entry().title} onPress={() => { if (options.active()) options.select(entry().value); }}>
          {props.renderItem ? props.renderItem(entry()) : <View class="flex-row items-center gap-2" style={nativeDensity().select.label}><Text class="text-foreground flex-1">{entry().title}</Text><If when={options.value() === entry().value}><Icon name="check" size={18} /></If></View>}
        </Button>
      </View>}
    </List>
    <If when={entries().length === 0}>{props.empty ?? <Text class="text-muted-foreground">{t('commandPalette.empty.noResults')}</Text>}</If>
  </View>;
}

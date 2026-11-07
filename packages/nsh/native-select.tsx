import { cleanup, computed, effect, keymap, List, platform, signal, Text, token, untracked, View, type ListRef } from 'nsh';
import { Button, Input, Select, type OpenChangeReason, type SelectProps } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';
import { createSelectKeyboard } from './select-keyboard';

/** Searchable choices keep their content, but UIKit owns the presented container. */
export function NativeSelect(props: SelectProps) {
  if (platform.os !== 'ios') return <Select {...props} />;
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

function NativeSelectContent(options: { props: SelectProps; value: () => string | null | undefined; active: () => boolean; select: (value: string) => void; close: () => void }) {
  const props = options.props, search = signal(''), highlighted = signal<string | null>(null), composing = signal(false);
  let list: ListRef | undefined;
  const entries = computed(() => {
    const term = search().trim().toLocaleLowerCase(), groups = new Set<string>();
    return (props.items ?? []).map((item, index) => ({ ...item, index })).filter(item => item.title.toLocaleLowerCase().includes(term)).map(item => {
      const header = !!item.group && !groups.has(item.group);
      if (item.group) groups.add(item.group);
      return { ...item, disabled: item.disabled === true, header };
    });
  });
  const keyboard = createSelectKeyboard({ items: entries, selected: options.value, choose: next => { if (options.active() && !composing()) options.select(next); },
    focus: (value, index) => { highlighted.set(value); if (index >= 0) list?.scrollToIndex({ index, animated: false, viewPosition: .5 }); },
  });
  effect(() => { entries(); untracked(() => keyboard.sync()); });
  effect(() => {
    if (!options.active() || composing()) return;
    const navigation = keymap.bind({ up: () => keyboard.move('up'), down: () => keyboard.move('down'), enter: keyboard.choose, escape: options.close }, { when: 'always', repeat: true });
    const rest: Record<string, () => void> = { home: () => keyboard.move('home'), end: () => keyboard.move('end'), pageup: () => keyboard.move('pageup'), pagedown: () => keyboard.move('pagedown'), space: keyboard.choose };
    for (const letter of 'abcdefghijklmnopqrstuvwxyz0123456789') rest[letter] = () => keyboard.type(letter);
    const letters = keymap.bind(rest, { when: 'notEditing', repeat: true });
    cleanup(() => { navigation(); letters(); });
  });
  return <View class="flex-1 p-4 gap-3">
    <View class="flex-row items-center gap-2"><Text class="flex-1 text-base font-semibold text-foreground">{props.accessibilityLabel}</Text><Button class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={options.close}><Icon name="close" size={20} /></Button></View>
    <If when={props.searchable}><Input value={search()} onChange={event => search.set(event.value)} onCompositionChange={event => composing.set(event.composing)} autoCapitalize="none" autoCorrect={false}
      accessibilityLabel={props.searchAccessibilityLabel ?? props.accessibilityLabel ?? undefined} placeholder={props.searchPlaceholder ?? props.accessibilityLabel ?? undefined} class={props.searchClass ?? 'min-h-11 px-3 rounded-xl bg-secondary text-foreground'} style={props.searchStyle} /></If>
    <List role="listbox" ref={node => { list = node; }} class={`flex-1 ${props.listClass ?? ''}`} style={props.listStyle} each={entries()} keyExtractor={item => item.value} keyboardDismissMode="interactive">
      {entry => <View>
        <If when={entry().header}><View class={props.groupClass ?? 'px-3 py-2'} style={props.groupStyle}>{props.renderGroup ? props.renderGroup({ title: entry().group! }) : <Text class="text-xs text-muted-foreground">{entry().group}</Text>}</View></If>
        <Button role="option" selected={options.value() === entry().value} disabled={entry().disabled || !options.active()} class={props.itemClass ?? 'min-h-12 px-3 rounded-xl flex-row items-center selected:bg-accent disabled:opacity-40'} style={[props.itemStyle, highlighted() === entry().value ? { backgroundColor: token('accent') } : null]}
          accessibilityLabel={entry().title} onPress={() => { if (options.active()) options.select(entry().value); }}>
          {props.renderItem ? props.renderItem(entry()) : <View class="flex-row items-center gap-2"><Text class="text-foreground flex-1">{entry().title}</Text><If when={options.value() === entry().value}><Icon name="check" size={18} /></If></View>}
        </Button>
      </View>}
    </List>
    <If when={entries().length === 0}>{props.empty ?? <Text class="text-muted-foreground">{t('commandPalette.empty.noResults')}</Text>}</If>
  </View>;
}

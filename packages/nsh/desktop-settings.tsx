import { cleanup, colorScheme, computed, effect, keymap, lifecycle, List, signal, Text, token, untracked, View, type JSX, type ListRef } from 'nsh';
import { Button, Dialog, Input, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { SETTINGS_ENTRIES, type SettingsPageID, type SettingsRoute } from './settings';
import { createSelectKeyboard } from './select-keyboard';
import { clampDesktopSettingsNavigation, createDesktopSettingsGuard, desktopSettingsDestination, desktopSettingsNavigationLimits, desktopSettingsRouteKey, desktopSettingsRows, desktopSettingsWindowLimits, type DesktopSettingsIntent, type DesktopSettingsRow } from './desktop-settings-core';

export type NativeDesktopSettingsPageContext = {
  readonly route: SettingsRoute;
  /** Read context.active in native JSX and pass it to the actual page owner;
   * do not snapshot/destructure it or substitute open. */
  readonly active: boolean;
  onNavigate: (route: SettingsRoute) => void;
  requestClose: () => void;
};
export type NativeDesktopSettingsViewProps = {
  route: SettingsRoute;
  active: boolean;
  /** Already guarded by the owner when this View is used without the Window. */
  onNavigate: (route: SettingsRoute) => void;
  onClose: () => void;
  navigationPending?: boolean;
  /** Host/editor generation: retires confirmations and remounts the page slot
   * even when the new Host uses exactly the same route/directory. */
  scopeKey?: string | number;
  /** Report anchored/non-modal pickers too; no DOM inspection or guessed state. */
  nestedPickerOpen?: boolean;
  visiblePages?: readonly SettingsPageID[];
  /** Supply a native page, optionally SettingsPage inside its owning NavStack.
   * No mobile NavStack, host loader, or GUI-plugin renderer is created here. */
  renderPage?: (context: NativeDesktopSettingsPageContext) => JSX.Element;
  children?: JSX.Element;
};
export type NativeDesktopSettingsWindowProps = Omit<NativeDesktopSettingsViewProps, 'active' | 'navigationPending'> & {
  open: boolean;
  active?: boolean;
  pending?: boolean;
  dirty?: boolean;
  /** Dirty requests fail closed without this callback. Return true only after
   * the owning editor/user has approved losing its current draft. */
  confirmDiscard?: (intent: DesktopSettingsIntent) => boolean | Promise<boolean>;
  onGuardError?: (error: unknown) => void;
};

/** Desktop SettingsWindow adapter. Only the caller's open prop closes it. */
export function NativeDesktopSettingsWindow(props: NativeDesktopSettingsWindowProps) {
  const guardPending = signal(false);
  const active = () => props.open && props.active !== false && lifecycle() === 'active';
  const snapshot = () => ({ open: props.open, active: active(), pending: props.pending === true, dirty: props.dirty === true, nestedPickerOpen: props.nestedPickerOpen === true, scopeKey: props.scopeKey, route: props.route });
  const guard = createDesktopSettingsGuard({ snapshot, confirmDiscard: intent => props.confirmDiscard?.(intent) ?? false,
    onClose: () => props.onClose(), onNavigate: route => props.onNavigate(route), onError: error => props.onGuardError?.(error), onBusy: value => guardPending.set(value) });
  let fence: string | undefined;
  effect(() => {
    const value = snapshot();
    const next = JSON.stringify([value.open, value.active, value.pending, value.nestedPickerOpen, value.scopeKey, desktopSettingsRouteKey(value.route)]);
    if (next !== fence) { fence = next; untracked(guard.invalidate); }
  });
  cleanup(guard.dispose);
  const close = () => { void guard.request({ kind: 'close' }); };
  // The popup's percentages resolve against Dialog's full native window layer.
  // Native layout owns resize; no JS windowSize cache or mobile sizing applies.
  return <Dialog testID="desktop-settings-window" backdropTestID="desktop-settings-backdrop" open={props.open} animation="fade"
    closeOnEscape={false} closeOnBackdropPress={false} closeOnSwipe={false} onCancel={close}
    backdropClass={colorScheme() === 'dark' ? 'bg-background/75' : 'bg-foreground/50'}
    class="m-auto rounded-xl border border-border overflow-hidden bg-background"
    style={{ width: `${desktopSettingsWindowLimits.widthRatio * 100}%`, height: `${desktopSettingsWindowLimits.heightRatio * 100}%`, maxWidth: desktopSettingsWindowLimits.maxWidth, maxHeight: desktopSettingsWindowLimits.maxHeight }}>
    <NativeDesktopSettingsView route={props.route} active={active()} scopeKey={props.scopeKey} nestedPickerOpen={props.nestedPickerOpen} visiblePages={props.visiblePages}
      navigationPending={props.pending || guardPending()} onClose={close} onNavigate={route => { void guard.request({ kind: 'navigate', route }); }}
      renderPage={props.renderPage}>{props.children}</NativeDesktopSettingsView>
  </Dialog>;
}

/** Native desktop split view, not the mobile SettingsHome/SettingsPage wrapper. */
export function NativeDesktopSettingsView(props: NativeDesktopSettingsViewProps) {
  const search = signal(''), focused = signal(false), composing = signal(false), highlighted = signal<string | null>(null);
  const width = signal<number>(desktopSettingsNavigationLimits.initial);
  let list: ListRef | undefined;
  const interactive = () => props.active && !props.navigationPending && !props.nestedPickerOpen;
  // A single bounded derivation per query/locale/availability, never per keystroke
  // elsewhere in the app; closed/inactive windows do not build a search catalog.
  const rows = computed(() => props.active ? desktopSettingsRows(SETTINGS_ENTRIES, search(), t, props.visiblePages) : []);
  const entries = computed(() => {
    let previous = '';
    return rows().map(row => { const heading = row.group !== previous; previous = row.group; return { ...row, heading }; });
  });
  function navigate(value: string) {
    if (!interactive()) return;
    const row = rows().find(item => item.value === value);
    if (row) props.onNavigate(desktopSettingsDestination(props.route, row.route));
  }
  const keyboard = createSelectKeyboard({ items: rows, selected: () => `page:${props.route.page}`, choose: navigate,
    focus: (value, index) => { highlighted.set(value); if (index >= 0 && focused()) list?.scrollToIndex({ index, animated: false, viewPosition: .5 }); } });
  effect(() => { rows(); untracked(keyboard.sync); });
  effect(() => {
    if (!interactive() || !focused() || composing()) return;
    cleanup(keymap.bind({ up: () => keyboard.move('up'), down: () => keyboard.move('down'), enter: keyboard.choose }, { when: 'always', repeat: true }));
  });
  const context: NativeDesktopSettingsPageContext = {
    get route() { return props.route; },
    // A picker belongs to this still-active page. Feeding its open state back
    // into page activity can dismiss it and produce a close/reopen loop.
    get active() { return props.active; },
    onNavigate: route => { if (interactive()) props.onNavigate(desktopSettingsDestination(props.route, route)); },
    requestClose: () => { if (interactive()) props.onClose(); },
  };
  const selected = (row: DesktopSettingsRow) => row.route.page === props.route.page && (row.route.target ?? '') === (props.route.target ?? '');
  const emphasized = (row: DesktopSettingsRow) => selected(row) || focused() && highlighted() === row.value;
  return <View testID="desktop-settings-view" class="flex-1 min-w-0 min-h-0 bg-background" accessibilityLabel={t('settings.window.description')}>
    <View class="flex-row items-center px-4 py-2 gap-3 border-b border-border">
      <Text class="flex-1 min-w-0 text-base font-semibold text-foreground">{t('settings.view.home.title')}</Text>
      <Button testID="desktop-settings-close" disabled={!interactive()} accessibilityLabel={t('mobile.surface.closeAria')} class="size-8 items-center justify-center rounded-lg hover:bg-accent active:bg-accent disabled:opacity-40" onPress={() => { if (interactive()) props.onClose(); }}><Icon name="close" size={18} /></Button>
    </View>
    <ResizablePanelGroup testID="desktop-settings-split" axis="horizontal" class="flex-1 min-h-0" disabled={!interactive()}
      handleClass="bg-border group-hover:bg-ring group-active:bg-ring" handleAccessibilityLabel={t('sidebar.resize.leftPanelAria')}>
      <ResizablePanel testID="desktop-settings-navigation" size={width()} minSize={desktopSettingsNavigationLimits.min} maxSize={desktopSettingsNavigationLimits.max}
        onResize={event => width.set(clampDesktopSettingsNavigation(event.size))} class="min-h-0 bg-muted">
        <View class="p-3"><Input testID="desktop-settings-search" value={search()} disabled={!interactive()} autoCapitalize="none" autoCorrect={false}
          accessibilityLabel={t('settings.view.search.placeholder')} placeholder={t('settings.view.search.placeholder')}
          onFocus={() => focused.set(true)} onBlur={() => { focused.set(false); composing.set(false); }} onCompositionChange={event => composing.set(event.composing)}
          onChange={event => search.set(event.value)} class="min-w-0 min-h-9 px-3 py-2 rounded-lg border border-border bg-background text-foreground" /></View>
        <List testID="desktop-settings-navigation-list" ref={node => { list = node; }} class="flex-1 min-h-0" contentClass="px-2 pb-4 gap-1"
          keyboardDismissMode="none" each={entries()} keyExtractor={row => row.value}>{row => <View>
          <If when={row().heading}><Text class="px-2 pt-4 pb-2 text-xs text-muted-foreground">{t(`settings.view.navigation.groups.${row().group}`)}</Text></If>
          <Button testID={`desktop-settings-${row().value}`} disabled={!interactive()} selected={selected(row())}
            accessibilityLabel={row().subtitle ? `${row().title} · ${row().subtitle}` : row().title}
            class="min-h-9 px-2 py-2 gap-1 rounded-lg hover:bg-accent active:bg-accent selected:bg-accent disabled:opacity-40"
            style={focused() && highlighted() === row().value ? { backgroundColor: token('accent') } : undefined} onPress={() => navigate(row().value)}>
            <View class="flex-row gap-2 items-center"><Icon name={SETTINGS_ENTRIES.find(entry => entry.page === row().route.page)!.icon} size={16} color={String(token(emphasized(row()) ? 'accent-foreground' : 'foreground'))} /><Text class="flex-1 min-w-0 text-sm" style={{ color: token(emphasized(row()) ? 'accent-foreground' : 'foreground') }}>{row().title}</Text></View>
            <If when={!!row().subtitle}><Text class="text-xs" style={{ color: token(emphasized(row()) ? 'accent-foreground' : 'muted-foreground') }}>{row().subtitle}</Text></If>
          </Button>
        </View>}</List>
        <If when={props.active && !rows().length}><Text testID="desktop-settings-empty" class="p-4 text-sm text-muted-foreground">{t('settings.view.search.noResults')}</Text></If>
      </ResizablePanel>
      <ResizablePanel testID="desktop-settings-content" minSize={0} class="min-w-0 min-h-0 bg-background">
        <Each of={[JSON.stringify([props.scopeKey, desktopSettingsRouteKey(props.route)])]}>{() => props.renderPage ? props.renderPage(context) : props.children}</Each>
      </ResizablePanel>
    </ResizablePanelGroup>
  </View>;
}

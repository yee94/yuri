import { cleanup, colorScheme, computed, effect, host, lifecycle, nativeComponent, platform, Scroll, signal, Text, untracked, View, type NativeComponentRef } from 'nsh';
import { Button, Tab, Tabs } from 'nsh/base';
import { t } from './i18n';
import { Icon } from './Icon';
import type { RuntimeScope } from './runtime-scope';
import { createNativeTerminalWorkspace } from './terminal';
import { createDesktopTerminalBinding, desktopTerminalRenderer } from './desktop-terminal-core';
import { nativeAppearance, nativeCodeFontSize, nativeCodeFontUnconfirmed, nativeChatTextStyle } from './appearance';
import { convertThemeToXterm } from '../ui/src/lib/terminalTheme';
import { createNativeDesktopTerminalShortcutOwner, type NativeDesktopTerminalShortcutPublisher } from './desktop-terminal-actions';
import type { NativeShortcutBinding } from './desktop-shortcuts-core';
import { createDesktopTerminalSignals } from './desktop-terminal-signals';
import { sameRuntimeScope } from './runtime-scope';

// This independent leaf hosts the fixed offline terminal document. The rest of
// the desktop remains native NSH; no Editor or general-purpose main WebView.
const Viewport = nativeComponent<{ owner: string; expectedHost: RuntimeScope; generation: number; active: boolean; inputLabel: string; configuration: object | null }, {
  terminal: Record<string, unknown>;
}>(desktopTerminalRenderer, { props: ['owner', 'expectedHost', 'generation', 'active', 'inputLabel', 'configuration'], events: ['terminal'] });

export type NativeDesktopTerminalDockProps = {
  scope: RuntimeScope; directory: string; current: () => boolean; active: boolean; expanded: boolean;
  onToggleExpanded: () => void; onClose: () => void;
  onDesktopShortcuts?: NativeDesktopTerminalShortcutPublisher;
  onOpenPreview?: (scope: RuntimeScope, directory: string, url: string, mode: 'preview' | 'external') => void | Promise<void>;
};

/** Retain this under the desktop workspace even when hidden. Height/resize and
 * expanded geometry belong exclusively to NativeDesktopWorkspace. */
export function NativeDesktopTerminalDock(props: NativeDesktopTerminalDockProps) {
  return <Each of={[props.scope]} key={scope => JSON.stringify([scope.hostID, scope.lease])}>{scope => <DesktopTerminalSurface {...props} scope={scope()} />}</Each>;
}

function DesktopTerminalSurface(props: NativeDesktopTerminalDockProps) {
  const scope = props.scope;
  const interaction = createDesktopTerminalSignals(), state = interaction.state;
  const native = signal<NativeComponentRef | null>(null);
  const keyboardRouting = signal<readonly NativeShortcutBinding[]>([]);
  let routeShortcut = (_actionId: string, _keystroke: string) => {};
  const active = computed(() => props.active && props.current() && lifecycle() === 'active');
  const binding = createDesktopTerminalBinding({ scope, current: props.current,
    call: (name, body) => host.call(name, body), changed: interaction.changed,
    shortcut: (id, stroke) => routeShortcut(id, stroke),
    createWorkspace: () => createNativeTerminalWorkspace(scope, async (authority, directory, url, mode) => {
      if (!active() || !sameRuntimeScope(scope, authority) || !props.onOpenPreview) throw new Error('terminal_preview_unavailable');
      await props.onOpenPreview(authority, directory, url, mode);
    }),
    command: (name, body) => { const view = native(); if (!view) throw new Error('native_renderer_not_mounted'); view.command(name, body); },
  });
  const workspace = computed(() => { state(); return binding.workspace(); });
  const snapshot = computed(() => workspace()?.snapshot());
  // The original controller publishes a fresh snapshot but mutates each tab in
  // place. Memoizing the tab object would hide phase/error/previewUrl changes.
  const tab = () => { const value = snapshot(); return value?.tabs.find(tab => tab.id === value.activeId); };
  const focusTarget = computed(() => active() && interaction.ready() ? snapshot()?.activeId : undefined);
  const configuration = computed(() => {
    const value = nativeAppearance.current();
    if (!value?.webTheme || value.sourceHost?.hostID !== scope.hostID || nativeCodeFontSize() === null || nativeCodeFontUnconfirmed()) return null;
    const code = nativeChatTextStyle('code');
    const palette = convertThemeToXterm(value.webTheme[colorScheme()]);
    // The shared converter appends 50 even when selection already has alpha.
    // Keep its intended inactive alpha, not an invalid ten-digit CSS hex color.
    if (/^#[0-9a-f]{8}$/i.test(palette.selectionBackground)) palette.selectionInactiveBackground = palette.selectionBackground.slice(0, 7) + '50';
    return { palette, family: value.monoFontFamily, size: code.fontSize, lineHeight: Number(code.lineHeight) / Number(code.fontSize), label: t('terminalView.viewport.inputAria') };
  });
  const actionable = computed(() => active() && interaction.ready());
  const closable = () => active() && !!workspace() && ['ready', 'failed'].includes(state().phase) && !state().inputPending;
  const mount = () => { state(); return binding.canMount() && state().error !== 'invalid_terminal_directory'; };
  effect(() => {
    const value = { active: active() && platform.desktop, directory: props.directory, scope: props.scope };
    untracked(() => binding.update(value));
  });
  effect(() => { state(); const value = snapshot(); if (value) untracked(() => binding.present(value)); });
  effect(() => { if (focusTarget()) untracked(() => binding.focus()); });
  cleanup(binding.dispose);
  const focus = () => { if (actionable()) binding.focus(); };
  const create = () => { if (actionable()) { workspace()?.controller.createTab(); focus(); } };
  const shortcuts = createNativeDesktopTerminalShortcutOwner({ current: active, ready: actionable,
    configure: bindings => keyboardRouting.set(bindings),
    focused: interaction.focused, composing: interaction.composing,
    focus, create, expand: () => props.onToggleExpanded(), cycle: direction => {
      const value = snapshot(); if (!value?.tabs.length) return;
      const index = value.tabs.findIndex(tab => tab.id === value.activeId);
      workspace()?.controller.selectTab(value.tabs[(index + direction + value.tabs.length) % value.tabs.length].id); focus();
    },
  });
  routeShortcut = shortcuts.dispatch;
  effect(() => {
    const value = keyboardRouting(), view = native(), generation = interaction.generation();
    if (!view || !actionable()) return;
    untracked(() => view.command('shortcuts', { owner: binding.owner, generation, expectedHost: scope, bindings: value }));
  });
  cleanup(shortcuts.retire);
  effect(() => {
    const publisher = props.onDesktopShortcuts;
    if (!platform.desktop || !active() || !publisher) return;
    untracked(() => publisher({ type: 'register', owner: shortcuts.owner }));
    cleanup(() => publisher({ type: 'retire', owner: shortcuts.owner }));
  });
  const error = () => state().error ?? tab()?.error ?? (snapshot()?.persistenceError ? 'catalog_write_failed' : undefined);
  return <View testID="native-desktop-terminal-dock" class="flex-1 bg-background border-t border-border/30">
    <View class="min-h-10 flex-row items-center border-b border-border/30">
      <Scroll horizontal class="flex-1"><Tabs testID="desktop-terminal-tabs" class="flex-row items-center">
        <Each of={snapshot()?.tabs ?? []} key={tab => tab.id}>{(item, index) => <View class="flex-row items-center border-r border-border/30" classList={{ 'bg-accent': snapshot()?.activeId === item().id }}>
          <Tab testID={`desktop-terminal-tab-${item().id}`} class="min-h-9 px-2 flex-row items-center gap-1.5 hover:bg-accent" selected={snapshot()?.activeId === item().id} disabled={!actionable()}
            onPress={() => { if (actionable()) { workspace()?.controller.selectTab(item().id); focus(); } }}>
            <Icon name="terminal" size={14} /><Text class="text-xs text-foreground" style={{ maxWidth: 180, numberOfLines: 1 }}>{item().label || `${t('layout.mainTab.terminal')} ${index() + 1}`}</Text>
          </Tab>
          <Button testID={`desktop-terminal-close-${item().id}`} class="h-7 w-7 items-center justify-center rounded-md hover:bg-accent" disabled={!closable() || item().phase === 'closing'} accessibilityLabel={t('terminalView.tabs.closeTabTitle')}
            onPress={() => { if (closable()) void binding.closeTab(item().id).then(focus); }}><Icon name="close" size={12} /></Button>
        </View>}</Each>
      </Tabs></Scroll>
      <Button testID="desktop-terminal-new" disabled={!actionable()} accessibilityLabel={t('terminalView.tabs.newTabTitle')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={create}><Icon name="add" size={16} /></Button>
      <If when={!!tab()?.previewUrl}><Button testID="desktop-terminal-preview" disabled={!actionable() || !props.onOpenPreview} accessibilityLabel={t('terminalView.preview.openTitle')} onPress={() => { const id = snapshot()?.activeId; if (actionable() && id) void workspace()?.controller.openPreview(id); }}><Icon name="global" size={14} /><Text class="text-xs text-foreground">{t('terminalView.preview.open')}</Text></Button></If>
      <Button testID="desktop-terminal-focus" disabled={!actionable()} accessibilityLabel={t('terminalView.viewport.inputAria')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={focus}><Icon name="keyboard" size={16} /></Button>
      <Button testID="desktop-terminal-expand" disabled={!active()} accessibilityLabel={t(props.expanded ? 'terminalView.bottomDock.restoreAria' : 'terminalView.bottomDock.expandAria')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => { if (active()) props.onToggleExpanded(); }}><Icon name={props.expanded ? 'collapse-diagonal' : 'expand-diagonal'} size={16} /></Button>
      <Button testID="desktop-terminal-hide" disabled={!active()} accessibilityLabel={t('terminalView.bottomDock.closeAria')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => { if (active()) props.onClose(); }}><Icon name="close" size={16} /></Button>
    </View>
    <If when={!!error()}><View testID="desktop-terminal-error" role="alert" class="flex-row items-center gap-2 px-3 py-2">
      <Text class="text-xs text-destructive flex-1">{t('terminalView.error.connectionFailed', { message: error()! })}</Text>
      <Button testID="desktop-terminal-retry" disabled={!active() || error() === 'input_unknown' || !!state().inputPending} onPress={() => binding.retry()}><Text class="text-foreground text-xs">{t('terminalView.actions.retry')}</Text></Button>
    </View></If>
    <If when={['failed', 'exited'].includes(tab()?.phase ?? '')}><Button testID="desktop-terminal-restart" disabled={!actionable() || !!state().inputPending} onPress={() => { if (actionable()) void binding.restart().then(focus); }}><Text class="text-foreground text-xs">{t('terminalView.actions.hardRestart')}</Text></Button></If>
    <View class="flex-1 overflow-hidden">
      <Each of={mount() ? [state().generation] : []} key={generation => generation}>{generation => <Viewport testID="desktop-terminal-viewport" class="flex-1" owner={binding.owner} expectedHost={scope} generation={generation()} active={actionable()} inputLabel={t('terminalView.viewport.inputAria')} configuration={configuration()}
        ref={value => native.set(value)} onLayout={event => { if (props.current()) native()?.command('layout', { owner: binding.owner, expectedHost: scope, generation: generation(), ...event.bounds.size }); }} onTerminal={event => { void binding.event(event); }} />}</Each>
      <If when={state().phase === 'unavailable' || state().phase === 'retired' || !platform.desktop}><Text testID="desktop-terminal-unavailable" class="p-3 text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
    </View>
  </View>;
}

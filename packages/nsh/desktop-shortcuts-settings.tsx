import { cleanup, computed, effect, keymap, platform, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { dict, type I18nKey } from '../ui/src/lib/i18n/messages/en';
import { UNASSIGNED_SHORTCUT } from '../ui/src/lib/shortcuts-core';
import { t } from './i18n';
import { SettingsGroup, settingsAction, settingsField } from './settings-controls';
import { publishSettingsEditor, publishSettingsPicker } from './desktop-settings-publisher';
import {
  nativeShortcutActionCombos, nativeShortcutConflicts, nativeShortcutKeystroke, nativeShortcutRegistry,
  type DesktopShortcutPreferences, type NativeShortcutActions, type NativeShortcutCapture,
} from './desktop-shortcuts-core';

export function nativeShortcutActionLabel(id: string): string {
  const key = `settings.yuri.keyboardShortcuts.action.${id}.label`;
  if (key in dict) return t(key as I18nKey);
  if (id === 'leader_key') return t('helpDialog.section.leaderChords');
  if (id === 'open_agent_selector') return t('helpDialog.item.leaderOpenAgent');
  if (id === 'toggle_dictation') return t('chat.dictation.start');
  return id;
}

export type DesktopShortcutsSettingsProps = {
  preferences: DesktopShortcutPreferences;
  actions: () => NativeShortcutActions;
  /** Share this exact capture identity with installNativeDesktopShortcuts. */
  capture: () => NativeShortcutCapture | null;
  onCaptureChange: (value: NativeShortcutCapture | null) => void;
  active?: boolean;
};

/** Embeddable content only; routing/settings-open admission belongs to the root. */
export function DesktopShortcutsSettings(props: DesktopShortcutsSettingsProps) {
  const apple = platform.os === 'macos' || platform.os === 'ios';
  const state = signal(props.preferences.state()), filter = signal(''), drafts = signal<Record<string, string>>({});
  const pending = signal<{ id: string; combo?: string; reset?: boolean; conflicts: readonly string[] } | null>(null);
  let ownCapture: NativeShortcutCapture | null = null;
  const unsubscribe = props.preferences.subscribe(value => state.set(value));
  void props.preferences.load();
  publishSettingsEditor({ current: () => props.active !== false, scope: () => props.preferences, pending: () => state().busy,
    dirty: () => !!pending() || Object.entries(drafts()).some(([id, combo]) => combo !== (nativeShortcutActionCombos(id, state().overrides)[0] ?? UNASSIGNED_SHORTCUT)),
    stamp: () => [drafts(), pending()],
  });
  publishSettingsPicker(() => !!props.capture());
  function stopCapture() {
    if (ownCapture && props.capture() === ownCapture) props.onCaptureChange(null);
    ownCapture = null;
  }
  effect(() => { if (props.active === false) untracked(stopCapture); });
  cleanup(() => { unsubscribe(); stopCapture(); });
  const rows = computed(() => nativeShortcutRegistry(props.actions(), state().overrides).filter(action => action.customizable));
  effect(() => {
    const captured = props.capture();
    if (captured && captured === ownCapture && !rows().some(action => action.id === captured.actionId && action.supported)) untracked(stopCapture);
  });
  const visible = computed(() => rows().filter(action => nativeShortcutActionLabel(action.id).toLocaleLowerCase().includes(filter().trim().toLocaleLowerCase())));
  const disabled = () => props.active === false || !state().ready || state().busy || !!state().error;
  function capture(id: string) {
    if (disabled() || !rows().some(action => action.id === id && action.supported)) return;
    stopCapture(); pending.set(null);
    ownCapture = { actionId: id, onCapture: combo => {
      if (props.capture() !== ownCapture) return;
      if (!disabled() && combo !== null && rows().some(action => action.id === id && action.supported)) drafts.set({ ...drafts(), [id]: combo });
      stopCapture();
    } };
    props.onCaptureChange(ownCapture);
  }
  async function save(id: string, reset = false, overwrite = false) {
    if (disabled() || !rows().some(action => action.id === id && action.supported)) return;
    stopCapture();
    const combo = drafts()[id];
    if (!reset && !combo) return;
    const next = { ...state().overrides };
    if (reset) delete next[id]; else next[id] = combo!;
    const candidates = nativeShortcutActionCombos(id, next);
    const conflicts = [...new Set(candidates.flatMap(value => nativeShortcutConflicts(id, value, next, apple)))];
    if (conflicts.length && !overwrite) { pending.set({ id, combo, reset, conflicts }); return; }
    const success = reset ? await props.preferences.reset(id, overwrite, apple) : await props.preferences.set(id, combo!, overwrite, apple);
    if (success) { const rest = { ...drafts() }; delete rest[id]; drafts.set(rest); pending.set(null); }
  }
  const label = (combo: string) => {
    const native = nativeShortcutKeystroke(combo, apple);
    return native ? keymap.label(native) : '—';
  };
  return <Scroll testID="desktop-shortcuts-settings" class="flex-1 bg-background" contentClass="p-5 gap-4 pb-10">
    <SettingsGroup title={t('settings.yuri.keyboardShortcuts.title')}>
      <View class="flex-row items-center gap-3">
        <Input testID="desktop-shortcuts-filter" class={`flex-1 ${settingsField}`} value={filter()} onFocus={stopCapture} onChange={event => filter.set(event.value)} placeholder={t('settings.view.search.placeholder')} accessibilityLabel={t('settings.view.search.placeholder')} />
        <Button testID="desktop-shortcuts-reset-all" class={settingsAction} disabled={disabled()} onPress={async () => {
          stopCapture(); if (await props.preferences.reset()) { drafts.set({}); pending.set(null); }
        }}><Text class="text-foreground">{t('settings.yuri.keyboardShortcuts.actions.resetAll')}</Text></Button>
      </View>
      <If when={state().busy}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!state().error}><View class="gap-2">
        <Text class="text-sm text-destructive">{t(state().error === 'load' ? 'settings.yuri.desktopNetwork.error.loadFailed' : 'settings.yuri.desktopNetwork.error.saveFailed')}</Text>
        <Button testID="desktop-shortcuts-retry" class={settingsAction} disabled={state().busy} onPress={() => { void props.preferences.retry(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button>
      </View></If>
      <If when={!!pending()}><View class="gap-2">
        <Text class="text-sm text-foreground">{t('settings.yuri.keyboardShortcuts.overwritePrompt')}</Text>
        <Each of={pending()?.conflicts ?? []}>{id => <Text class="text-xs text-muted-foreground">{nativeShortcutActionLabel(id())}</Text>}</Each>
        <View class="flex-row gap-2"><Button testID="desktop-shortcuts-overwrite" class={settingsAction} disabled={disabled()} onPress={() => { const value = pending(); if (value) void save(value.id, value.reset, true); }}><Text class="text-foreground">{t('settings.yuri.keyboardShortcuts.actions.overwrite')}</Text></Button>
          <Button class={settingsAction} disabled={state().busy} onPress={() => pending.set(null)}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button></View>
      </View></If>
      <Each of={visible()}>{action => <View testID={`desktop-shortcut-row-${action().id}`} class="gap-2 py-2">
        <View class="flex-row items-center gap-3"><Text class="flex-1 text-sm text-foreground">{nativeShortcutActionLabel(action().id)}</Text>
          <If when={!action().supported}><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></If>
        </View>
        <View class="flex-row items-center gap-2">
          <Button testID={`desktop-shortcut-capture-${action().id}`} class={`flex-1 ${settingsAction}`} disabled={disabled() || !action().supported} onPress={() => capture(action().id)}>
            <Text class="text-foreground">{props.capture()?.actionId === action().id ? t('settings.yuri.keyboardShortcuts.field.pressKeys') : label(drafts()[action().id] ?? action().combos[0] ?? UNASSIGNED_SHORTCUT)}</Text>
          </Button>
          <Button testID={`desktop-shortcut-save-${action().id}`} class={settingsAction} disabled={disabled() || !action().supported || !drafts()[action().id]} onPress={() => { void save(action().id); }}><Text class="text-foreground">{t('settings.common.actions.saveChanges')}</Text></Button>
          <Button testID={`desktop-shortcut-reset-${action().id}`} class={settingsAction} disabled={disabled() || !action().supported} onPress={() => { void save(action().id, true); }}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button>
        </View>
      </View>}</Each>
    </SettingsGroup>
  </Scroll>;
}

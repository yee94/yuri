import { Scroll, signal, Storage, Text, type ScrollRef } from 'nsh';
import { Button } from 'nsh/base';
import { language, t } from './i18n';
import { text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { nativeAppearance, refreshNativeAppearance, saveNativeAppearanceMode } from './appearance';
import { nativeAppearanceModeFromSettings } from './appearance-core';
import { settingsObject, settingsRows } from './settings-protocol';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsPreferenceFields, settingsPreferencePatch } from './settings-preferences-core';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT } from '../ui/src/lib/fontOptions';
import { themes } from '../ui/src/lib/theme/themes';
import { isValidTheme } from '../ui/src/contexts/theme-validation';
import type { Theme } from '../ui/src/types/theme';

export function SettingsPreferences(props: SettingsCallbacks & SettingsRoute) {
  const state = settingsPageLifetime(), settings = signal<Row>({}), changes = signal<Row>({});

  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const customThemes = signal<Theme[]>([]), themeError = signal(''), themeBusy = signal(false);
  const fields = settingsPreferenceFields.filter(field => field.page === props.page);
  const initial = (key: string) => settings()[key] ?? settingsPreferenceFields.find(field => field.key === key)?.initial;
  const value = (key: string) => key in changes() ? changes()[key] : initial(key);
  const disabled = () => state.busy() || !state.ready();
  function update(key: string, next: unknown) { changes.set({ ...changes(), [key]: next }); }
  async function loadThemes(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (themeBusy() || !operation.current()) return;
    themeBusy.set(true); themeError.set('');
    try {
      const result = settingsObject(await operation.request('/api/config/themes'));
      const rows: unknown[] = settingsRows(result.themes);
      const valid = rows.filter(isValidTheme);
      if (valid.length !== rows.length) throw new Error('Invalid theme catalog');
      if (operation.current()) customThemes.set(valid);
    } catch { if (operation.current()) themeError.set(t('common.unavailable')); }
    finally { if (operation.current()) themeBusy.set(false); }
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const result = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      settings.set(result); state.ready.set(true);
    }, operation);
    if (props.page === 'appearance' && state.ready()) await loadThemes(operation);
  }
  void load();
  state.observeOperation(operation => { themeBusy.set(false); if (operation) void load(operation); });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      let patch: Row;
      try { patch = settingsPreferencePatch(changes()); }
      catch (failure) {
        const field = fields.find(item => item.key === (failure instanceof Error ? failure.message : ''));
        throw new Error(`${field ? t(field.title) : t('common.unavailable')}${field?.kind === 'number' ? `: ${field.min}–${field.max}` : ''}`);
      }
      if (!Object.keys(patch).length) return;
      await operation.transaction('/api/config/settings', 'PUT', patch);
      // The write is committed. A failed native refresh must not replay it or erase the draft.
      if (!operation.current()) return;
      settings.set({ ...settings(), ...patch }); changes.set({});
      const confirmed = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      settings.set(confirmed);
      await refreshNativeAppearance();
      if (operation.current()) state.notice.set(t('filesView.editor.saved'));
    }, operation);
  }
  const themeItems = (variant: 'light' | 'dark') => [...new Map([...themes, ...customThemes()].map(theme => [theme.metadata.id, theme])).values()].filter(theme => theme.metadata.variant === variant).map(theme => ({ value: theme.metadata.id, title: theme.metadata.name }));
  const themeValue = (variant: 'light' | 'dark') => nativeAppearance.current()?.themeIDs[variant] || text(settings()[variant === 'light' ? 'lightThemeId' : 'darkThemeId']);
  async function selectTheme(variant: 'light' | 'dark', id: string, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      if (!themeItems(variant).some(item => item.value === id)) return;
      const current = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      const patch = { [variant === 'light' ? 'lightThemeId' : 'darkThemeId']: id, ...(nativeAppearanceModeFromSettings(current) === variant ? { themeId: id, themeVariant: variant } : {}) };
      await operation.transaction('/api/config/settings', 'PUT', patch);
      if (!operation.current()) return;
      settings.set({ ...settings(), ...patch });
      await refreshNativeAppearance();
      if (operation.current()) state.notice.set(t('filesView.editor.saved'));
    }, operation);
  }
  const special = props.page === 'appearance' ? ['appearance.theme-mode', 'appearance.light-theme', 'appearance.dark-theme', 'appearance.language'] : [];
  const ordered = [...special, ...fields.map(field => field.id)];
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!!nativeAppearance.error()}><Text class="text-sm text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text><Button class={settingsAction} disabled={state.busy()} onPress={() => { void refreshNativeAppearance(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
    <If when={state.ready()}><Each of={ordered}>{id => <SettingsTarget id={id()} target={props.target} onReveal={node => { void navigation.reveal(node); }}>
      <If when={id() === 'appearance.theme-mode'}><SettingsGroup title={t('settings.yuri.visual.section.colorMode')}><SettingsChoice title={t('settings.yuri.visual.field.themeMode')} value={nativeAppearance.current()?.mode ?? nativeAppearanceModeFromSettings(settings())} disabled={disabled() || nativeAppearance.saving()} items={(['system', 'light', 'dark'] as const).map(value => ({ value, title: t(`settings.yuri.visual.option.themeMode.${value}`) }))} onChange={next => { void state.perform(async (operation) => {
        if (next !== 'system' && next !== 'light' && next !== 'dark') return;
        await saveNativeAppearanceMode(next, operation.current, operation.request);
        if (operation.current()) props.onAppearanceChange?.(next);
      }); }} /></SettingsGroup></If>
      <If when={id() === 'appearance.language'}><SettingsGroup title={t('settings.appearance.language.label')}><SettingsChoice title={t('settings.appearance.language.select')} value={language()} items={[{ value: 'system', title: t('settings.yuri.visual.option.themeMode.system') }, { value: 'en', title: 'English' }, { value: 'zh-CN', title: '简体中文' }, { value: 'zh-TW', title: '繁體中文' }, { value: 'ja', title: '日本語' }, { value: 'ko', title: '한국어' }, { value: 'fr', title: 'Français' }, { value: 'es', title: 'Español' }, { value: 'pl', title: 'Polski' }, { value: 'pt-BR', title: 'Português (Brasil)' }, { value: 'uk', title: 'Українська' }]} onChange={next => { void state.perform(async (operation) => { await Storage.setItem('language', next); if (operation.current()) language.set(next); }); }} /></SettingsGroup></If>
      <If when={id() === 'appearance.light-theme' || id() === 'appearance.dark-theme'}><SettingsGroup title={t(id() === 'appearance.light-theme' ? 'settings.yuri.visual.field.lightTheme' : 'settings.yuri.visual.field.darkTheme')}>
        <SettingsChoice title={t(id() === 'appearance.light-theme' ? 'settings.yuri.visual.field.lightTheme' : 'settings.yuri.visual.field.darkTheme')} value={themeValue(id() === 'appearance.light-theme' ? 'light' : 'dark')} items={themeItems(id() === 'appearance.light-theme' ? 'light' : 'dark')} disabled={disabled() || themeBusy() || nativeAppearance.saving()} onChange={next => { void selectTheme(id() === 'appearance.light-theme' ? 'light' : 'dark', next); }} />
        <If when={!!themeError()}><Text class="text-sm text-destructive">{themeError()}</Text></If>
        <Button class={settingsAction} disabled={themeBusy()} onPress={() => { void loadThemes(); }}><Text class="text-foreground">{t('settings.yuri.visual.actions.reloadThemes')}</Text></Button>
      </SettingsGroup></If>
      <Each of={fields.filter(field => field.id === id())}>{field => <SettingsGroup title={t(field().title)}>
        <If when={field().consumer === 'host-runtime'}><Text class="text-xs text-muted-foreground">{t('settings.gitIdentities.editor.field.host')}</Text></If>
        <If when={field().consumer === 'host-only' || field().consumer === 'unconnected'}><Text class="text-xs text-muted-foreground">{t('settings.yuri.visual.field.iosNativeUi')} · {t('common.unavailable')}</Text></If>
        <If when={field().local}><Text class="text-sm text-muted-foreground">{t('settings.view.unavailable.description')}</Text></If>
        <If when={!field().local}>
          <If when={field().kind === 'boolean'}><SettingsToggle testID={`settings-preference-${field().key}`} title={t(field().title)} value={value(field().key) === true} disabled={disabled()} onChange={next => update(field().key, next)} /></If>
          <If when={!!field().options || field().key === 'monoFont'}><SettingsChoice title={t(field().title)} value={text(value(field().key)) || (field().key === 'monoFont' ? DEFAULT_MONO_FONT : '')} items={field().key === 'monoFont' ? CODE_FONT_OPTIONS.map(option => ({ value: option.id, title: option.label })) : (field().options || []).map(option => ({ value: option.value, title: t(option.title) }))} disabled={disabled()} onChange={next => update(field().key, next)} /></If>
          <If when={field().kind !== 'boolean' && !field().options && field().key !== 'monoFont'}><SettingsInput testID={`settings-basics-${field().key}`} title={t(field().title) + (field().kind === 'number' ? ` (${field().min}–${field().max})` : '')} value={value(field().key) === undefined ? '' : String(value(field().key))} disabled={disabled()} onChange={next => update(field().key, next)} /></If>
          <If when={field().page === 'appearance' && (field().kind === 'number' || field().key === 'monoFont')}><Button class={settingsAction} disabled={disabled()} onPress={() => update(field().key, field().key === 'monoFont' ? DEFAULT_MONO_FONT : field().initial)}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button></If>
        </If>
      </SettingsGroup>}</Each>
    </SettingsTarget>}</Each>
    <Button testID="settings-preferences-save" class={settingsAction} disabled={disabled() || !Object.keys(changes()).length} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')} · {t('settings.gitIdentities.editor.field.host')}</Text></Button></If>
  </Scroll>;
}

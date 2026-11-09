import { platform, Scroll, signal, Storage, Text, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { language, t } from './i18n';
import { text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { nativeAppearance, nativeCodeFontSize, nativeCodeFontUnconfirmed, loadNativeCodeFontSize, saveNativeCodeFontSize, refreshNativeAppearance, saveNativeAppearanceMode } from './appearance';
import { nativeAppearanceModeFromSettings } from './appearance-core';
import { settingsObject, settingsRows } from './settings-protocol';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsCodeFontSize, settingsPreferenceAvailable, settingsPreferenceFields, settingsPreferencePatch, settingsPreferenceVisible } from './settings-preferences-core';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, UI_FONT_OPTIONS, DEFAULT_UI_FONT } from '../ui/src/lib/fontOptions';
import { themes } from '../ui/src/lib/theme/themes';
import { isValidTheme } from '../ui/src/contexts/theme-validation';
import type { Theme } from '../ui/src/types/theme';
import { publishSettingsNavigationOwner } from './desktop-settings-publisher';
import { nativeDesktopDiffPreferences } from './desktop-diff-preferences';
import { desktopDiffLayoutPreference } from './desktop-diff-preferences-core';

export function SettingsPreferences(props: SettingsCallbacks & SettingsRoute & { codeTypographyReady?: boolean }) {
  const state = settingsPageLifetime(), settings = signal<Row>({}), changes = signal<Row>({});

  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const customThemes = signal<Theme[]>([]), themeError = signal(''), themeBusy = signal(false);
  const confirming = signal(false);
  const fields = settingsPreferenceFields.filter(field => field.page === props.page && settingsPreferenceVisible(field.key, platform.os));
  const diffPreferences = () => platform.desktop ? nativeDesktopDiffPreferences() : null;
  const available = (key: string) => settingsPreferenceAvailable(key, platform.os, props.codeTypographyReady, diffPreferences()?.available());
  const fontOptions = (key: string) => key === 'uiFont' ? UI_FONT_OPTIONS : key === 'monoFont' ? CODE_FONT_OPTIONS : undefined;
  const defaultFont = (key: string) => key === 'uiFont' ? DEFAULT_UI_FONT : DEFAULT_MONO_FONT;
  const initial = (key: string) => key === 'codeFontSize' ? nativeCodeFontSize() : key === 'diffLayoutPreference' ? diffPreferences()?.state().value.layoutPreference ?? 'inline' : settings()[key] ?? settingsPreferenceFields.find(field => field.key === key)?.initial;
  const value = (key: string) => key in changes() ? changes()[key] : initial(key);
  const disabled = () => state.busy() || !state.ready() || confirming() || platform.desktop && nativeCodeFontUnconfirmed();
  const pending = () => state.busy() || themeBusy() || nativeAppearance.saving() || platform.desktop && nativeCodeFontUnconfirmed() || props.page === 'chat' && !!diffPreferences() && (diffPreferences()!.state().writing || diffPreferences()!.state().error === 'unknown');
  function dirty() {
    try { return Object.entries(changes()).some(([key, next]) => !Object.is(key === 'codeFontSize' ? settingsCodeFontSize(next) : key === 'diffLayoutPreference' ? desktopDiffLayoutPreference(next) : settingsPreferencePatch({ [key]: next })[key], initial(key))); }
    catch { return Object.keys(changes()).length > 0; }
  }
  async function requestLeave(): Promise<boolean> {
    if (confirming() || pending()) return false;
    if (!dirty()) return true;
    const operation = state.operation(), captured = changes();
    if (!operation?.current()) return false;
    confirming.set(true);
    try {
      const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      ] });
      return answer.action === 'discard' && operation.current() && changes() === captured && !pending();
    } finally { confirming.set(false); }
  }
  publishSettingsNavigationOwner({ dirty, pending, nestedPickerOpen: () => false, requestLeave, stamp: () => [changes(), settings(), state.operation()], scope: state.operation });
  function update(key: string, next: unknown) { if (available(key) && !disabled()) changes.set({ ...changes(), [key]: next }); }
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
      if (props.page === 'appearance' && platform.desktop) await loadNativeCodeFontSize();
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
      const draft = changes();
      let localCodeSize: number | undefined;
      let localDiffLayout: ReturnType<typeof desktopDiffLayoutPreference> | undefined;
      try {
        for (const key of Object.keys(draft)) if (!available(key)) throw new Error(key);
        patch = settingsPreferencePatch(Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'codeFontSize' && key !== 'diffLayoutPreference')));
        if ('codeFontSize' in draft) localCodeSize = settingsCodeFontSize(draft.codeFontSize);
        if ('diffLayoutPreference' in draft) localDiffLayout = desktopDiffLayoutPreference(draft.diffLayoutPreference);
      }
      catch (failure) {
        const field = fields.find(item => item.key === (failure instanceof Error ? failure.message : ''));
        throw new Error(`${field ? t(field.title) : t('common.unavailable')}${field?.kind === 'number' ? `: ${field.min}–${field.max}` : ''}`);
      }
      if (localCodeSize !== undefined) {
        await saveNativeCodeFontSize(localCodeSize);
        if (!operation.current()) return;
        const { codeFontSize: _saved, ...remaining } = changes(); changes.set(remaining);
      }
      if (localDiffLayout !== undefined) {
        const owner = diffPreferences();
        if (!owner || !await owner.save({ layoutPreference: localDiffLayout })) throw new Error(t('filesView.toast.saveFailed'));
        if (!operation.current()) return;
        const { diffLayoutPreference: _saved, ...remaining } = changes(); changes.set(remaining);
      }
      if (!Object.keys(patch).length) { state.notice.set(t('filesView.editor.saved')); return; }
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
    <SettingsFeedback state={state} retry={props.page === 'chat' && !!diffPreferences()?.state().error ? undefined : () => { void load(); }} />
    <If when={props.page === 'chat' && !!diffPreferences()?.state().error}><Text testID="settings-diff-preferences-error" class="text-sm text-destructive">{t('common.unavailable')}</Text><Button testID="settings-diff-preferences-retry" class={settingsAction} disabled={state.busy() || diffPreferences()?.state().writing || diffPreferences()?.state().error === 'unsupported' || diffPreferences()?.state().error === 'conflict'} onPress={() => { void state.perform(async () => { if (!await diffPreferences()?.retry()) throw new Error(t('filesView.toast.saveFailed')); }); }}><Text>{t('diffView.actions.retry')}</Text></Button></If>
    <If when={!!nativeAppearance.error()}><Text class="text-sm text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text><Button class={settingsAction} disabled={state.busy()} onPress={() => { void refreshNativeAppearance(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
    <If when={props.page === 'appearance' && !!nativeAppearance.current()?.unsupportedFonts.length}><Text class="text-sm text-muted-foreground">{t('common.unavailable')}: {nativeAppearance.current()?.unsupportedFonts.join(', ')}</Text></If>
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
        <If when={!available(field().key)}><Text class="text-xs text-muted-foreground">{t('settings.view.unavailable.description')}</Text></If>
        <If when={field().kind === 'boolean'}><SettingsToggle testID={`settings-preference-${field().key}`} title={t(field().title)} value={value(field().key) === true} disabled={disabled() || !available(field().key)} onChange={next => update(field().key, next)} /></If>
        <If when={!!field().options || !!fontOptions(field().key)}><SettingsChoice testID={`settings-preference-${field().key}`} title={t(field().title)} value={text(value(field().key)) || (fontOptions(field().key) ? defaultFont(field().key) : '')} items={fontOptions(field().key)?.map(option => ({ value: option.id, title: option.id === 'system' || option.id === 'system-mono' ? t('settings.yuri.visual.option.themeMode.system') : option.label })) ?? (field().options || []).map(option => ({ value: option.value, title: t(option.title) }))} disabled={disabled() || !available(field().key)} onChange={next => update(field().key, next)} /></If>
        <If when={field().kind !== 'boolean' && !field().options && !fontOptions(field().key)}><SettingsInput testID={`settings-basics-${field().key}`} title={t(field().title) + (field().kind === 'number' ? ` (${field().min}–${field().max})` : '')} value={value(field().key) == null ? '' : String(value(field().key))} disabled={disabled() || !available(field().key)} onChange={next => update(field().key, next)} /></If>
        <If when={available(field().key) && field().page === 'appearance' && (field().kind === 'number' || !!fontOptions(field().key))}><Button class={settingsAction} disabled={disabled()} onPress={() => update(field().key, fontOptions(field().key) ? defaultFont(field().key) : field().initial)}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button></If>
      </SettingsGroup>}</Each>
    </SettingsTarget>}</Each>
    <Button testID="settings-preferences-save" class={settingsAction} disabled={disabled() || !dirty()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button></If>
  </Scroll>;
}

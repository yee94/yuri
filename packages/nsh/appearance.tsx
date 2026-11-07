import { cleanup, colorScheme, effect, host, lifecycle, setColorScheme, signal, untracked, type TextStyle, type ViewStyle } from 'nsh';
import type { SemanticTypographyKey } from '../ui/src/lib/typography';
import { app, captureHostRequest, epoch } from './state';
import { native } from './runtime';
import { runtimeEventFrom } from './model';
import { createNativeAppearanceSync, appearanceFromSettings, nativeAppearanceModePatch, nativeTypographyStyle, nativeFullThemeCSS, type AppliedNativeAppearance, type NativeAppearanceMode, type NativeTimeFormatPreference } from './appearance-core';
import type { Theme } from '../ui/src/types/theme';
import { settingsObject } from './settings-protocol';
import { t } from './i18n';

export const nativeAppearance = {
  current: signal<AppliedNativeAppearance | null>(null),
  error: signal(''),
  saving: signal(false),
};
let refreshAppearance: (() => Promise<void>) | undefined;
let activeSync: ReturnType<typeof createNativeAppearanceSync> | undefined;
let writeRevision = 0;
let mounted = false;
export const refreshNativeAppearance = () => refreshAppearance?.() ?? Promise.resolve();
/** Missing/unrecognized Host field is unknown; the formatter may explicitly choose locale-auto with `?? 'auto'`. */
export const nativeTimeFormat = (): NativeTimeFormatPreference | null => nativeAppearance.current()?.timeFormatPreference ?? null;
/** Read-only JS palette from the same Host snapshot; deliberately not part of the Swift override schema. */
export const nativeAgentPaletteTokens = (): Readonly<Record<string, string>> => nativeAppearance.current()?.agentAvatarTokens[colorScheme()] ?? {};
export const nativeToolPaletteTokens = () => nativeAppearance.current()?.toolTokens[colorScheme()];
/** Pure read of the already applied canonical appearance; no preview GET or Host write. */
export const nativeGuiThemeCSS = (generate: (theme: Theme) => string): string => nativeFullThemeCSS(nativeAppearance.current(), colorScheme(), generate);

/** User-triggered canonical Host mutation; legacy local Storage `appearance` is deliberately not an input. */
export async function saveNativeAppearanceMode(mode: NativeAppearanceMode, isCurrent: () => boolean, request?: ReturnType<typeof captureHostRequest>): Promise<void> {
  if (!['light', 'dark', 'system'].includes(mode) || nativeAppearance.saving()) throw new Error(t('chat.chatInput.toast.reloadFailed'));
  const connection = app.connection()?.id, captured = epoch(), sync = activeSync;
  if (!request) throw new Error(t('chat.chatInput.toast.reloadFailed'));
  const operation = ++writeRevision;
  const current = () => operation === writeRevision && isCurrent() && captured === epoch() && connection === app.connection()?.id && lifecycle() === 'active';
  if (!current()) throw new Error(t('chat.chatInput.toast.reloadFailed'));
  nativeAppearance.saving.set(true);
  let failed = false;
  try {
    await sync?.hold();
    if (!current()) return;
    const settings = settingsObject(await request('/api/config/settings'));
    if (!current()) return;
    const themes = () => request('/api/config/themes');
    const before = await appearanceFromSettings(settings, themes);
    if (!current()) return;
    const patch = nativeAppearanceModePatch(before, mode, nativeAppearance.current()?.systemColorScheme ?? colorScheme());
    // Validate the newly selected palette before changing the canonical Host preference.
    await appearanceFromSettings({ ...settings, ...patch }, themes);
    if (!current()) return;
    settingsObject(await request('/api/config/settings', 'PUT', patch));
    if (!current()) return;
  } catch {
    failed = current();
  } finally {
    if (current()) {
      sync?.resume();
      await sync?.refresh();
      if (failed) nativeAppearance.error.set('Native appearance update failed');
    }
    if (operation === writeRevision) nativeAppearance.saving.set(false);
  }
  if (failed || current() && !!nativeAppearance.error()) throw new Error(t('chat.chatInput.toast.reloadFailed'));
}

/** Mount exactly once at the application root; never under chat or token consumers. */
export function NativeAppearanceSync() {
  if (mounted) throw new Error('NativeAppearanceSync already mounted');
  mounted = true;
  const createSync = (request: ReturnType<typeof captureHostRequest>) => createNativeAppearanceSync({
    readSettings: () => request('/api/config/settings'),
    readThemes: () => request('/api/config/themes'),
    reset: async scope => {
      const result = await native<{ revision: number }>('appearance.reset', { hostID: scope?.hostID ?? null });
      return result.revision;
    },
    apply: (scope, revision, appearance) => native('appearance.apply', {
      hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts,
    }),
    changed: value => {
      nativeAppearance.current.set(value);
      setColorScheme(value?.mode ?? 'system');
    },
    failed: message => nativeAppearance.error.set(message),
  });
  refreshAppearance = () => activeSync?.refresh() ?? Promise.resolve();
  const stopErrors = host.on('appearance.error', () => nativeAppearance.error.set('Native appearance reset failed'));
  let scopeKey: string | undefined;
  effect(() => {
    const connection = app.connection(), active = lifecycle() === 'active';
    const scope = connection ? { hostID: connection.id, url: connection.url, generation: epoch() } : null;
    untracked(() => {
      const nextKey = JSON.stringify(scope);
      if (scopeKey !== nextKey) {
        scopeKey = nextKey; writeRevision++; nativeAppearance.saving.set(false);
        activeSync?.pause();
        activeSync = createSync(captureHostRequest());
        activeSync.setScope(scope);
      }
      else if (active) activeSync?.rebind();
      if (!active) activeSync?.pause();
    });
    const sync = activeSync;
    if (!active || !scope || !sync) return;
    untracked(() => { void sync.refresh(); });
    // Host appearance currently has no settings revision tip. Foreground-only bounded revalidation.
    const timer = setInterval(() => { void sync.refresh(); }, 30_000);
    const stop = host.on('runtime.event', payload => {
      const event = runtimeEventFrom(payload);
      if (event?.key === 'global' && event.type === 'reconnected') void sync.refresh();
    });
    return () => { clearInterval(timer); stop(); };
  });
  cleanup(() => {
    writeRevision++; nativeAppearance.saving.set(false);
    mounted = false; refreshAppearance = undefined; stopErrors();
    activeSync?.setScope(null); activeSync = undefined;
  });
  return null;
}

/** Pass as `style={nativeChatTextStyle('markdown')}`; NSH tracks the signal read. */
export function nativeChatTextStyle(role: SemanticTypographyKey | 'user' | 'assistant' | 'composer' = 'markdown'): TextStyle {
  const value = nativeAppearance.current();
  const semantic = role === 'user' || role === 'assistant' || role === 'composer' ? 'markdown' : role;
  const style: TextStyle = nativeTypographyStyle(value, semantic);
  if (role === 'assistant' && value) style.fontFamily = value.assistantFontFamilies[colorScheme()];
  // mobile.css's iOS input zoom floor wins over semantic percentages for composer input.
  if (role === 'composer') { style.fontSize = 16; style.lineHeight = 24; }
  if (value && (role === 'user' || role === 'assistant')) style.color = value.cssVars[colorScheme()][`chat-${role}-foreground`];
  return style;
}

export function nativeChatSurfaceStyle(role: 'user' | 'assistant'): ViewStyle {
  const value = nativeAppearance.current();
  return value ? { backgroundColor: value.cssVars[colorScheme()][`chat-${role}`] } : {};
}

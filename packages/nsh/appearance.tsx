import { cleanup, colorScheme, computed, effect, host, lifecycle, platform, setColorScheme, signal, Storage, untracked, type TextStyle, type ViewStyle } from 'nsh';
import type { SemanticTypographyKey } from '../ui/src/lib/typography';
import { app, captureHostRequest, epoch } from './state';
import { bindRequest, native } from './runtime';
import { runtimeEventFrom } from './model';
import { createNativeAppearanceSync, appearanceFromSettings, nativeAppearanceModePatch, nativeTypographyStyle, nativeFullThemeCSS, type AppliedNativeAppearance, type NativeAppearanceMode, type NativeTimeFormatPreference } from './appearance-core';
import type { Theme } from '../ui/src/types/theme';
import { settingsObject } from './settings-protocol';
import { t } from './i18n';
import { createNativeCodeFontPreference } from './settings-preferences-core';
import { deviceAppearance, loadDeviceAppearance } from './device-appearance';
import type { TextViewStyles } from 'nsh/base';
import { nativeLayoutDensity } from './native-density';
import { sameRuntimeScope } from './runtime-scope';
import { adoptNativeFontEvent, nativeFontEvent, type NativeFontEvent } from './native-font-projection';

export const nativeCodeFontSize = signal<number | null>(null);
export const nativeCodeFontUnconfirmed = signal(false);
let codeFontPreference: ReturnType<typeof createNativeCodeFontPreference> | undefined;
const codeFontOwner = () => codeFontPreference ??= createNativeCodeFontPreference(Storage, (value, unconfirmed = false) => { nativeCodeFontSize.set(value); nativeCodeFontUnconfirmed.set(unconfirmed); });
export const loadNativeCodeFontSize = () => codeFontOwner().load();
export const saveNativeCodeFontSize = (value: unknown) => codeFontOwner().save(value);

export const nativeAppearance = {
  current: signal<AppliedNativeAppearance | null>(null),
  error: signal(''),
  saving: signal(false),
};
let refreshAppearance: ((afterCurrent?: () => boolean) => Promise<void>) | undefined;
let activeSync: ReturnType<typeof createNativeAppearanceSync> | undefined;
let writeRevision = 0;
let mounted = false;
let reconcileFontProjection: (() => void) | undefined;
export const refreshNativeAppearance = (afterCurrent?: () => boolean) => refreshAppearance?.(afterCurrent) ?? Promise.resolve();
export async function retryNativeAppearanceFonts(): Promise<void> {
  const value = nativeAppearance.current(), connection = app.connection(), generation = epoch(), receipt = app.runtimeScope();
  if (!value || !connection || !receipt || value.sourceHost?.hostID !== connection.id || value.sourceHost?.generation !== generation || lifecycle() !== 'active'
    || value.fontRevision === undefined || value.fontTicket === undefined) return;
  try {
    const result = nativeFontEvent(await native('appearance.fonts.retry', { hostID: connection.id, fontRevision: value.fontRevision, fontTicket: value.fontTicket }));
    if (!result || generation !== epoch() || !sameRuntimeScope(receipt, app.runtimeScope()) || lifecycle() !== 'active'
      || nativeAppearance.current()?.fontTicket !== value.fontTicket) return;
    // Retry creates a new ticket; adopt it only while the old selection is current.
    const current = nativeAppearance.current();
    if (current) {
      nativeAppearance.current.set(adoptNativeFontEvent({ ...current, fontTicket: result.fontTicket }, result, app.connection()?.id, generation));
      reconcileFontProjection?.();
    }
  } catch {
    if (generation === epoch() && sameRuntimeScope(receipt, app.runtimeScope())) nativeAppearance.error.set('Native font retry failed');
  }
}
/** Missing/unrecognized Host field is unknown; the formatter may explicitly choose locale-auto with `?? 'auto'`. */
export const nativeTimeFormat = (): NativeTimeFormatPreference | null => nativeAppearance.current()?.timeFormatPreference ?? null;
/** Read-only JS palette from the same Host snapshot; deliberately not part of the Swift override schema. */
export const nativeAgentPaletteTokens = (): Readonly<Record<string, string>> => nativeAppearance.current()?.agentAvatarTokens[colorScheme()] ?? {};
export const nativeToolPaletteTokens = () => nativeAppearance.current()?.toolTokens[colorScheme()];
/** Same root snapshot and Host fence as typography; no independent settings read. */
export const nativeDensity = computed(() => nativeLayoutDensity(nativeAppearance.current()?.padding));
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
  if (platform.desktop) void loadNativeCodeFontSize().catch(() => {});
  let pendingFonts: { event: NativeFontEvent; generation: number } | undefined;
  reconcileFontProjection = () => {
    if (pendingFonts?.generation === epoch() && lifecycle() === 'active') nativeAppearance.current.set(adoptNativeFontEvent(nativeAppearance.current(), pendingFonts.event, app.connection()?.id, epoch()));
  };
  const readers = (request: ReturnType<typeof captureHostRequest>) => ({
    readSettings: () => request('/api/config/settings'),
    readThemes: () => request('/api/config/themes'),
  });
  const createSync = (request: ReturnType<typeof captureHostRequest>) => createNativeAppearanceSync({
    ...readers(request),
    reset: async scope => {
      const result = await native<{ revision: number }>('appearance.reset', { hostID: scope?.hostID ?? null });
      return result.revision;
    },
    apply: (scope, revision, appearance) => native('appearance.apply', {
      hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts,
    }),
    changed: value => {
      let next: AppliedNativeAppearance | null = value ? { ...value, codeFontSize: deviceAppearance()?.codeFontSize ?? null } : null;
      if (next && pendingFonts?.generation === epoch()) next = adoptNativeFontEvent(next, pendingFonts.event, app.connection()?.id, epoch());
      if (!value) pendingFonts = undefined;
      nativeAppearance.current.set(next);
      setColorScheme(value?.mode ?? 'system');
    },
    failed: message => nativeAppearance.error.set(message),
  });
  refreshAppearance = afterCurrent => {
    const sync = activeSync;
    if (!afterCurrent) return sync?.refresh() ?? Promise.resolve();
    if (!sync) return Promise.reject(new Error(t('chat.chatInput.toast.reloadFailed')));
    return sync.refreshAfterCurrent(afterCurrent).catch(() => { throw new Error(t('chat.chatInput.toast.reloadFailed')); });
  };
  // One root subscription projects device typography into the existing appearance signal.
  void loadDeviceAppearance().catch(() => {});
  effect(() => {
    const codeFontSize = deviceAppearance()?.codeFontSize ?? null;
    untracked(() => {
      const value = nativeAppearance.current();
      if (value && value.codeFontSize !== codeFontSize) nativeAppearance.current.set({ ...value, codeFontSize });
    });
  });
  const stopErrors = host.on('appearance.error', () => nativeAppearance.error.set('Native appearance reset failed'));
  const stopFonts = host.on('appearance.fonts', payload => {
    const event = nativeFontEvent(payload);
    if (!event || lifecycle() !== 'active' || event.hostID !== app.connection()?.id || !app.runtimeScope()) return;
    if (pendingFonts?.generation === epoch() && (event.fontRevision < pendingFonts.event.fontRevision
      || event.fontRevision === pendingFonts.event.fontRevision && event.fontTicket < pendingFonts.event.fontTicket)) return;
    pendingFonts = { event, generation: epoch() };
    reconcileFontProjection?.();
  });
  let scopeKey: string | undefined;
  let readerKey: string | undefined;
  effect(() => {
    const connection = app.connection(), active = lifecycle() === 'active', receipt = app.runtimeScope(), generation = epoch();
    const scope = connection ? { hostID: connection.id, url: connection.url, generation } : null;
    const admitted = active && !!scope && receipt?.hostID === scope.hostID;
    untracked(() => {
      const nextKey = JSON.stringify(connection ? [connection.id, connection.url, connection.authorizationID, connection.transportID] : null);
      if (scopeKey !== nextKey) {
        scopeKey = nextKey; readerKey = undefined;
        activeSync?.setScope(null); activeSync = undefined;
      }
      const nextReaderKey = admitted ? JSON.stringify([receipt, generation]) : undefined;
      if (!admitted || !scope || !receipt) {
        readerKey = undefined; writeRevision++; nativeAppearance.saving.set(false); activeSync?.pause(); return;
      }
      if (!activeSync || readerKey !== nextReaderKey) {
        writeRevision++; nativeAppearance.saving.set(false);
        const request = bindRequest(receipt);
        if (!activeSync) { activeSync = createSync(request); activeSync.setScope(scope); }
        else activeSync.rebind(false, { scope, ...readers(request) });
        readerKey = nextReaderKey;
      }
    });
    const sync = activeSync, capturedReader = readerKey;
    if (!admitted || !scope || !sync || !capturedReader) return;
    const currentReader = () => {
      const selected = app.connection();
      return activeSync === sync && readerKey === capturedReader && lifecycle() === 'active' && generation === epoch() && sameRuntimeScope(receipt, app.runtimeScope())
        && selected?.id === connection?.id && selected?.url === connection?.url && selected?.authorizationID === connection?.authorizationID && selected?.transportID === connection?.transportID;
    };
    untracked(() => { void sync.refresh(); });
    // Host appearance currently has no settings revision tip. Foreground-only bounded revalidation.
    const timer = setInterval(() => { if (currentReader()) void sync.refresh(); }, 30_000);
    const stop = host.on('runtime.event', payload => {
      const event = runtimeEventFrom(payload);
      if (currentReader() && event?.key === 'global' && event.type === 'reconnected') void sync.refresh();
    });
    return () => { clearInterval(timer); stop(); };
  });
  cleanup(() => {
    writeRevision++; nativeAppearance.saving.set(false);
    mounted = false; refreshAppearance = undefined; reconcileFontProjection = undefined; stopErrors(); stopFonts();
    activeSync?.setScope(null); activeSync = undefined;
  });
  return null;
}

/** Pass as `style={nativeChatTextStyle('markdown')}`; NSH tracks the signal read. */
export function nativeChatTextStyle(role: SemanticTypographyKey | 'user' | 'assistant' | 'composer' = 'markdown'): TextStyle {
  const value = nativeAppearance.current();
  const semantic = role === 'user' || role === 'assistant' || role === 'composer' ? 'markdown' : role;
  const style: TextStyle = nativeTypographyStyle(value, semantic, platform.desktop);
  if (role === 'code' && platform.desktop) {
    style.fontSize = style.fontSize! * (nativeCodeFontSize() ?? 100) / 100;
    style.lineHeight = style.fontSize * 1.625;
  }
  if (role === 'assistant' && value) style.fontFamily = value.assistantFontFamilies[colorScheme()];
  // mobile.css's iOS input zoom floor wins over semantic percentages for composer input.
  // Desktop Web measures the same field as 14px/21px (md:typography-ui-label).
  if (role === 'composer') { style.fontSize = platform.desktop ? 14 : 16; style.lineHeight = platform.desktop ? 21 : 24; }
  if (value && (role === 'user' || role === 'assistant')) style.color = value.cssVars[colorScheme()][`chat-${role}-foreground`];
  return style;
}

export function nativeChatSurfaceStyle(role: 'user' | 'assistant'): ViewStyle {
  const value = nativeAppearance.current();
  return value ? { backgroundColor: value.cssVars[colorScheme()][`chat-${role}`] } : {};
}

/** Code parts only: the caller retains its body typography, colors and metadata. */
export function nativeCodeTextViewStyles(): TextViewStyles {
  const code = nativeChatTextStyle('code');
  return { code, codeBlockCode: { ...code, lineHeight: 20 * (code.fontSize ?? 13) / 13 } };
}

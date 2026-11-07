import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

export const GUI_NATIVE_LABEL_KEYS = {
  loading: 'guiPlugins.preview.loadingTitle', failed: 'guiPlugins.error', back: 'filesView.editor.back',
  close: 'guiPlugins.close', retry: 'contextPanel.preview.actions.retry',
  source: 'guiPlugins.preview.viewSource', preview: 'filesView.editor.switchToPreviewMode',
} as const satisfies Record<string, I18nKey>;
export type GuiPluginNativeContext = Readonly<{
  runtimeKey: string; preferenceKey: string; locale: string; mode: 'light' | 'dark'; themeCSS: string;
  labels: Readonly<Record<keyof typeof GUI_NATIVE_LABEL_KEYS, string>>;
}>;
export const GUI_NATIVE_CSS_LIMIT = 512 * 1024;
const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && bytes(value) <= limit && !/[\u0000-\u001f\u007f]/.test(value);
export const nativeGuiRuntimeKey = (scope: RuntimeScope): string => 'nsh:' + scope.hostID;

/** Native performs the authoritative exact preference-key/storage check. The
 * real factory also passes official guiPreferencesKey here, without importing
 * browser runtime/storage modules into the framework-neutral binder. */
export function validateGuiPluginNativeContext(value: unknown, scope: RuntimeScope, expectedPreferenceKey?: string): GuiPluginNativeContext {
  if (!runtimeScopeFrom(scope) || !record(value) || Object.keys(value).sort().join() !== 'labels,locale,mode,preferenceKey,runtimeKey,themeCSS'
    || value.runtimeKey !== nativeGuiRuntimeKey(scope) || !text(value.runtimeKey, 2048)
    || !text(value.preferenceKey, 4096) || !/^yuri\.inst\.[A-Za-z\d_-]+\.gui-plugins\.disabled$/.test(value.preferenceKey)
    || expectedPreferenceKey !== undefined && value.preferenceKey !== expectedPreferenceKey
    || typeof value.locale !== 'string' || !locales.includes(value.locale) || value.mode !== 'light' && value.mode !== 'dark'
    || typeof value.themeCSS !== 'string' || !value.themeCSS.trim() || bytes(value.themeCSS) > GUI_NATIVE_CSS_LIMIT
    || /\u0000|<\/(?:script|style)\b/i.test(value.themeCSS) || !record(value.labels)
    || Object.keys(value.labels).sort().join() !== Object.keys(GUI_NATIVE_LABEL_KEYS).sort().join()) throw new Error('GUI_INVALID_NATIVE_CONTEXT');
  const labels = {} as Record<keyof typeof GUI_NATIVE_LABEL_KEYS, string>;
  for (const key of Object.keys(GUI_NATIVE_LABEL_KEYS) as (keyof typeof GUI_NATIVE_LABEL_KEYS)[]) {
    const label = value.labels[key];
    if (!text(label, 2048) || label === GUI_NATIVE_LABEL_KEYS[key]) throw new Error('GUI_INVALID_NATIVE_CONTEXT');
    labels[key] = label;
  }
  return Object.freeze({ runtimeKey: value.runtimeKey, preferenceKey: value.preferenceKey, locale: value.locale, mode: value.mode, themeCSS: value.themeCSS, labels: Object.freeze(labels) });
}

export function guiNativeLocale(selected: string): string {
  const normalized = selected.startsWith('zh') ? /TW|HK|Hant/.test(selected) ? 'zh-TW' : 'zh-CN' : selected.startsWith('pt') ? 'pt-BR' : selected.split('-')[0];
  return locales.includes(normalized) ? normalized : 'en';
}

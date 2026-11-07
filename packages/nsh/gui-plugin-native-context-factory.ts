import { CSSVariableGenerator } from '../ui/src/lib/theme/cssGenerator';
import { guiPreferencesKey } from '../ui/src/lib/gui-plugins/preferences';
import { nativeFullThemeCSS, type NativeAppearance, type AppliedNativeAppearance, type AppearanceScope } from './appearance-core';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { GUI_NATIVE_LABEL_KEYS, guiNativeLocale, nativeGuiRuntimeKey, validateGuiPluginNativeContext } from './gui-plugin-native-context';
import { bindGuiPluginPreview } from './gui-plugin-preview';

/** Call once when constructing an operation owner, with the same native-issued
 * scope as its request sender. No settings/themes GET or local default palette. */
export function captureGuiPluginNativeContext(input: {
  expectedHost: RuntimeScope; appearance: (NativeAppearance & Pick<AppliedNativeAppearance, 'sourceHost'>) | null; appearanceScope: AppearanceScope; systemMode: 'light' | 'dark';
  locale: string; t: (key: I18nKey) => string;
}) {
  const scope = runtimeScopeFrom(input.expectedHost);
  const source = input.appearance?.sourceHost, expected = input.appearanceScope;
  if (!scope || !input.appearance || !source || expected.hostID !== scope.hostID || source.hostID !== expected.hostID || source.generation !== expected.generation || source.url !== expected.url) throw new Error('GUI_APPEARANCE_UNAVAILABLE');
  const mode = input.appearance.mode === 'system' ? input.systemMode : input.appearance.mode;
  const generator = new CSSVariableGenerator();
  const themeCSS = nativeFullThemeCSS(input.appearance, mode, theme => generator.generate(theme));
  const runtimeKey = nativeGuiRuntimeKey(scope), preferenceKey = guiPreferencesKey(runtimeKey);
  const labels = Object.fromEntries(Object.entries(GUI_NATIVE_LABEL_KEYS).map(([name, key]) => [name, input.t(key)]));
  return validateGuiPluginNativeContext({ runtimeKey, preferenceKey, locale: guiNativeLocale(input.locale), mode, themeCSS, labels }, scope, preferenceKey);
}

/** File-entry owner integration: capture once, never read latest appearance or
 * Host while an asynchronous present/close is completing. Context is mandatory. */
export function bindNativeGuiPluginPreview(input: Parameters<typeof captureGuiPluginNativeContext>[0] & {
  call: Parameters<typeof bindGuiPluginPreview>[1]; identify: () => string; isCurrent: (expectedHost: RuntimeScope) => boolean;
}) {
  const scope = runtimeScopeFrom(input.expectedHost);
  if (!scope || !input.isCurrent(scope)) throw new Error('runtime_host_scope_stale');
  const context = captureGuiPluginNativeContext({ ...input, expectedHost: scope });
  return bindGuiPluginPreview(scope, input.call, input.identify, input.isCurrent, context);
}

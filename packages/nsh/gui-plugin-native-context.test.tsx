import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSSVariableGenerator } from '../ui/src/lib/theme/cssGenerator';
import { getThemeById } from '../ui/src/lib/theme/themes';
import { guiPreferencesKey } from '../ui/src/lib/gui-plugins/preferences';
import { UI_FONT_OPTIONS, CODE_FONT_OPTIONS } from '../ui/src/lib/fontOptions';
import { createNativeAppearanceSync, type AppliedNativeAppearance } from './appearance-core';
import { captureGuiPluginNativeContext, bindNativeGuiPluginPreview } from './gui-plugin-native-context-factory';
import { GUI_NATIVE_CSS_LIMIT, GUI_NATIVE_LABEL_KEYS, validateGuiPluginNativeContext } from './gui-plugin-native-context';
import { bindGuiPluginPreview } from './gui-plugin-preview';
import { captureGuiPluginFactory } from './gui-plugin-factory';
import { createGuiPluginComposition } from './gui-plugin-composition';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';

const scope = { hostID: 'native-issued-host', lease: 'native-receipt' };
const appearanceScope = { hostID: scope.hostID, generation: 1, url: 'https://synthetic.invalid' };
async function appearanceFromSettings(settings: unknown, loadThemes: () => Promise<unknown>): Promise<AppliedNativeAppearance> {
  let result: AppliedNativeAppearance | null = null, failure = '';
  const sync = createNativeAppearanceSync({ readSettings: async () => settings, readThemes: loadThemes, reset: async () => 1,
    apply: async (_, __, value) => ({ uiFontFamily: value.fonts.ui, monoFontFamily: value.fonts.mono, assistantFontFamilies: { light: value.fonts.assistantLight, dark: value.fonts.assistantDark }, unsupportedFonts: [] }),
    changed: value => { result = value; }, failed: value => { failure = value; },
  });
  sync.setScope(appearanceScope); await sync.refresh();
  if (!result) throw Error(failure || 'Synthetic canonical appearance unavailable');
  return result;
}
const dictionaries = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr, es, pl, 'pt-BR': ptBR, uk };
const settings = { useSystemTheme: true, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark', uiFont: 'inter', monoFont: 'fira-code', fontSize: 120 };
const noThemes = async () => ({ themes: [] });
describe('real native GUI presentation context', () => {
  it.each(Object.entries(dictionaries))('captures actual %s translations from the existing dictionary', async (locale, dictionary) => {
    const appearance = await appearanceFromSettings(settings, noThemes);
    const value = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale, t: key => dictionary[key] });
    expect(value.locale).toBe(locale);
    for (const [name, key] of Object.entries(GUI_NATIVE_LABEL_KEYS)) expect(value.labels[name as keyof typeof value.labels]).toBe(dictionary[key]);
    expect(value.runtimeKey).toBe('nsh:' + scope.hostID);
    expect(value.preferenceKey).toBe(guiPreferencesKey(value.runtimeKey));
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.labels)).toBe(true);
  });
  it('preserves every actual Web generator declaration and canonical custom-theme slot, font stack and mode', async () => {
    const custom = structuredClone(getThemeById('jetbrains-dark')!); custom.metadata.id = 'context-custom-dark';
    custom.config = { ...custom.config, transitions: { fast: '51ms', normal: '123ms', slow: '456ms' } };
    const load = vi.fn(async () => ({ themes: [custom] }));
    const appearance = await appearanceFromSettings({ ...settings, darkThemeId: custom.metadata.id }, load);
    const value = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale: 'zh-Hant-TW', t: key => zhTW[key] });
    expect(value.locale).toBe('zh-TW'); expect(value.mode).toBe('dark');
    const generated = new CSSVariableGenerator().generate(custom);
    expect(value.themeCSS).toContain(generated);
    expect((generated.match(/--[a-z\d-]+:/g) ?? []).length).toBeGreaterThan(150);
    expect(value.themeCSS).toContain('--transition-fast: 51ms');
    expect(value.themeCSS).toContain(`--font-sans: ${UI_FONT_OPTIONS.find(item => item.id === 'inter')!.stack}`);
    expect(value.themeCSS).toContain(`--font-mono: ${CODE_FONT_OPTIONS.find(item => item.id === 'fira-code')!.stack}`);
    expect(value.themeCSS).toContain('--text-markdown: calc(18 * var(--dpt, 1px))');
    expect(value.themeCSS).toContain('--text-code: calc(13 * var(--dpt, 1px))');
    expect(value.themeCSS).not.toContain('font-size: 120%');
    custom.colors.surface.background = '#112233';
    expect(value.themeCSS).not.toContain('--surface-background: #112233');
    const light = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'light', locale: 'en', t: key => en[key] });
    expect(light.themeCSS).toContain(new CSSVariableGenerator().generate(getThemeById('jetbrains-light')!));
    expect(load).toHaveBeenCalledOnce(); // No per-preview network or catalog read.
  });
  it('uses fixed canonical mode even when system appearance differs, and fails closed without canonical appearance', async () => {
    const appearance = await appearanceFromSettings({ ...settings, useSystemTheme: false, themeVariant: 'dark' }, noThemes);
    const input = { expectedHost: scope, appearanceScope, appearance, systemMode: 'light' as const, locale: 'en', t: (key: keyof typeof en) => en[key] };
    expect(captureGuiPluginNativeContext(input).mode).toBe('dark');
    expect(() => captureGuiPluginNativeContext({ ...input, appearance: null })).toThrow('GUI_APPEARANCE_UNAVAILABLE');
    expect(() => captureGuiPluginNativeContext({ ...input, appearance: { ...appearance, sourceHost: undefined } })).toThrow('GUI_APPEARANCE_UNAVAILABLE');
    for (const patch of [{ hostID: 'other' }, { generation: 2 }, { url: 'https://other.invalid' }]) expect(() => captureGuiPluginNativeContext({ ...input, appearanceScope: { ...appearanceScope, ...patch } })).toThrow('GUI_APPEARANCE_UNAVAILABLE');
    expect(() => captureGuiPluginNativeContext({ ...input, appearance: { ...appearance, webTheme: undefined } })).toThrow('GUI_APPEARANCE_UNAVAILABLE');
    expect(() => captureGuiPluginNativeContext({ ...input, t: key => key })).toThrow('GUI_INVALID_NATIVE_CONTEXT');
  });
  it('rejects unknown fields, script/style injection, byte overflow, labels and cross-host identity/preferences', async () => {
    const appearance = await appearanceFromSettings(settings, noThemes);
    const value = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale: 'en', t: key => en[key] });
    for (const patch of [{ options: {} }, { directory: '/tmp' }, { runtimeKey: 'nsh:other' }, { preferenceKey: guiPreferencesKey('nsh:other') }, { mode: 'system' }, { locale: 'system' },
      { themeCSS: ':root{--x:"</script><script>alert(1)</script>"}' }, { themeCSS: '</STYLE><img src=x>' }, { themeCSS: '界'.repeat(GUI_NATIVE_CSS_LIMIT / 2) }, { labels: { ...value.labels, extra: 'x' } }, { labels: { ...value.labels, failed: '' } }]) {
      expect(() => validateGuiPluginNativeContext({ ...value, ...patch }, scope, value.preferenceKey)).toThrow('GUI_INVALID_NATIVE_CONTEXT');
    }
  });
  it('binds a copied constructor-time context while owner/scope retain their independent admission', async () => {
    const appearance = await appearanceFromSettings(settings, noThemes);
    const context = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale: 'en', t: key => en[key] });
    const mutable = { ...context, labels: { ...context.labels } };
    const calls: Record<string, unknown>[] = [];
    const bound = bindGuiPluginPreview(scope, async (name, input) => { calls.push({ name, ...input }); return name.endsWith('.close') ? true : { closed: true }; }, () => 'owner-1', () => true, mutable);
    mutable.themeCSS = ':root{--changed:true}'; mutable.labels.loading = 'changed';
    await bound.present({ sessionId: 'session', directory: '/work', path: 'a.report' });
    expect(calls[0]).toMatchObject({ expectedHost: scope, owner: 'owner-1', context });
    expect(calls[1]).toEqual({ name: 'plugins.preview.close', expectedHost: scope, owner: 'owner-1' });
  });
  it('production binding requires canonical data and captures it before later theme/locale changes', async () => {
    const appearance = await appearanceFromSettings(settings, noThemes);
    const calls: Record<string, unknown>[] = []; let selected = ja;
    const input = { expectedHost: scope, appearanceScope, appearance, systemMode: 'dark' as const, locale: 'ja', t: (key: keyof typeof en) => selected[key],
      identify: () => 'native-owner', isCurrent: () => true, call: async (name: string, value: Record<string, unknown>) => { calls.push(value); return name.endsWith('.close') ? true : { closed: true }; },
    };
    expect(() => bindNativeGuiPluginPreview({ ...input, appearance: null })).toThrow('GUI_APPEARANCE_UNAVAILABLE');
    const bound = bindNativeGuiPluginPreview(input);
    selected = en; appearance.mode = 'light';
    await bound.present({ sessionId: 's', directory: '/work', path: '真实.report.json' });
    expect(calls[0]).toMatchObject({ expectedHost: scope, owner: 'native-owner', context: { locale: 'ja', mode: 'dark', labels: { failed: ja['guiPlugins.error'] } } });
    expect(calls[0]).not.toHaveProperty('options');
  });
  it('actual browser factory applies captured mode/locale and full CSS as DOM text, then restores its document', async () => {
    const appearance = await appearanceFromSettings(settings, noThemes);
    const context = captureGuiPluginNativeContext({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale: 'uk', t: key => uk[key] });
    const prior = { dark: document.documentElement.classList.contains('dark'), lang: document.documentElement.getAttribute('lang'), theme: document.documentElement.getAttribute('data-theme') };
    const content = document.createElement('section'), actions = document.createElement('aside');
    document.body.append(content, actions);
    const send = vi.fn(async () => { throw Error('No GUI HTTP expected during context capture'); });
    const composition = createGuiPluginComposition({ scope, origin: 'https://synthetic.invalid', sender: { isCurrent: () => true, send }, content, actions,
      intent: { sessionId: 's', directory: '/work', path: 'a.report' }, changed() {},
      capture({ expectedHost, fetch, signal }) { return captureGuiPluginFactory({ expectedHost, origin: 'https://synthetic.invalid', runtimeKey: context.runtimeKey, directory: '/work', fetch, signal, storage: localStorage,
        appearance: { locale: context.locale, mode: context.mode }, themeCSS: context.themeCSS, preferenceKey: context.preferenceKey }); },
    });
    try {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.lang).toBe('uk');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.querySelector<HTMLStyleElement>('style[data-nsh-gui-theme]')?.textContent).toBe(context.themeCSS);
      expect(send).not.toHaveBeenCalled();
    } finally { composition.close(); content.remove(); actions.remove(); }
    expect(document.querySelector('style[data-nsh-gui-theme]')).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(prior.dark);
    expect(document.documentElement.getAttribute('lang')).toBe(prior.lang);
    expect(document.documentElement.getAttribute('data-theme')).toBe(prior.theme);
  });
  it.skipIf(process.platform !== 'darwin')('production Foundation consumes the actual factory JSON with exact scope/storage and missing-context rejection', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-context-'));
    try {
      const expectedHost = { ...scope, lease: '11111111-1111-4111-8111-111111111111' };
      const appearance = await appearanceFromSettings(settings, noThemes);
      const context = captureGuiPluginNativeContext({ expectedHost, appearanceScope, appearance, systemMode: 'dark', locale: 'ja', t: key => ja[key] });
      const payload = { expectedHost, owner: 'owner-context', sessionId: 'session', directory: '/work', path: 'a.report', context };
      const input = path.join(temporary, 'context.json'); writeFileSync(input, JSON.stringify(payload));
      const staged = path.join(temporary, 'staged');
      const built = spawnSync('node', [path.join(root, 'scripts/build-gui-plugin-preview.mjs'), '--out', staged], { encoding: 'utf8', timeout: 60000 });
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const source = path.join(temporary, 'Fixture.swift'), binary = path.join(temporary, 'fixture');
      writeFileSync(source, `import Foundation
@main struct Fixture {
 @MainActor static func main() async throws {
  var input = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  let expected = try RuntimeHostScope(input["expectedHost"])
  let raw = input["context"] as! [String:Any]
  let context = try GuiPluginNativeContext(raw,expectedHost:expected)
  precondition(context.preferenceKey == GuiPluginNativeContext.preferenceKey(runtimeKey:context.runtimeKey))
  let store = try GuiPluginPreviewStorage(directory:URL(fileURLWithPath:CommandLine.arguments[2]).appendingPathComponent("private-store"),connectionID:expected.hostID)
  var current = true
  let resource = ResourceWebPreviewTransport(readFile:{_,_ in ResourceWebPreviewResponse(status:200,mime:"text/plain",data:Data())},isCurrent:{current})
  let resources = try GuiPluginPreviewResources(stagedDirectory:URL(fileURLWithPath:CommandLine.arguments[3]),storageDirectory:URL(fileURLWithPath:CommandLine.arguments[2]).appendingPathComponent("resource-store"))
  let capture: (RuntimeHostScope) throws -> GuiPluginPreviewCapture = { scope in
   precondition(scope == expected)
   return try resources.capture(expectedHost:scope,isCurrent:{$0 == expected && current},resource:resource,readGui:nil,openGui:nil)
  }
  let rawCapture = try capture(expected)
  let realEntry = try await rawCapture.readAsset("/assets/entry.js",GuiPluginPreviewScope.limit)
  precondition(realEntry.data.count > 100000)
  let sameCapture = try capture(expected);precondition(rawCapture.storage === sameCapture.storage)
  precondition(rawCapture.bootstrap == nil && rawCapture.labels == nil)
  precondition(store.matches(runtimeKey:context.runtimeKey,preferenceKey:context.preferenceKey))
  let ownership = GuiPluginPreviewOwnership()
  let ticket = try ownership.begin(input,capture:capture,requireContext:true)
  precondition(ticket.captured.bootstrap?.themeCSS == raw["themeCSS"] as? String)
  precondition(ticket.captured.labels?.failed == (raw["labels"] as! [String:String])["failed"])
  precondition(ticket.captured.bootstrap?.locale == "ja")
  precondition(ownership.startClosing(ticket));ownership.retire(ticket)
  input["owner"] = "next-context"
  input.removeValue(forKey:"context")
  do { _ = try ownership.begin(input,capture:capture,requireContext:true);fatalError("missing context accepted") } catch GuiPluginPreviewFailure.unavailable {}
  input["context"] = raw;current = false
  do { _ = try ownership.begin(input,capture:capture,requireContext:true);fatalError("stale context accepted") } catch GuiPluginPreviewFailure.stale {}
  current = true
  let other = try GuiPluginPreviewStorage(directory:URL(fileURLWithPath:CommandLine.arguments[2]).appendingPathComponent("other-store"),connectionID:"other-native-host")
  var wrong = try capture(expected);wrong.storage = other
  do { _ = try wrong.applying(context);fatalError("cross Host storage accepted") } catch GuiPluginPreviewFailure.unavailable {}
  for (key,value): (String,Any) in [("runtimeKey","nsh:other"),("preferenceKey","yuri.inst.other.gui-plugins.disabled"),("options",["secret":"synthetic"]),("directory","/arbitrary"),("mode","system"),("locale","system"),("themeCSS","</script><script>bad</script>"),("themeCSS",String(repeating:"界",count:262144))] {
   var invalid = raw;invalid[key] = value
   do { _ = try GuiPluginNativeContext(invalid,expectedHost:expected);fatalError("unsafe context accepted") } catch GuiPluginPreviewFailure.invalid {}
  }
  print("Real GUI context JSON/identity/storage passed")
 }
}`);
      const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...['RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift'].map(file => path.join(root, 'ios', file)), source, '-o', binary], { encoding: 'utf8', timeout: 60000 });
      expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
      const result = spawnSync(binary, [input, temporary, staged], { encoding: 'utf8', timeout: 10000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Real GUI context JSON/identity/storage passed');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 75000);
  it('offline native context bundle loads and captures without a Window, DOM, storage, fetch or NSH engine', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-context-bundle-'));
    try {
      const output = path.join(temporary, 'context.cjs');
      const built = spawnSync('bun', ['build', path.join(root, 'gui-plugin-native-context-factory.ts'), '--tsconfig-override', path.join(root, 'tsconfig.json'), '--target=browser', '--format=cjs', '--minify', '--outfile', output], { encoding: 'utf8', timeout: 60000 });
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const source = readFileSync(output, 'utf8');
      const module = { exports: {} as Record<string, unknown> };
      // NSH declares crypto.subtle/EventTarget/AbortController in globals.d.ts;
      // use real standard implementations, never a Window/DOM/storage shim.
      runInNewContext(source, { module, exports: module.exports, TextEncoder, TextDecoder, btoa, atob, crypto: webcrypto, EventTarget, AbortController, AbortSignal, URL, URLSearchParams,
        fetch() { throw Error('Native context must not fetch'); },
      }, { timeout: 10000 });
      const capture = module.exports.captureGuiPluginNativeContext as typeof captureGuiPluginNativeContext;
      const appearance = await appearanceFromSettings(settings, noThemes);
      const context = capture({ expectedHost: scope, appearanceScope, appearance, systemMode: 'dark', locale: 'en', t: key => en[key] });
      expect(context.themeCSS).toContain(new CSSVariableGenerator().generate(getThemeById('jetbrains-dark')!));
      expect(source).not.toContain('NativeAppearanceSync');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

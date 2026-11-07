import type { Theme } from '../ui/src/types/theme';
import { getDefaultTheme, getThemeById } from '../ui/src/lib/theme/themes';
import { withBaseTextFloor } from '../ui/src/lib/theme/baseTextColors';
import { isValidTheme } from '../ui/src/contexts/theme-validation';
import { UI_FONT_OPTIONS, CODE_FONT_OPTIONS, DEFAULT_UI_FONT, DEFAULT_MONO_FONT } from '../ui/src/lib/fontOptions';
import { MOBILE_SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '../ui/src/lib/typography';
import { agentAvatarThemeTokens } from '../ui/src/lib/agentAvatarPalette';
import { DEFAULT_FOLLOW_UP_BEHAVIOR, isFollowUpBehavior, normalizeFollowUpBehavior, type FollowUpBehavior } from '../ui/src/lib/followUpBehavior';
import { contextUsageThemeTokens, type ContextUsagePalette } from './context-usage-palette';
// Structurally matches Web TimeFormatPreference without pulling its React/store type-check graph into NSH.
export type NativeTimeFormatPreference = 'auto' | '12h' | '24h';

export type NativeAppearanceMode = 'light' | 'dark' | 'system';
export type NativeAppearance = {
  mode: NativeAppearanceMode;
  themeIDs: { light: string; dark: string };
  cssVars: { light: Record<string, string>; dark: Record<string, string> };
  agentAvatarTokens: { light: Readonly<Record<string, string>>; dark: Readonly<Record<string, string>> };
  toolTokens: { light: ReturnType<typeof nativeToolThemeTokens>; dark: ReturnType<typeof nativeToolThemeTokens> };
  contextUsageTokens: { light: ContextUsagePalette; dark: ContextUsagePalette };
  fonts: { ui: string; mono: string; assistantLight: string; assistantDark: string };
  fontSize: number;
  timeFormatPreference: NativeTimeFormatPreference | null;
  collapsibleUserMessages: boolean | null;
  chatRenderMode: 'sorted' | 'live';
  activityRenderMode: 'collapsed' | 'summary';
  showReasoningTraces: boolean;
  sessionGoalEnabled: boolean | null;
  showAssistantTps: boolean | null;
  collapsibleThinkingBlocks: boolean | null;
  followUpBehavior: FollowUpBehavior | null;
  /** Read-only Web projection from this same canonical snapshot. Never sent in
   * appearance.apply; UIKit's semantic palette is not a complete Web theme. */
  webTheme?: { light: Theme; dark: Theme; uiStack: string; monoStack: string };
};
export type AppliedNativeAppearance = NativeAppearance & {
  uiFontFamily: string; monoFontFamily: string; assistantFontFamilies: { light: string; dark: string }; unsupportedFonts: string[];
  systemColorScheme?: 'light' | 'dark';
};
export type AppearanceScope = { hostID: string; generation: number; url: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const enabledPreference = (value: unknown): boolean | null => value === undefined ? true : typeof value === 'boolean' ? value : null;

export function nativeAppearanceModeFromSettings(value: unknown): NativeAppearanceMode {
  const settings = object(value);
  if (settings.useSystemTheme === true) return 'system';
  if (settings.themeVariant === 'light' || settings.themeVariant === 'dark') return settings.themeVariant;
  return getThemeById(nonempty(settings.themeId) ?? '')?.metadata.variant ?? 'system';
}

/** Same explicit preference fields written by Web ThemeSystemProvider; never PUT an entire settings snapshot. */
export function nativeAppearanceModePatch(appearance: NativeAppearance, mode: NativeAppearanceMode, systemVariant: 'light' | 'dark') {
  const variant = mode === 'system' ? systemVariant : mode;
  return {
    useSystemTheme: mode === 'system', themeVariant: variant, themeId: appearance.themeIDs[variant],
    lightThemeId: appearance.themeIDs.light, darkThemeId: appearance.themeIDs.dark,
  };
}

/** Same semantic sources as CSSVariableGenerator, with NSH's existing neutral-action tokens. */
export function nativeThemeTokens(raw: Theme): Record<string, string> {
  const { surface, interactive, status, chat } = withBaseTextFloor(raw).colors;
  const tokens = {
    background: surface.background, foreground: surface.foreground,
    card: surface.elevated, 'card-foreground': surface.elevatedForeground,
    primary: surface.foreground, 'primary-foreground': surface.background,
    secondary: surface.muted, 'secondary-foreground': surface.foreground,
    muted: surface.muted, 'muted-foreground': surface.mutedForeground,
    accent: interactive.selection, 'accent-foreground': interactive.selectionForeground,
    border: interactive.border, input: interactive.border, ring: interactive.focusRing,
    destructive: status.error, success: status.success,
    'chat-user': chat?.userMessageBackground || surface.elevated,
    'chat-user-foreground': chat?.userMessage || surface.foreground,
    'chat-assistant': chat?.assistantMessageBackground || surface.background,
    'chat-assistant-foreground': chat?.assistantMessage || surface.foreground,
  };
  for (const color of Object.values(tokens)) {
    if (color.trim() !== color || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new Error('Native appearance requires hexadecimal semantic colors');
  }
  return tokens;
}

/** Resolves cssGenerator's tools title color-mix and description alpha for UIKit. */
export function nativeToolThemeTokens(raw: Theme) {
  const { surface, tools, status } = withBaseTextFloor(raw).colors;
  function rgba(color: string) {
    if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new Error('Native tool appearance requires hexadecimal semantic colors');
    const value = color.slice(1), hex = value.length <= 4 ? [...value].map(char => char + char).join('') : value;
    return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).concat(hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1);
  }
  const hex = (values: number[]) => '#' + values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
  const title = rgba(tools?.title || surface.foreground), muted = rgba(surface.mutedForeground), alpha = (title[3] + muted[3]) / 2;
  const mixed = hex([0, 1, 2].map(index => alpha ? (title[index] * title[3] + muted[index] * muted[3]) / (2 * alpha) : 0).concat(alpha * 255));
  const icon = tools?.icon || surface.mutedForeground;
  const description = tools?.description || hex(muted.slice(0, 3).concat(0.6 * 255));
  rgba(icon); rgba(description);
  return { icon, title: mixed, description, error: status.error };
}

/** Only a successful Host snapshot may choose defaults; missing themes remain a failure. */
export async function appearanceFromSettings(value: unknown, loadCustom: () => Promise<unknown>): Promise<NativeAppearance> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Host appearance settings');
  const settings = object(value);
  const legacyID = nonempty(settings.themeId);
  let custom: Theme[] | undefined;
  async function lookup(id: string) {
    const builtIn = getThemeById(id);
    if (builtIn) return builtIn;
    if (!custom) {
      const payload = object(await loadCustom());
      if (!Array.isArray(payload.themes) || payload.themes.length > 256) throw new Error('Invalid Host theme catalog');
      custom = payload.themes.filter(isValidTheme);
    }
    return custom.find(item => item.metadata.id === id);
  }
  const legacyTheme = legacyID && settings.themeVariant === undefined ? await lookup(legacyID) : legacyID ? getThemeById(legacyID) : undefined;
  if (legacyID && settings.themeVariant === undefined && !legacyTheme) throw new Error('Host selected theme is unavailable in native appearance');
  const variant = settings.themeVariant === 'light' || settings.themeVariant === 'dark' ? settings.themeVariant : legacyTheme?.metadata.variant;
  const mode: NativeAppearanceMode = settings.useSystemTheme === true ? 'system' : variant ?? 'system';
  const ids = {
    light: nonempty(settings.lightThemeId) || (variant === 'light' ? legacyID : undefined) || getDefaultTheme(false).metadata.id,
    dark: nonempty(settings.darkThemeId) || (variant === 'dark' ? legacyID : undefined) || getDefaultTheme(true).metadata.id,
  };
  async function resolve(id: string, expected: 'light' | 'dark') {
    const theme = await lookup(id);
    if (!theme || theme.metadata.variant !== expected) throw new Error('Host selected theme is unavailable in native appearance');
    const agentTokens = agentAvatarThemeTokens(theme.colors);
    if (Object.values(agentTokens).some(color => color.trim() !== color || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))) throw new Error('Native Agent appearance requires hexadecimal semantic colors');
    return { tokens: nativeThemeTokens(theme), agentTokens, toolTokens: nativeToolThemeTokens(theme), contextUsageTokens: contextUsageThemeTokens(theme), theme };
  }
  // Fixed mode paints both native appearances with the selected palette; system owns two palettes.
  const light = mode === 'dark' ? undefined : await resolve(ids.light, 'light');
  const dark = mode === 'light' ? undefined : await resolve(ids.dark, 'dark');
  function family(value: unknown, options: typeof UI_FONT_OPTIONS | typeof CODE_FONT_OPTIONS, fallback: string, system: string) {
    const option = options.find(item => item.id === (value ?? fallback));
    if (!option) throw new Error('Host selected font is unsupported');
    return option.source?.family || system;
  }
  const fontSize = settings.fontSize === undefined ? 100 : settings.fontSize;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 50 || fontSize > 200) throw new Error('Invalid Host font scale');
  const ui = family(settings.uiFont, UI_FONT_OPTIONS, DEFAULT_UI_FONT, 'system-ui');
  const uiStack = UI_FONT_OPTIONS.find(item => item.id === (settings.uiFont ?? DEFAULT_UI_FONT))!.stack;
  const monoStack = CODE_FONT_OPTIONS.find(item => item.id === (settings.monoFont ?? DEFAULT_MONO_FONT))?.stack;
  // Host settings follow persistence.ts precedence, not the local queue store's `immediate` migration.
  const followUpBehavior = isFollowUpBehavior(settings.followUpBehavior) ? settings.followUpBehavior
    : typeof settings.queueModeEnabled === 'boolean' ? normalizeFollowUpBehavior(undefined, settings.queueModeEnabled)
    : settings.followUpBehavior === undefined && settings.queueModeEnabled === undefined ? DEFAULT_FOLLOW_UP_BEHAVIOR : null;
  function rendererFamily(theme: Theme) {
    // The renderer's scoped font follows theme config, independently of the user/composer UI font.
    const source = theme.config?.fonts?.sans;
    if (!source) return ui;
    const first = source.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (['system-ui', 'sans-serif', '-apple-system', 'BlinkMacSystemFont', 'ui-sans-serif'].includes(first)) return 'system-ui';
    if (['monospace', 'ui-monospace'].includes(first)) return 'monospace';
    if (!/^[a-zA-Z0-9 -]{1,64}$/.test(first) || first.trim() !== first) throw new Error('Host renderer font is unsupported');
    return first;
  }
  return {
    mode, themeIDs: ids, cssVars: { light: (light ?? dark!).tokens, dark: (dark ?? light!).tokens }, fontSize,
    agentAvatarTokens: { light: (light ?? dark!).agentTokens, dark: (dark ?? light!).agentTokens },
    toolTokens: { light: (light ?? dark!).toolTokens, dark: (dark ?? light!).toolTokens },
    contextUsageTokens: { light: (light ?? dark!).contextUsageTokens, dark: (dark ?? light!).contextUsageTokens },
    timeFormatPreference: settings.timeFormatPreference === 'auto' || settings.timeFormatPreference === '12h' || settings.timeFormatPreference === '24h' ? settings.timeFormatPreference : null,
    collapsibleUserMessages: settings.collapsibleUserMessages === undefined ? true : typeof settings.collapsibleUserMessages === 'boolean' ? settings.collapsibleUserMessages : null,
    chatRenderMode: settings.chatRenderMode === 'live' ? 'live' : 'sorted',
    activityRenderMode: settings.activityRenderMode === 'summary' ? 'summary' : 'collapsed',
    showReasoningTraces: settings.showReasoningTraces !== false,
    sessionGoalEnabled: enabledPreference(settings.sessionGoalEnabled),
    showAssistantTps: enabledPreference(settings.showAssistantTps),
    collapsibleThinkingBlocks: enabledPreference(settings.collapsibleThinkingBlocks),
    followUpBehavior,
    fonts: {
      ui,
      mono: family(settings.monoFont, CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, 'monospace'),
      assistantLight: rendererFamily((light ?? dark!).theme), assistantDark: rendererFamily((dark ?? light!).theme),
    },
    webTheme: { light: JSON.parse(JSON.stringify((light ?? dark!).theme)), dark: JSON.parse(JSON.stringify((dark ?? light!).theme)), uiStack, monoStack: monoStack! },
  };
}

/** Reuse the actual Web generator supplied by the GUI-only caller; do not pull
 * browser runtime modules into the native appearance sync's dependency graph. */
export function nativeFullThemeCSS(appearance: NativeAppearance | null, variant: 'light' | 'dark', generate: (theme: Theme) => string): string {
  if (!appearance?.webTheme) throw new Error('GUI_APPEARANCE_UNAVAILABLE');
  const mode = appearance.mode === 'system' ? variant : appearance.mode;
  const { uiStack, monoStack } = appearance.webTheme;
  const vars = generate(appearance.webTheme[mode]);
  const typography = (Object.keys(MOBILE_SEMANTIC_TYPOGRAPHY) as SemanticTypographyKey[]).map(key => {
    // Same mobile applyTypography contract; codeFontSize is browser-local and
    // absent from Host settings, so the canonical default code scale stays 1.
    const points = parseFloat(MOBILE_SEMANTIC_TYPOGRAPHY[key]) * 16 * (key === 'code' ? 1 : appearance.fontSize / 100);
    return `${getTypographyVariable(key)}: calc(${Math.round(points * 1000) / 1000} * var(--dpt, 1px));`;
  }).join('\n');
  return `:root {\n${vars}\n--font-sans: ${uiStack};\n--font-heading: ${uiStack};\n--font-family-sans: ${uiStack};\n--font-mono: ${monoStack};\n--font-family-mono: ${monoStack};\n--ui-regular-font-weight: 400;\n${typography}\n}\nbody { font-family: var(--font-sans); }`;
}

export function nativeTypographyStyle(appearance: AppliedNativeAppearance | null, role: SemanticTypographyKey) {
  // codeFontSize is browser-local, not present in the Host settings GET contract.
  const scale = role === 'code' ? 1 : (appearance?.fontSize ?? 100) / 100;
  const style = {
    fontFamily: role === 'code' ? appearance?.monoFontFamily ?? 'monospace' : appearance?.uiFontFamily ?? 'system-ui',
    fontSize: parseFloat(MOBILE_SEMANTIC_TYPOGRAPHY[role]) * 16 * scale,
  };
  // Same leading-relaxed body contract as shared CSSVariableGenerator, in native points.
  return role === 'markdown' ? { ...style, lineHeight: style.fontSize * 1.625 } : style;
}

export function createNativeAppearanceSync(deps: {
  readSettings: () => Promise<unknown>;
  readThemes: () => Promise<unknown>;
  reset: (scope: AppearanceScope | null) => Promise<number>;
  apply: (scope: AppearanceScope, revision: number, appearance: NativeAppearance) => Promise<Pick<AppliedNativeAppearance, 'uiFontFamily' | 'monoFontFamily' | 'assistantFontFamilies' | 'unsupportedFonts' | 'systemColorScheme'>>;
  changed: (value: AppliedNativeAppearance | null) => void;
  failed: (message: string) => void;
}) {
  let generation = 0;
  let scope: AppearanceScope | null = null;
  let revision: Promise<number> = Promise.resolve(0);
  let resetFailed = false;
  let paused = false;
  let flight: Promise<void> | undefined;
  let signature = '';
  let value: AppliedNativeAppearance | null = null;
  function setScope(next: AppearanceScope | null) {
    generation++; scope = next; flight = undefined; signature = ''; resetFailed = false; paused = false;
    value = null; deps.changed(null); deps.failed('');
    const captured = generation;
    revision = deps.reset(next);
    // Observe a reset failure even if this scope is disconnected and no GET follows.
    void revision.catch(error => {
      if (captured !== generation) return;
      resetFailed = true;
      deps.failed(error instanceof Error ? error.message : 'Native appearance reset failed');
    });
  }
  function pause() {
    generation++; flight = undefined; paused = true;
  }
  /** Native transport invalidation fences revisions even for background; restore this Host's valid palette before GET. */
  function rebind(hold = false) {
    if (!scope) return;
    generation++; flight = undefined; resetFailed = false; paused = hold;
    const captured = generation, selected = scope, previous = value;
    revision = (async () => {
      const nextRevision = await deps.reset(selected);
      if (captured === generation && previous) {
        const resolved = await deps.apply(selected, nextRevision, previous);
        if (captured === generation) { value = { ...previous, ...resolved }; deps.changed(value); }
      }
      return nextRevision;
    })();
    void revision.catch(error => {
      if (captured !== generation) return;
      resetFailed = true;
      deps.failed(error instanceof Error ? error.message : 'Native appearance restore failed');
    });
  }
  function refresh(): Promise<void> {
    if (!scope || paused) return Promise.resolve();
    if (flight) return flight;
    if (resetFailed) {
      resetFailed = false; signature = '';
      const captured = generation;
      revision = deps.reset(scope);
      void revision.catch(() => { if (captured === generation) resetFailed = true; });
    }
    const captured = generation, selected = scope, reset = revision;
    const current = () => captured === generation;
    const pending = (async () => {
      try {
        const nativeRevision = await reset;
        if (!current()) return;
        const settings = await deps.readSettings();
        if (!current()) return;
        const appearance = await appearanceFromSettings(settings, deps.readThemes);
        if (!current()) return;
        const next = JSON.stringify(appearance);
        if (next !== signature) {
          const resolved = await deps.apply(selected, nativeRevision, appearance);
          if (!current()) return;
          signature = next;
          value = { ...appearance, ...resolved }; deps.changed(value);
        }
        deps.failed('');
      } catch (error) {
        if (current()) deps.failed(error instanceof Error ? error.message : 'Native appearance sync failed');
      } finally { if (current()) flight = undefined; }
    })();
    flight = pending;
    return pending;
  }
  return {
    setScope, pause, rebind, refresh,
    hold: async () => { rebind(true); await revision; },
    resume: () => { paused = false; },
  };
}

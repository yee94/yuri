import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { Row } from './model';
import { CODE_FONT_OPTIONS, UI_FONT_OPTIONS, DEFAULT_UI_FONT } from '../ui/src/lib/fontOptions';

type Option = { value: string; title: I18nKey };
type SettingsPreferenceField = {
  key: string; id: string; page: 'appearance' | 'chat'; title: I18nKey; description?: I18nKey;
  kind: 'boolean' | 'number' | 'text'; options?: readonly Option[];
  min?: number; max?: number; initial?: unknown; consumer: 'appearance' | 'skills-editor' | 'device-preference' | 'device-chat' | 'host-runtime' | 'host-only' | 'device-cache' | 'device-local' | 'unconnected';
  /** Device/browser-local fields have no Host write contract. Only connected native owners may save them. */
  local?: boolean;
};
const visual = 'settings.yuri.visual.';
const field = (page: SettingsPreferenceField['page'], key: string, id: string, title: I18nKey, kind: SettingsPreferenceField['kind'], consumer: SettingsPreferenceField['consumer'], extra: Partial<SettingsPreferenceField> = {}): SettingsPreferenceField => ({ page, key, id: `${page}.${id}`, title, kind, consumer, ...extra });
const choices = (namespace: string, values: string[]): Option[] => values.map(value => ({ value, title: `${visual}option.${namespace}.${value}.label` as I18nKey }));
export const settingsPreferenceFields: readonly SettingsPreferenceField[] = [
  field('appearance', 'fontSize', 'font-size', 'settings.yuri.visual.field.interfaceFontSize', 'number', 'appearance', { min: 50, max: 200, initial: 100 }),
  field('appearance', 'uiFont', 'interface-font', 'settings.yuri.visual.field.interfaceFont', 'text', 'appearance', { initial: DEFAULT_UI_FONT }),
  field('appearance', 'monoFont', 'code-font', 'settings.yuri.visual.field.codeFont', 'text', 'appearance'),
  field('appearance', 'codeFontSize', 'code-font-size', 'settings.yuri.visual.field.codeFontSize', 'number', 'appearance', { min: 50, max: 200, initial: 100, local: true }),
  field('appearance', 'terminalFontSize', 'terminal-font-size', 'settings.yuri.visual.field.terminalFontSize', 'number', 'host-only', { min: 9, max: 52, initial: 13, description: 'settings.preferences.native.terminalDescription' }),
  field('appearance', 'editorFontSize', 'editor-font-size', 'settings.yuri.visual.field.editorFontSize', 'number', 'skills-editor', { min: 9, max: 32, initial: 13, local: true }),
  field('appearance', 'padding', 'spacing-density', 'settings.yuri.visual.field.spacingDensity', 'number', 'appearance', { min: 50, max: 200, initial: 100 }),
  field('appearance', 'inputBarOffset', 'input-bar-offset', 'settings.yuri.visual.field.inputBarOffset', 'number', 'host-only', { min: 0, max: 100, initial: 0, description: 'settings.preferences.native.inputOffsetDescription' }),
  field('appearance', 'fileEditorKeymap', 'file-editor-keymap', 'settings.yuri.visual.field.fileEditorKeymap', 'text', 'device-preference', { local: true, initial: 'default', options: [{ value: 'default', title: 'settings.yuri.visual.option.fileEditorKeymap.default' }, { value: 'vim', title: 'settings.yuri.visual.option.fileEditorKeymap.vim' }] }),
  field('appearance', 'timeFormatPreference', 'time-format', 'settings.yuri.visual.field.timeFormat', 'text', 'appearance', { options: choices('timeFormat', ['auto', '12h', '24h']), initial: 'auto' }),
  field('appearance', 'weekStartPreference', 'week-start', 'settings.yuri.visual.field.weekStartsOn', 'text', 'appearance', { options: choices('weekStart', ['auto', 'sunday', 'monday']), initial: 'auto' }),
  field('appearance', 'pwaAppName', 'pwa-install-name', 'settings.yuri.visual.field.installAppName', 'text', 'host-only', { initial: '', description: 'settings.yuri.visual.field.installAppNameHint' }),
  field('appearance', 'pwaOrientation', 'pwa-orientation', 'settings.yuri.visual.field.installOrientation', 'text', 'host-only', { initial: 'system', description: 'settings.yuri.visual.field.installOrientationHint', options: choices('pwaOrientation', ['system', 'portrait', 'landscape']) }),
  field('appearance', 'mobileKeyboardMode', 'mobile-keyboard-mode', 'settings.yuri.visual.field.mobileKeyboardMode', 'text', 'host-only', { initial: 'native', description: 'settings.yuri.visual.field.mobileKeyboardModeHint', options: [{ value: 'native', title: 'settings.yuri.visual.option.mobileKeyboardMode.native.label' }, { value: 'resize-content', title: 'settings.yuri.visual.option.mobileKeyboardMode.resizeContent.label' }] }),
  field('appearance', 'sidebarBrandName', 'sidebar-brand', 'settings.yuri.visual.field.sidebarBrand', 'text', 'device-preference', { local: true, description: 'settings.preferences.native.brandCompatibilityDescription' }),
  field('appearance', 'iosNativeUiEnabled', 'ios-native-ui', 'settings.yuri.visual.field.iosNativeUi', 'boolean', 'device-preference', { local: true, initial: false, description: 'settings.preferences.native.iosCompatibilityDescription' }),
  field('appearance', 'reportUsage', 'usage-reports', 'settings.yuri.visual.field.sendAnonymousUsageReports', 'boolean', 'unconnected', { initial: false, description: 'settings.preferences.native.usageDescription' }),
  field('appearance', 'transcriptCache', 'transcript-cache', 'settings.yuri.visual.transcriptCache.label', 'text', 'device-cache', { local: true }),
  field('chat', 'chatRenderMode', 'render-mode', 'settings.yuri.visual.section.chatRenderMode', 'text', 'appearance', { options: choices('chatRenderMode', ['sorted', 'live']), initial: 'sorted' }),
  field('chat', 'messageStreamTransport', 'message-transport', 'settings.yuri.visual.section.messageStreamTransport', 'text', 'appearance', { options: choices('messageTransport', ['auto', 'ws', 'sse']), initial: 'auto' }),
  field('chat', 'diffLayoutPreference', 'diff-layout', 'settings.yuri.visual.section.diffLayout', 'text', 'device-local', { local: true, initial: 'inline', options: [{ value: 'dynamic', title: 'settings.yuri.visual.option.diffLayout.auto.label' }, { value: 'inline', title: 'settings.yuri.visual.option.diffLayout.inline.label' }, { value: 'side-by-side', title: 'settings.yuri.visual.option.diffLayout.sideBySide.label' }] }),
  field('chat', 'sessionGoalEnabled', 'session-goal', 'settings.yuri.visual.field.sessionGoal', 'boolean', 'appearance', { initial: true }),
  field('chat', 'sessionTitleRefreshEnabled', 'session-title-refresh', 'settings.yuri.visual.field.sessionTitleRefresh', 'boolean', 'host-runtime', { initial: true }),
   field('chat', 'allowPromptingSubagentSessions', 'subagent-read-only-banner', 'settings.yuri.visual.field.allowPromptingSubagentSessions', 'boolean', 'device-chat', { local: true, initial: false }),
  field('chat', 'questionAutoDelegateEnabled', 'question-auto-delegate', 'settings.chat.questionDelegate.label', 'boolean', 'host-runtime', { initial: true }),
  field('chat', 'showReasoningTraces', 'reasoning-traces', 'settings.yuri.visual.field.showReasoningTraces', 'boolean', 'appearance', { initial: true }),
  field('chat', 'collapsibleThinkingBlocks', 'collapsible-thinking', 'settings.yuri.visual.field.collapsibleThinkingBlocks', 'boolean', 'appearance', { initial: true }),
  field('chat', 'collapsibleUserMessages', 'collapsible-user-messages', 'settings.yuri.visual.field.collapsibleUserMessages', 'boolean', 'device-chat', { initial: true, local: true }),
  field('chat', 'showAssistantTps', 'assistant-tps', 'settings.yuri.visual.field.showAssistantTps', 'boolean', 'appearance', { initial: true }),
  field('chat', 'followUpBehavior', 'follow-up-behavior', 'settings.yuri.visual.field.followUpBehavior', 'text', 'appearance', { options: choices('followUpBehavior', ['steer', 'queue']), initial: 'queue' }),
   field('chat', 'persistChatDraft', 'persist-drafts', 'settings.yuri.visual.field.persistDraftMessages', 'boolean', 'device-chat', { local: true, initial: true }),
];
export function settingsPreferencePatch(changes: Row): Row {
  const patch: Row = {};
  for (const [key, value] of Object.entries(changes)) {
    const spec = settingsPreferenceFields.find(item => item.key === key);
    if (!spec || spec.local) throw new Error(`No Host preference contract: ${key}`);
    if (spec.kind === 'number') {
      if (value === '' || typeof value === 'boolean' || value === null) throw new Error(key);
      const number = Number(value);
      if (!Number.isFinite(number) || number < spec.min! || number > spec.max!) throw new Error(key);
      patch[key] = Math.round(number);
    } else {
      if (typeof value !== (spec.kind === 'boolean' ? 'boolean' : 'string')) throw new Error(key);
      if (spec.options && !spec.options.some(option => option.value === value)) throw new Error(key);
      if (key === 'monoFont' && !CODE_FONT_OPTIONS.some(option => option.id === value)) throw new Error(key);
      if (key === 'uiFont' && !UI_FONT_OPTIONS.some(option => option.id === value)) throw new Error(key);
      patch[key] = key === 'pwaAppName' ? String(value).trim().replace(/\s+/g, ' ').slice(0, 64) : value;
    }
  }
  return patch;
}

/** Availability describes native consumers, independently of the Host write schema. */
export function settingsPreferenceAvailable(key: string, os: string, codeTypographyReady = false, diffPreferencesReady = false): boolean {
  const spec = settingsPreferenceFields.find(field => field.key === key);
  if (!spec) return false;
  if (key === 'codeFontSize') return codeTypographyReady && ['macos', 'windows', 'linux'].includes(os);
  if (key === 'diffLayoutPreference') return diffPreferencesReady && ['macos', 'windows', 'linux'].includes(os);
  return !spec.local && (spec.consumer === 'appearance' || spec.consumer === 'host-runtime');
}

export function settingsPreferenceVisible(key: string, os: string): boolean {
  if (key === 'iosNativeUiEnabled') return os === 'ios';
  return !['macos', 'windows', 'linux'].includes(os) || !['pwaAppName', 'pwaOrientation', 'mobileKeyboardMode'].includes(key);
}

export function settingsCodeFontSize(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string' || value === '') throw new Error('codeFontSize');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 50 || number > 200) throw new Error('codeFontSize');
  return Math.round(number);
}

/** Device-local native preference. No browser store or Host field is borrowed. */
export function createNativeCodeFontPreference(storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> }, changed: (value: number | null, unconfirmed?: boolean) => void) {
  const key = 'native-code-font-size';
  let value: number | null = null, flight: Promise<void> | undefined, writing = false, unconfirmed = false;
  const decode = (raw: string | null) => {
    if (raw === null) return 100;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'number') throw new Error('codeFontSize');
    return settingsCodeFontSize(parsed);
  };
  function load(): Promise<void> {
    if (flight) return flight;
    if (writing) return Promise.reject(new Error('codeFontSize'));
    const pending = (async () => { value = decode(await storage.getItem(key)); unconfirmed = false; changed(value, false); })();
    flight = pending;
    void pending.finally(() => { if (flight === pending) flight = undefined; }).catch(() => {});
    return pending;
  }
  return { load, async save(next: unknown) {
    const normalized = settingsCodeFontSize(next);
    if (writing || flight || value === null || unconfirmed) throw new Error('codeFontSize');
    writing = true;
    try {
      try { await storage.setItem(key, JSON.stringify(normalized)); }
      catch (failure) {
        // A lost ACK may have committed. Reconcile only; never replay a write.
        let confirmed: number;
        try { confirmed = decode(await storage.getItem(key)); }
        catch (readFailure) { unconfirmed = true; changed(value, true); throw readFailure; }
        value = confirmed; changed(value);
        if (confirmed !== normalized) throw failure;
        return;
      }
      value = normalized; changed(value);
    } finally { writing = false; }
  } };
}

/** Compare an ACKed operation with GET, never use equality to manufacture an ACK. */
export function settingsPreferenceReadbackMatches(patch: Row, snapshot: Row): boolean {
  if (!Object.keys(patch).length) return false;
  for (const [key, value] of Object.entries(patch)) {
    let expected: unknown;
    if (['themeId', 'lightThemeId', 'darkThemeId'].includes(key)) {
      if (typeof value !== 'string' || !value.trim()) return false;
      expected = value;
    } else if (key === 'themeVariant') {
      if (value !== 'light' && value !== 'dark') return false;
      expected = value;
    } else if (key === 'useSystemTheme') {
      if (typeof value !== 'boolean') return false;
      expected = value;
    } else {
      try { expected = settingsPreferencePatch({ [key]: value })[key]; }
      catch { return false; }
    }
    // Host formatter omits a cleared name override. Its other two explicit
    // defaults are system orientation and native keyboard, not UI fallbacks.
    if (snapshot[key] === undefined && (key === 'pwaAppName' && expected === '' || key === 'pwaOrientation' && expected === 'system' || key === 'mobileKeyboardMode' && expected === 'native')) continue;
    if (snapshot[key] !== expected) return false;
  }
  if ('themeId' in patch && 'themeVariant' in patch) {
    const selected = patch.themeVariant === 'light' ? 'lightThemeId' : 'darkThemeId';
    if (selected in patch && patch.themeId !== patch[selected]) return false;
  }
  return true;
}

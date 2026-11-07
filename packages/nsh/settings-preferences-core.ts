import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { Row } from './model';
import { CODE_FONT_OPTIONS } from '../ui/src/lib/fontOptions';

type Option = { value: string; title: I18nKey };
type SettingsPreferenceField = {
  key: string; id: string; page: 'appearance' | 'chat'; title: I18nKey;
  kind: 'boolean' | 'number' | 'text'; options?: readonly Option[];
  min?: number; max?: number; initial?: unknown; consumer: 'appearance' | 'host-runtime' | 'host-only' | 'unconnected';
  /** Browser-local fields have no Host write contract. They stay visible but cannot pretend to save. */
  local?: boolean;
};
const visual = 'settings.yuri.visual.';
const field = (page: SettingsPreferenceField['page'], key: string, id: string, title: I18nKey, kind: SettingsPreferenceField['kind'], consumer: SettingsPreferenceField['consumer'], extra: Partial<SettingsPreferenceField> = {}): SettingsPreferenceField => ({ page, key, id: `${page}.${id}`, title, kind, consumer, ...extra });
const choices = (namespace: string, values: string[]): Option[] => values.map(value => ({ value, title: `${visual}option.${namespace}.${value}.label` as I18nKey }));
export const settingsPreferenceFields: readonly SettingsPreferenceField[] = [
  field('appearance', 'fontSize', 'font-size', 'settings.yuri.visual.field.interfaceFontSize', 'number', 'appearance', { min: 50, max: 200, initial: 100 }),
  field('appearance', 'monoFont', 'code-font', 'settings.yuri.visual.field.codeFont', 'text', 'appearance'),
  field('appearance', 'codeFontSize', 'code-font-size', 'settings.yuri.visual.field.codeFontSize', 'number', 'unconnected', { min: 50, max: 200, local: true }),
  field('appearance', 'terminalFontSize', 'terminal-font-size', 'settings.yuri.visual.field.terminalFontSize', 'number', 'unconnected', { min: 9, max: 52, initial: 13 }),
  field('appearance', 'editorFontSize', 'editor-font-size', 'settings.yuri.visual.field.editorFontSize', 'number', 'unconnected', { min: 9, max: 32, local: true }),
  field('appearance', 'padding', 'spacing', 'settings.yuri.visual.field.spacingDensity', 'number', 'unconnected', { min: 50, max: 200, initial: 100 }),
  field('appearance', 'inputBarOffset', 'input-bar-offset', 'settings.yuri.visual.field.inputBarOffset', 'number', 'unconnected', { min: 0, max: 100, initial: 0 }),
  field('appearance', 'fileEditorKeymap', 'file-editor-keymap', 'settings.yuri.visual.field.fileEditorKeymap', 'text', 'unconnected', { local: true, options: [{ value: 'default', title: 'settings.yuri.visual.option.fileEditorKeymap.default' }, { value: 'vim', title: 'settings.yuri.visual.option.fileEditorKeymap.vim' }] }),
  field('appearance', 'timeFormatPreference', 'time-format', 'settings.yuri.visual.field.timeFormat', 'text', 'appearance', { options: choices('timeFormat', ['auto', '12h', '24h']), initial: 'auto' }),
  field('appearance', 'weekStartPreference', 'week-start', 'settings.yuri.visual.field.weekStartsOn', 'text', 'unconnected', { options: choices('weekStart', ['auto', 'sunday', 'monday']), initial: 'auto' }),
  field('appearance', 'pwaAppName', 'install-name', 'settings.yuri.visual.field.installAppName', 'text', 'host-only'),
  field('appearance', 'pwaOrientation', 'install-orientation', 'settings.yuri.visual.field.installOrientation', 'text', 'host-only', { options: choices('pwaOrientation', ['system', 'portrait', 'landscape']) }),
  field('appearance', 'mobileKeyboardMode', 'mobile-keyboard-mode', 'settings.yuri.visual.field.mobileKeyboardMode', 'text', 'host-only', { options: [{ value: 'native', title: 'settings.yuri.visual.option.mobileKeyboardMode.native.label' }, { value: 'resize-content', title: 'settings.yuri.visual.option.mobileKeyboardMode.resizeContent.label' }] }),
  field('appearance', 'sidebarBrandName', 'sidebar-brand', 'settings.yuri.visual.field.sidebarBrand', 'text', 'unconnected', { local: true }),
  field('appearance', 'iosNativeUiEnabled', 'ios-native-ui', 'settings.yuri.visual.field.iosNativeUi', 'boolean', 'unconnected', { local: true }),
  field('appearance', 'reportUsage', 'usage-reports', 'settings.yuri.visual.field.sendAnonymousUsageReports', 'boolean', 'unconnected'),
  field('appearance', 'transcriptCache', 'transcript-cache', 'settings.yuri.visual.transcriptCache.label', 'text', 'unconnected', { local: true }),
  field('chat', 'chatRenderMode', 'render-mode', 'settings.yuri.visual.section.chatRenderMode', 'text', 'appearance', { options: choices('chatRenderMode', ['sorted', 'live']), initial: 'sorted' }),
  field('chat', 'messageStreamTransport', 'message-transport', 'settings.yuri.visual.section.messageStreamTransport', 'text', 'unconnected', { options: choices('messageTransport', ['auto', 'ws', 'sse']), initial: 'auto' }),
  field('chat', 'diffLayoutPreference', 'diff-layout', 'settings.yuri.visual.section.diffLayout', 'text', 'unconnected', { initial: 'inline', options: [{ value: 'dynamic', title: 'settings.yuri.visual.option.diffLayout.auto.label' }, { value: 'inline', title: 'settings.yuri.visual.option.diffLayout.inline.label' }, { value: 'side-by-side', title: 'settings.yuri.visual.option.diffLayout.sideBySide.label' }] }),
  field('chat', 'sessionGoalEnabled', 'session-goal', 'settings.yuri.visual.field.sessionGoal', 'boolean', 'appearance', { initial: true }),
  field('chat', 'sessionTitleRefreshEnabled', 'session-title-refresh', 'settings.yuri.visual.field.sessionTitleRefresh', 'boolean', 'host-runtime', { initial: true }),
  field('chat', 'allowPromptingSubagentSessions', 'subagent-read-only', 'settings.yuri.visual.field.allowPromptingSubagentSessions', 'boolean', 'unconnected', { local: true }),
  field('chat', 'questionAutoDelegateEnabled', 'question-auto-delegate', 'settings.chat.questionDelegate.label', 'boolean', 'host-runtime', { initial: true }),
  field('chat', 'showReasoningTraces', 'reasoning-traces', 'settings.yuri.visual.field.showReasoningTraces', 'boolean', 'appearance', { initial: true }),
  field('chat', 'collapsibleThinkingBlocks', 'collapsible-thinking', 'settings.yuri.visual.field.collapsibleThinkingBlocks', 'boolean', 'appearance', { initial: true }),
  field('chat', 'collapsibleUserMessages', 'collapsible-user-messages', 'settings.yuri.visual.field.collapsibleUserMessages', 'boolean', 'appearance', { initial: true, local: true }),
  field('chat', 'showAssistantTps', 'assistant-tps', 'settings.yuri.visual.field.showAssistantTps', 'boolean', 'appearance', { initial: true }),
  field('chat', 'followUpBehavior', 'follow-up-behavior', 'settings.yuri.visual.field.followUpBehavior', 'text', 'unconnected', { options: choices('followUpBehavior', ['steer', 'queue']), initial: 'queue' }),
  field('chat', 'persistChatDraft', 'persist-drafts', 'settings.yuri.visual.field.persistDraftMessages', 'boolean', 'unconnected', { local: true }),
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
      patch[key] = key === 'pwaAppName' ? String(value).trim().replace(/\s+/g, ' ').slice(0, 64) : value;
    }
  }
  return patch;
}

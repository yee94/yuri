import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { settingsPreferenceFields } from './settings-preferences-core';
import { settingsBasicSections, settingsBasicTarget } from './settings-basics-core';
import { retentionSearchItems } from './settings-retention-search';

export type SettingsSearchItem = { page: 'appearance' | 'chat' | 'sessions' | 'summary-ai' | 'notifications' | 'behavior' | 'voice' | 'about' | 'git'; id: string; title: I18nKey; keywords: string };
export const settingsSearchItems: readonly SettingsSearchItem[] = [
  ...retentionSearchItems,
  { page: 'git', id: 'git.github-account', title: 'settings.github.page.oauth.title', keywords: 'GitHub OAuth device account CLI 账户 授权' },
  { page: 'git', id: 'git.discovered-credentials', title: 'settings.gitIdentities.page.discoveredCredentials.title', keywords: 'git credentials token import discovered 凭据 导入' },
  ...settingsPreferenceFields.map(field => ({ page: field.page, id: field.id, title: field.title, keywords: `${field.key} ${field.id} ${(field.options || []).map(option => option.value).join(' ')}` })),
  ...settingsBasicSections.flatMap(section => section.fields.map(field => ({ page: section.page, id: settingsBasicTarget(section.page, field), title: field.title, keywords: `${field.key} ${(field.options || []).join(' ')}` }))),
  { page: 'behavior', id: 'behavior.system-prompt', title: 'settings.behavior.page.section.systemPrompt', keywords: 'AGENTS.md system prompt 行为 指令' },
  { page: 'appearance', id: 'appearance.theme-mode', title: 'settings.yuri.visual.field.themeMode', keywords: 'theme system light dark 主题 明暗' },
  { page: 'appearance', id: 'appearance.light-theme', title: 'settings.yuri.visual.field.lightTheme', keywords: 'palette color light 亮色 主题' },
  { page: 'appearance', id: 'appearance.dark-theme', title: 'settings.yuri.visual.field.darkTheme', keywords: 'palette color dark 暗色 主题' },
  { page: 'appearance', id: 'appearance.language', title: 'settings.appearance.language.label', keywords: 'locale language 语言 語言' },
  { page: 'sessions', id: 'sessions.default-model', title: 'settings.yuri.defaults.field.defaultModel', keywords: 'default model 模型 provider' },
  { page: 'sessions', id: 'sessions.default-thinking', title: 'settings.yuri.defaults.field.defaultThinking', keywords: 'thinking reasoning variant 推理 思考' },
  { page: 'sessions', id: 'sessions.default-agent', title: 'settings.yuri.defaults.field.defaultAgent', keywords: 'default agent 默认 智能体' },
  { page: 'summary-ai', id: 'summary-ai.configuration', title: 'settings.yuri.defaults.summary.providerModel', keywords: 'summary model provider 摘要 模型' },
  { page: 'summary-ai', id: 'summary-ai.test-connection', title: 'settings.yuri.defaults.summary.testConnection', keywords: 'test connection 连接 测试' },
  { page: 'summary-ai', id: 'summary-ai.commit-prompt', title: 'settings.yuri.defaults.summary.commitPrompt', keywords: 'git commit prompt 提交 提示词' },
  { page: 'summary-ai', id: 'summary-ai.title-prompt', title: 'settings.yuri.defaults.summary.sessionTitlePrompt', keywords: 'session title prompt 标题 提示词' },
  { page: 'about', id: 'about.feedback', title: 'settings.yuri.about.actions.submitFeedback', keywords: 'feedback issue 反馈' },
  { page: 'about', id: 'about.host-update', title: 'settings.yuri.about.hostUpdate.title', keywords: 'host update version 服务 更新 版本' },
  { page: 'about', id: 'about.check-updates', title: 'settings.yuri.about.actions.checkForUpdates', keywords: 'client update native unsupported 客户端 更新' },
  { page: 'about', id: 'about.beta-updates', title: 'settings.yuri.about.betaUpdates.label', keywords: 'client beta update unsupported 测试版 更新' },
  { page: 'about', id: 'about.diagnostics', title: 'settings.yuri.about.diagnostics.label', keywords: 'diagnostics snapshot 诊断 快照' },
  { page: 'about', id: 'about.export-diagnostics', title: 'settings.yuri.about.diagnostics.export', keywords: 'export share diagnostics snapshot 导出 分享 诊断' },
];
export function searchSettingsFields(query: string, translate: (key: I18nKey) => string): SettingsSearchItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return settingsSearchItems.filter(item => {
    const searchable = `${translate(item.title)} ${item.keywords}`.toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}
type Measurable = { measure: () => Promise<{ pagePosition: { y: number } } | null> };
type SettingsScroll = Measurable & { scrollTo: (options: { y: number; animated: boolean }) => void };
/** Layout owns the actual field offset. Never reorder controls or estimate heights for search. */
export function createSettingsTargetNavigation(scroll: () => SettingsScroll | undefined, current: () => boolean, capture?: () => () => boolean) {
  let offset = 0, completed = false, pending = false;
  return {
    onScroll: (event: { offset: { y: number } }) => { offset = event.offset.y; },
    async reveal(target: Measurable) {
      const isCurrent = capture?.() ?? current;
      const container = scroll();
      if (!container || completed || pending || !isCurrent()) return;
      pending = true;
      try {
        const [field, viewport] = await Promise.all([target.measure(), container.measure()]);
        if (!field || !viewport || !isCurrent()) return;
        const y = Math.max(0, offset + field.pagePosition.y - viewport.pagePosition.y);
        if (!Number.isFinite(y)) return;
        container.scrollTo({ y, animated: false }); completed = true;
      } finally { pending = false; }
    },
  };
}

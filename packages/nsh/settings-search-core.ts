import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { settingsPreferenceFields } from './settings-preferences-core';
import { settingsBasicSections, settingsBasicTarget } from './settings-basics-core';
import { retentionSearchItems } from './settings-retention-search';

export type SettingsSearchItem = { page: 'appearance' | 'chat' | 'sessions' | 'summary-ai' | 'notifications' | 'behavior' | 'voice' | 'about' | 'git' | 'agents' | 'commands' | 'mcp' | 'skills.installed'; id: string; title: I18nKey; keywords: string };
const collectionSearchItems: readonly SettingsSearchItem[] = [
  { page: 'agents', id: 'agents.name', title: 'settings.agents.page.field.agentName', keywords: 'agent name 智能体 名称' },
  { page: 'agents', id: 'agents.mode', title: 'settings.agents.page.field.mode', keywords: 'primary subagent visibility 模式' },
  { page: 'agents', id: 'agents.scope', title: 'settings.agents.page.field.scope', keywords: 'scope project user global 范围 项目' },
  { page: 'agents', id: 'agents.model', title: 'settings.agents.page.field.overrideModel', keywords: 'model provider variant 模型 思考' },
  { page: 'agents', id: 'agents.system-prompt', title: 'settings.agents.page.section.systemPrompt', keywords: 'prompt instructions 系统 提示词' },
  { page: 'agents', id: 'agents.permissions', title: 'settings.agents.page.section.toolPermissions', keywords: 'tools permissions allow ask deny 权限 工具' },
  { page: 'commands', id: 'commands.name', title: 'settings.commands.page.field.commandName', keywords: 'slash command name 命令 名称' },
  { page: 'commands', id: 'commands.agent', title: 'settings.commands.page.field.overrideAgent', keywords: 'command agent execution 智能体' },
  { page: 'commands', id: 'commands.model', title: 'settings.agents.page.field.overrideModel', keywords: 'command model provider 模型' },
  { page: 'commands', id: 'commands.template', title: 'settings.commands.page.section.template', keywords: 'prompt template arguments shell file 命令 模板' },
  { page: 'mcp', id: 'mcp.server', title: 'settings.mcp.page.server.title', keywords: 'server name transport 服务器' },
  { page: 'mcp', id: 'mcp.command', title: 'settings.mcp.page.connection.command', keywords: 'stdio local command 本地 命令' },
  { page: 'mcp', id: 'mcp.environment', title: 'settings.mcp.page.env.title', keywords: 'env variables api key 环境变量' },
  { page: 'mcp', id: 'mcp.advanced', title: 'settings.mcp.page.advanced.title', keywords: 'oauth headers timeout 认证 请求头 超时' },
  { page: 'skills.installed', id: 'skills.basic-information', title: 'settings.skills.page.section.basicInformation', keywords: 'skill name description 技能 名称 描述' },
  { page: 'skills.installed', id: 'skills.instructions', title: 'settings.skills.page.section.instructions', keywords: 'skill instructions prompt 技能 指令' },
  { page: 'skills.installed', id: 'skills.supporting-files', title: 'settings.skills.page.section.supportingFiles', keywords: 'skill supporting files 技能 文件' },
];
/** Stable field search opens a local draft before reveal; no entity or project is guessed. */
export function prepareCollectionSearchTarget(page: string, target?: string): { create: true; draft: Record<string, unknown> } | null {
  if (!target || !collectionSearchItems.some(item => item.page === page && item.id === target)) return null;
  return { create: true, draft: target === 'mcp.advanced' ? { type: 'remote' } : target === 'mcp.command' ? { type: 'local' } : {} };
}
export const settingsSearchItems: readonly SettingsSearchItem[] = [
  ...collectionSearchItems,
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
  { page: 'sessions', id: 'sessions.opencode-binary', title: 'settings.yuri.opencodeCli.field.binaryPath', keywords: 'OpenCode CLI binary executable path reload 命令行 路径 重载' },
  { page: 'sessions', id: 'sessions.opencode-update-notifications', title: 'settings.yuri.opencodeCli.field.showUpdateNotifications', keywords: 'OpenCode CLI update upgrade notifications 升级 更新 通知' },
  { page: 'sessions', id: 'sessions.passkeys', title: 'settings.yuri.passkeys.title', keywords: 'passkey management WebAuthn authentication security sign out 通行密钥 管理 认证 安全 登出' },
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

import type { SettingsSearchItem } from './settings-search-core';

/** Main appends these only after mounting SettingsSessionRetentionSection, without duplicating Basic targets. */
export const retentionSearchItems: readonly SettingsSearchItem[] = [
  { page: 'sessions', id: 'sessions.autoDeleteEnabled', title: 'settings.yuri.sessionRetention.field.enableAutoCleanup', keywords: 'retention auto cleanup 清理 自动 归档' },
  { page: 'sessions', id: 'sessions.autoDeleteAfterDays', title: 'settings.yuri.sessionRetention.field.retentionPeriod', keywords: 'retention days 保留 天数' },
  { page: 'sessions', id: 'sessions.sessionRetentionAction', title: 'settings.yuri.sessionRetention.field.whenSessionsExpire', keywords: 'retention archive delete 归档 删除' },
  { page: 'sessions', id: 'sessions.retention-cleanup', title: 'settings.yuri.sessionRetention.manualCleanup.title', keywords: 'cleanup candidates retry 清理 候选 重试' },
];

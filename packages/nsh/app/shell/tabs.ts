import type { I18nKey } from '../core/i18n';

export type TabID = 'projects' | 'assistant' | 'scheduled' | 'settings';

export type TabDefinition = {
  id: TabID;
  /** The platform's own symbol name (SF Symbols on iOS). */
  symbol: string;
  labelKey: I18nKey;
};

/** Web `MOBILE_TABS`: same order, same labels. */
export const TABS: TabDefinition[] = [
  { id: 'projects', symbol: 'folder', labelKey: 'mobile.tabs.projects' },
  { id: 'assistant', symbol: 'sparkles', labelKey: 'mobile.tabs.assistant' },
  { id: 'scheduled', symbol: 'calendar', labelKey: 'mobile.tabs.scheduled' },
  { id: 'settings', symbol: 'gearshape', labelKey: 'mobile.tabs.settings' },
];

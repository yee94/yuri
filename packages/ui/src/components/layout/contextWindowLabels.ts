import type { useI18n } from '@/lib/i18n';
import type { ContextItem, ContextPartKind } from './contextWindowMap';

type Translate = ReturnType<typeof useI18n>['t'];

export const PART_LABEL_KEYS = {
  system: 'contextSidebar.window.part.system',
  files: 'contextSidebar.window.part.files',
  results: 'contextSidebar.window.part.results',
  chat: 'contextSidebar.window.part.chat',
} as const;

export const PIECE_ROLE_KEYS = {
  system: 'contextSidebar.window.role.system',
  user: 'contextSidebar.window.role.user',
  assistant: 'contextSidebar.window.role.assistant',
  thinking: 'contextSidebar.window.role.thinking',
  call: 'contextSidebar.window.role.call',
  result: 'contextSidebar.window.role.result',
} as const;

export const partLabel = (t: Translate, kind: ContextPartKind): string => t(PART_LABEL_KEYS[kind]);

export const splitPath = (name: string): { base: string; dir: string } => {
  const at = name.lastIndexOf('/');
  return at < 0 ? { base: name, dir: '' } : { base: name.slice(at + 1), dir: name.slice(0, at + 1) };
};

export const itemName = (t: Translate, item: ContextItem): string => {
  if (item.kind === 'baseline') return partLabel(t, 'system');
  if (item.kind === 'turn') return t('contextSidebar.window.turn', { n: item.name });
  return item.name;
};

/** The tool-ish word beside a row; turns and the initial prompt have none. */
export const itemTag = (item: ContextItem): string => (item.kind === 'file' ? 'read' : item.kind === 'tool' ? 'result' : '');

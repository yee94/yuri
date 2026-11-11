import type { AssistantLatestMessagePreview } from '@/queries/assistantDTO';

export const ASSISTANT_MESSAGE_PREVIEW_CLASS = 'block min-w-0 max-w-full truncate typography-micro text-muted-foreground';

const fallbackKeys = {
  image: 'assistants.contact.attachment.image',
  file: 'assistants.contact.attachment.file',
  session: 'assistants.contact.card.session.untitled',
  assistant: 'assistants.title',
  schedule: 'assistants.settings.scheduledTasks.title',
} as const;

type PreviewLabelKey = typeof fallbackKeys[keyof typeof fallbackKeys] | 'assistants.contact.empty';

/** Snapshot owns message selection and ordering; this only formats bounded visible text. */
export function getAssistantMessagePreview(
  preview: AssistantLatestMessagePreview | null | undefined,
  t: (key: PreviewLabelKey) => string,
): string {
  const source = preview?.text ?? '';
  const text = (preview?.fallbackKind ? source : source
    .replace(/^\s{0,3}(?:`{3,}|~{3,})[\w+-]*(?:\s+|$)/gmu, '')
    .replace(/`{3,}|~{3,}/gu, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|(?:>\s*)+|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gmu, '')
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*(?:\)|$)/gu, '$1')
    .replace(/!\[([^\]\n]*)(?:\]|$)/gu, '$1')
    .replace(/(`+)([^`\n]+)\1/gu, '$2')
    .replace(/(\*{1,3}|~~)(?=\S)(.+?)\1/gu, '$2')
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.+?)\1(?![\p{L}\p{N}_])/gu, '$2')
  ).replace(/\s+/gu, ' ').trim();
  if (text) return text;
  return t(preview?.fallbackKind ? fallbackKeys[preview.fallbackKind] : 'assistants.contact.empty');
}

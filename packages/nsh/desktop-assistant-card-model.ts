import { readSessionChangeSummary, readSessionModelLabel } from '../ui/src/lib/sessionChangeSummary';
import { getScheduleCardPresentation, resolveScheduleCard } from './desktop-assistant-card-schedule';
import type { AssistantContactScheduleCardPart } from '../ui/src/queries/assistantDTO';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { Row } from './model';

type Translate = (key: I18nKey) => string;
const string = (value: unknown) => typeof value === 'string' ? value : '';
const trimmed = (value: unknown) => string(value).trim();

/** Web priority, without inventing busy when neither source knows a status. */
export function desktopAssistantCardStatus(live: string | undefined, persisted: unknown): string | null {
  if (persisted === 'cancelled') return persisted;
  if (live === 'busy' || live === 'retry') return live;
  if (persisted === 'error' || persisted === 'question' || persisted === 'complete' || persisted === 'busy' || persisted === 'retry') return persisted;
  if (live === 'idle') return 'complete';
  return trimmed(persisted) || null;
}

export function desktopAssistantCardStatusKey(status: string | null): I18nKey | null {
  switch (status) {
    case 'cancelled': return 'assistants.contact.card.session.status.cancelled';
    case 'busy': return 'assistants.contact.card.session.status.busy';
    case 'retry': return 'assistants.contact.card.session.status.retry';
    case 'idle': return 'assistants.contact.card.session.status.idle';
    case 'complete': return 'assistants.contact.card.session.status.complete';
    case 'error': return 'assistants.contact.card.session.status.error';
    case 'question': return 'assistants.contact.card.session.status.question';
    default: return null;
  }
}

export function desktopAssistantSessionCard(card: Readonly<Row>, session?: Readonly<Row> | null, liveStatus?: { readonly type?: string } | null, branch?: string | null) {
  const directory = trimmed(session?.directory) || string(card.directory);
  const status = desktopAssistantCardStatus(liveStatus?.type, card.status);
  return {
    title: trimmed(session?.title) || string(card.title), directory,
    project: directory.split(/[/\\]/u).filter(Boolean).at(-1) || directory,
    // Web reads the current branch source, never the historical receipt's branch.
    branch: trimmed(branch) || null, status, statusKey: desktopAssistantCardStatusKey(status),
    model: readSessionModelLabel(session),
    changes: status === 'complete' || status === 'idle' ? readSessionChangeSummary(session) : null,
  };
}

/** Adapt only the card's own fields, retaining absent-vs-null legacy semantics. */
export function desktopAssistantScheduleCard(card: Readonly<Row>, task: Readonly<Row> | null | undefined, t: Translate) {
  const source: AssistantContactScheduleCardPart = {
    type: 'card', cardType: 'schedule', taskID: string(card.taskID), projectID: string(card.projectID), name: string(card.name),
    kind: typeof card.kind === 'string' ? card.kind : null,
    time: typeof card.time === 'string' ? card.time : null,
    timezone: typeof card.timezone === 'string' ? card.timezone : null,
    prompt: typeof card.prompt === 'string' ? card.prompt : null,
    ...(card.cron !== undefined ? { cron: typeof card.cron === 'string' ? card.cron : null } : {}),
    ...(card.date !== undefined ? { date: typeof card.date === 'string' ? card.date : null } : {}),
    ...(card.times !== undefined ? { times: Array.isArray(card.times) ? card.times.filter((value): value is string => typeof value === 'string') : null } : {}),
    ...(card.weekdays !== undefined ? { weekdays: Array.isArray(card.weekdays) ? card.weekdays.filter((value): value is number => typeof value === 'number') : null } : {}),
  };
  return getScheduleCardPresentation(resolveScheduleCard(source, task), t);
}

export function desktopAssistantCardNavigable(card: Readonly<Row>, session?: Readonly<Row> | null): boolean {
  if (card.cardType === 'session') return !!trimmed(card.sessionID) && !!(trimmed(session?.directory) || trimmed(card.directory));
  if (card.cardType === 'assistant') return !!trimmed(card.assistantID);
  return card.cardType === 'schedule' && !!trimmed(card.projectID) && !!trimmed(card.taskID);
}

/** Only a complete provider/model identity can select a provider artwork. */
export function desktopAssistantCardProvider(value: string): string | null {
  const slash = value.indexOf('/');
  return slash > 0 && value.slice(slash + 1).trim() ? value.slice(0, slash) : null;
}

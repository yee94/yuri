import type { AssistantContactScheduleCardPart } from '../ui/src/queries/assistantDTO';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

/** Native type boundary only; runtime exports are the unchanged shared pure functions. */
export function resolveScheduleCard(card: AssistantContactScheduleCardPart, task?: Readonly<Record<string, unknown>> | null): AssistantContactScheduleCardPart;
export function getScheduleCardPresentation(card: AssistantContactScheduleCardPart, t: (key: I18nKey) => string): { value: string; cadence: string; clock: boolean; timezone: string | null };

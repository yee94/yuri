import type { QuestionInfo, QuestionRequest } from '../ui/src/types/question';
import { isQuestionFormMetadata, mapV2QuestionRequest } from '../ui/src/sync/question-form';
import { list, record, text, type Row } from './model';

export const SUMMARY_TAB = 'summary';

export type QuestionDraft = {
  activeTab: string;
  selectedOptions: Record<number, string[]>;
  customMode: Record<number, boolean>;
  customText: Record<number, string>;
};

export const EMPTY_QUESTION_DRAFT: QuestionDraft = { activeTab: '0', selectedOptions: {}, customMode: {}, customText: {} };

export const isQuestionForm = (form: Row) => isQuestionFormMetadata(form.metadata);
export const questionScope = (request: Pick<QuestionRequest, 'sessionID' | 'id'>) => `${request.sessionID}:${request.id}`;

/** Mirrors Web `questionRequestFromFormProperties`: only official question-tool forms become question cards. */
export function questionFromForm(form: Row): QuestionRequest | null {
  if (!isQuestionForm(form)) return null;
  const id = text(form.id), sessionID = text(form.sessionID) || text(form.sessionId);
  if (!id || !sessionID) return null;
  const fields = list(form.fields).flatMap(field => {
    const key = text(field.key);
    if (!key) return [];
    const options = list(field.options).map(option => ({
      ...(typeof option.label === 'string' ? { label: option.label } : {}),
      ...(typeof option.value === 'string' ? { value: option.value } : {}),
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }));
    return [{
      key,
      ...(typeof field.type === 'string' ? { type: field.type } : {}),
      ...(typeof field.title === 'string' ? { title: field.title } : {}),
      ...(typeof field.description === 'string' ? { description: field.description } : {}),
      ...(options.length ? { options } : {}),
    }];
  });
  const metadata = record(form.metadata);
  return mapV2QuestionRequest({
    id, sessionID,
    title: typeof form.title === 'string' ? form.title : undefined,
    ...(fields.length ? { fields } : {}),
    metadata,
  });
}

export function activeQuestionIndex(draft: QuestionDraft, count: number) {
  return draft.activeTab === SUMMARY_TAB ? -1 : Math.max(0, Math.min(count - 1, Number(draft.activeTab) || 0));
}

export function questionTabs(questions: readonly QuestionInfo[], summaryLabel: string) {
  const tabs = questions.map((question, index) => ({ value: String(index), label: question.header?.trim() || `Q${index + 1}` }));
  return questions.length > 1 ? [...tabs, { value: SUMMARY_TAB, label: summaryLabel }] : tabs;
}

export function customAnswer(draft: QuestionDraft, index: number) { return (draft.customText[index] ?? '').trim(); }

export function unansweredIndexes(questions: readonly QuestionInfo[], draft: QuestionDraft) {
  const pending: number[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    if (draft.customMode[index] ? !customAnswer(draft, index) : (draft.selectedOptions[index] ?? []).length === 0) pending.push(index);
  }
  return pending;
}

export function buildAnswers(questions: readonly QuestionInfo[], draft: QuestionDraft): string[][] {
  return questions.map((_, index) => {
    if (draft.customMode[index]) { const value = customAnswer(draft, index); return value ? [value] : []; }
    return draft.selectedOptions[index] ?? [];
  });
}

/** Next unanswered question after the active one, wrapping; the Summary tab starts from the first. */
export function nextUnansweredIndex(count: number, unanswered: readonly number[], draft: QuestionDraft): number | null {
  if (!count || !unanswered.length) return null;
  const start = draft.activeTab === SUMMARY_TAB ? -1 : activeQuestionIndex(draft, count);
  for (let offset = 1; offset <= count; offset += 1) {
    const candidate = (start + offset + count) % count;
    if (unanswered.includes(candidate)) return candidate;
  }
  return unanswered[0];
}

export function toggleOption(draft: QuestionDraft, index: number, label: string, multiple: boolean): QuestionDraft {
  const current = draft.selectedOptions[index] ?? [];
  const next = multiple ? current.includes(label) ? current.filter(item => item !== label) : [...current, label] : [label];
  return { ...draft, selectedOptions: { ...draft.selectedOptions, [index]: next }, customMode: { ...draft.customMode, [index]: false } };
}

export function selectCustom(draft: QuestionDraft, index: number): QuestionDraft {
  return { ...draft, customMode: { ...draft.customMode, [index]: true }, selectedOptions: { ...draft.selectedOptions, [index]: [] } };
}

export function setCustomText(draft: QuestionDraft, index: number, value: string): QuestionDraft {
  return { ...draft, customText: { ...draft.customText, [index]: value } };
}

export function answerDisplay(draft: QuestionDraft, index: number): string {
  if (draft.customMode[index]) return customAnswer(draft, index);
  return (draft.selectedOptions[index] ?? []).join(', ');
}

export const isRecommended = (label: string) => /\(recommended\)/i.test(label);

/** Matches Web `isQuestionRequestNotFoundError`. */
export function isQuestionRequestNotFound(error: unknown): boolean {
  const status = record(error).status;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Question(?:\.)?NotFoundError|Question request not found/i.test(message);
}

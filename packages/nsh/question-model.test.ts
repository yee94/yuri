import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUESTION_DRAFT, SUMMARY_TAB, answerDisplay, buildAnswers, isQuestionForm, isQuestionRequestNotFound,
  nextUnansweredIndex, questionFromForm, questionTabs, selectCustom, setCustomText, toggleOption, unansweredIndexes,
} from './question-model';
import { nativeQuestionBody, nativeToolDescription, nativeToolDetails } from './transcript-tools-model';

const form = {
  id: 'frm_1', sessionID: 'ses_1', title: 'Pick', metadata: { kind: 'question', tool: { messageID: 'msg_1', id: 'call_1' } },
  fields: [
    { key: 'q0', type: 'string', title: 'Platform', description: 'Which platform?', options: [{ label: 'iOS', value: 'ios', description: 'Apple' }, { label: 'Android', value: 'android' }] },
    { key: 'q1', type: 'multiselect', title: 'Areas', description: 'Which areas?', options: [{ label: 'UI', value: 'ui' }, { label: 'Sync', value: 'sync' }] },
  ],
};

describe('question form projection', () => {
  it('turns only question-tool forms into question requests', () => {
    expect(isQuestionForm({ metadata: { kind: 'form' } })).toBe(false);
    expect(questionFromForm({ ...form, metadata: {} })).toBeNull();
    expect(questionFromForm({ ...form, id: '' })).toBeNull();
    expect(questionFromForm(form)).toEqual({
      id: 'frm_1', sessionID: 'ses_1',
      questions: [
        { question: 'Which platform?', header: 'Platform', options: [{ label: 'iOS', description: 'Apple' }, { label: 'Android', description: '' }] },
        { question: 'Which areas?', header: 'Areas', options: [{ label: 'UI', description: '' }, { label: 'Sync', description: '' }], multiple: true },
      ],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    });
  });
});

describe('question draft rules (Web QuestionCard)', () => {
  const request = questionFromForm(form)!;
  it('tracks unanswered questions, custom answers, and the next tab', () => {
    let draft = EMPTY_QUESTION_DRAFT;
    expect(unansweredIndexes(request.questions, draft)).toEqual([0, 1]);
    draft = toggleOption(draft, 0, 'iOS', false);
    draft = toggleOption(draft, 0, 'Android', false);
    expect(draft.selectedOptions[0]).toEqual(['Android']);
    expect(nextUnansweredIndex(2, unansweredIndexes(request.questions, draft), draft)).toBe(1);
    draft = toggleOption(toggleOption(draft, 1, 'UI', true), 1, 'Sync', true);
    expect(buildAnswers(request.questions, draft)).toEqual([['Android'], ['UI', 'Sync']]);
    draft = toggleOption(draft, 1, 'UI', true);
    expect(draft.selectedOptions[1]).toEqual(['Sync']);
    expect(unansweredIndexes(request.questions, draft)).toEqual([]);
  });
  it('switching to Other clears picks, requires trimmed text, and choosing an option leaves Other', () => {
    let draft = toggleOption(EMPTY_QUESTION_DRAFT, 0, 'iOS', false);
    draft = selectCustom(draft, 0);
    expect(draft.selectedOptions[0]).toEqual([]);
    expect(unansweredIndexes(request.questions, draft)).toContain(0);
    draft = setCustomText(draft, 0, '  Web  ');
    expect(buildAnswers(request.questions, draft)[0]).toEqual(['Web']);
    expect(answerDisplay(draft, 0)).toBe('Web');
    expect(unansweredIndexes(request.questions, draft)).not.toContain(0);
    draft = toggleOption(draft, 0, 'iOS', false);
    expect(draft.customMode[0]).toBe(false);
    expect(draft.customText[0]).toBe('  Web  ');
    expect(buildAnswers(request.questions, draft)[0]).toEqual(['iOS']);
  });
  it('adds a Summary tab only for several questions and wraps from it', () => {
    expect(questionTabs(request.questions, 'Summary').map(tab => tab.value)).toEqual(['0', '1', SUMMARY_TAB]);
    expect(questionTabs(request.questions.slice(0, 1), 'Summary')).toHaveLength(1);
    expect(nextUnansweredIndex(2, [0, 1], { ...EMPTY_QUESTION_DRAFT, activeTab: SUMMARY_TAB })).toBe(0);
    expect(nextUnansweredIndex(2, [0], { ...EMPTY_QUESTION_DRAFT, activeTab: '0' })).toBe(0);
    expect(nextUnansweredIndex(2, [], EMPTY_QUESTION_DRAFT)).toBeNull();
  });
  it('recognizes stale requests like Web', () => {
    expect(isQuestionRequestNotFound({ status: 404 })).toBe(true);
    expect(isQuestionRequestNotFound(new Error('Question request not found'))).toBe(true);
    expect(isQuestionRequestNotFound(new Error('boom'))).toBe(false);
  });
});

describe('question tool transcript row', () => {
  const tool = (state: Record<string, unknown>) => ({ id: 'c1', name: 'question', state });
  const input = { questions: [{ header: 'Platform', question: 'Which platform?', options: [{ label: 'iOS' }, { label: 'Android' }] }] };
  it('summarizes, lists asked questions, and parses answers', () => {
    const asking = nativeToolDetails(tool({ status: 'running', input }));
    expect(nativeToolDescription(asking, '/repo')).toBe('Asked 1 question');
    expect(nativeQuestionBody(asking)).toEqual({ kind: 'questions', items: [{ header: 'Platform', question: 'Which platform?', options: ['iOS', 'Android'] }] });
    const answered = nativeToolDetails(tool({ status: 'completed', input, output: 'User has answered your questions: "Which platform?"="iOS". You can now continue with the user\'s answers in mind.' }));
    expect(nativeQuestionBody(answered)).toEqual({ kind: 'answers', items: [{ question: 'Which platform?', answer: 'iOS' }] });
    expect(nativeQuestionBody(nativeToolDetails(tool({ status: 'pending', input: {} })))).toEqual({ kind: 'awaiting' });
    expect(nativeQuestionBody(nativeToolDetails(tool({ status: 'error', input, error: 'x' })))).toBeNull();
    expect(nativeQuestionBody(nativeToolDetails({ id: 'b', name: 'bash', state: { status: 'completed', input: {} } }))).toBeNull();
  });
});

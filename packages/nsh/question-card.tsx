import { Clipboard, cleanup, computed, signal, Text, token, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { Row } from './model';
import {
  EMPTY_QUESTION_DRAFT, SUMMARY_TAB, activeQuestionIndex, answerDisplay, buildAnswers, isQuestionRequestNotFound,
  isRecommended, nextUnansweredIndex, questionFromForm, questionScope, questionTabs, selectCustom, setCustomText,
  toggleOption, unansweredIndexes, type QuestionDraft,
} from './question-model';
import type { createChat } from './state';
import type { QuestionRequest } from '../ui/src/types/question';
import { serializeQuestionAsJson, serializeQuestionAsMarkdown } from '../ui/src/components/chat/questionSerializers';

export type QuestionScope = {
  chat: Pick<ReturnType<typeof createChat>, 'replyQuestion' | 'dismissQuestion'>;
  disabled: () => boolean;
  perform: (work: () => Promise<void>, failure: (message: string) => void) => Promise<void>;
};

// Drafts outlive the card, like Web's questionDraftStore: remounting the transcript must not lose answers.
const drafts = signal<Record<string, QuestionDraft>>({});
const draftOf = (scope: string) => drafts()[scope] ?? EMPTY_QUESTION_DRAFT;
const patchDraft = (scope: string, update: (draft: QuestionDraft) => QuestionDraft) => drafts.set({ ...drafts(), [scope]: update(draftOf(scope)) });
function discardDraft(scope: string) {
  if (!(scope in drafts())) return;
  const next = { ...drafts() };
  delete next[scope];
  drafts.set(next);
}

const frame = 'overflow-hidden rounded-xl border border-border/30 bg-muted/10';
const tabBase = 'min-h-8 px-2.5 rounded-lg flex-row items-center gap-1 active:bg-accent';
const row = 'w-full min-h-11 px-2 py-2 rounded-lg active:bg-accent disabled:opacity-60';

function QuestionBody(props: { request: () => QuestionRequest; scope: QuestionScope }) {
  const request = props.request;
  const scope = () => questionScope(request());
  const draft = () => draftOf(scope());
  const questions = () => request().questions ?? [];
  const summary = () => draft().activeTab === SUMMARY_TAB;
  const index = () => activeQuestionIndex(draft(), questions().length);
  const active = () => summary() ? null : questions()[index()];
  const header = () => active()?.header?.trim() || '';
  const unanswered = () => unansweredIndexes(questions(), draft());
  const satisfied = () => questions().length > 0 && unanswered().length === 0;
  const multiple = () => !!active()?.multiple;
  const custom = () => !!draft().customMode[index()];
  const tabs = () => questionTabs(questions(), t('chat.questionCard.summaryTab'));
  const options = () => (active()?.options ?? []).map((option, position) => ({ ...option, id: `${position}:${option.label}` }));
  const summaryRows = () => questions().map((question, position) => ({ position, title: question.header || t('chat.questionCard.questionFallback', { index: position + 1 }), answer: answerDisplay(draft(), position) }));
  const failure = signal(''), notice = signal('');
  let alive = true, noticeTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => { alive = false; if (noticeTimer) clearTimeout(noticeTimer); });
  const disabled = () => props.scope.disabled();
  const setTab = (tab: string) => patchDraft(scope(), current => ({ ...current, activeTab: tab }));

  function next() {
    const target = nextUnansweredIndex(questions().length, unanswered(), draft());
    if (target !== null) setTab(String(target));
  }
  async function copy(serialize: typeof serializeQuestionAsMarkdown, done: 'copiedMarkdown' | 'copiedJson') {
    failure.set('');
    try {
      await Clipboard.writeText(serialize(request()));
      if (!alive) return;
      notice.set(t(`chat.questionCard.${done}`));
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { if (alive) notice.set(''); }, 2000);
    } catch {
      if (alive) { notice.set(''); failure.set(t('chat.questionCard.copyFailed')); }
    }
  }
  async function submit() {
    if (!satisfied() || disabled()) return;
    const submitted = scope(), id = request().id, answers = buildAnswers(questions(), draft());
    failure.set(''); notice.set('');
    await props.scope.perform(async () => {
      try {
        await props.scope.chat.replyQuestion(id, answers);
        discardDraft(submitted);
      } catch (error) {
        // The request is already gone (answered elsewhere or cancelled): state dropped it, so just release the draft.
        if (isQuestionRequestNotFound(error)) { discardDraft(submitted); return; }
        throw new Error(t('chat.questionCard.submitFailed'));
      }
    }, message => failure.set(message));
  }
  async function dismiss() {
    if (disabled()) return;
    const submitted = scope(), id = request().id;
    failure.set(''); notice.set('');
    await props.scope.perform(async () => {
      try {
        await props.scope.chat.dismissQuestion(id);
        discardDraft(submitted);
      } catch (error) {
        if (isQuestionRequestNotFound(error)) { discardDraft(submitted); return; }
        throw new Error(t('chat.questionCard.dismissFailed'));
      }
    }, message => failure.set(message));
  }

  return (
    <View testID={`question-card-${request().id}`} class="w-full pb-2">
      <View class={frame}>
        <View class="px-3 py-2 gap-1 border-b border-border/20">
          <View class="flex-row items-center gap-2">
            <Icon name="question" size={14} color={String(token('primary'))} />
            <Text class="text-sm font-medium text-muted-foreground" style={{ numberOfLines: 1, flexShrink: 1 }}>{t('chat.questionCard.inputNeeded')}</Text>
            <View class="flex-1 items-end min-w-0">
              <If when={!!header()}><View class="max-w-full px-1.5 py-0.5 rounded bg-muted/30"><Text class="text-xs font-medium text-foreground/70" style={{ numberOfLines: 1 }}>{header()}</Text></View></If>
            </View>
            <Button testID="question-copy-markdown" class="size-8 items-center justify-center rounded-lg active:bg-accent" hitSlop={6} accessibilityLabel={t('chat.questionCard.copyMarkdown')} onPress={() => { void copy(serializeQuestionAsMarkdown, 'copiedMarkdown'); }}><Icon name="file-text" size={14} /></Button>
            <Button testID="question-copy-json" class="size-8 items-center justify-center rounded-lg active:bg-accent" hitSlop={6} accessibilityLabel={t('chat.questionCard.copyJson')} onPress={() => { void copy(serializeQuestionAsJson, 'copiedJson'); }}><Icon name="code-box" size={14} /></Button>
          </View>
          <If when={!!notice()}><Text testID="question-notice" class="text-xs text-muted-foreground">{notice()}</Text></If>
        </View>
        <View class="px-3 py-3 gap-2">
          <If when={tabs().length > 1}>
            <View class="flex-row flex-wrap gap-1">
              <Each of={tabs()} key={tab => tab.value}>
                {tab => {
                  const isSummary = () => tab().value === SUMMARY_TAB;
                  const answered = () => !isSummary() && !unanswered().includes(Number(tab().value));
                  const selected = () => draft().activeTab === tab().value;
                  return (
                    <Button testID={`question-tab-${tab().value}`} class={selected() ? `${tabBase} bg-accent` : tabBase} selected={selected()} onPress={() => setTab(tab().value)}>
                      <If when={isSummary()}><Icon name="list-check-3" size={12} /></If>
                      <Text class={selected() ? 'text-sm font-medium text-foreground' : answered() || isSummary() ? 'text-sm font-medium text-muted-foreground' : 'text-sm font-medium text-foreground/85'} style={{ numberOfLines: 1 }}>{tab().label}</Text>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </If>
          <If when={summary()}>
            <View class="gap-1">
              <Each of={summaryRows()} key={entry => String(entry.position)}>
                {entry => (
                  <Button testID={`question-summary-${entry().position}`} class="w-full min-h-11 px-2 py-1.5 rounded-lg items-start active:bg-accent" onPress={() => setTab(String(entry().position))}>
                    <Text class="text-xs text-muted-foreground">{entry().title}</Text>
                    <Text class={entry().answer ? 'text-sm text-foreground' : 'text-sm italic text-muted-foreground/50'}>{entry().answer || t('chat.questionCard.noAnswer')}</Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
          <If when={!!active()}>
            <Text class="text-sm font-medium text-foreground">{active()!.question}</Text>
            <If when={multiple()}><Text class="text-xs text-muted-foreground">{t('chat.questionCard.selectMultiple')}</Text></If>
            <View class="gap-1">
              <Each of={options()} key={option => option.id}>
                {option => {
                  const selected = () => (draft().selectedOptions[index()] ?? []).includes(option().label);
                  return (
                    <Button testID={`question-option-${option().id}`} class={selected() ? `${row} bg-accent/60` : row} selected={selected()} disabled={disabled()} onPress={() => patchDraft(scope(), current => toggleOption(current, index(), option().label, multiple()))}>
                      <View class="flex-row items-start gap-2">
                        <View class="mt-0.5 items-center justify-center border border-border" style={{ width: 16, height: 16, borderRadius: multiple() ? 4 : 8, backgroundColor: selected() && multiple() ? token('primary') : undefined }}>
                          <If when={selected()} else={null}>
                            <If when={multiple()} else={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: token('primary') }} />}><Icon name="check" size={12} tone="background" /></If>
                          </If>
                        </View>
                        <View class="flex-1 min-w-0 gap-0.5">
                          <View class="flex-row items-center gap-1.5">
                            <Text class={selected() ? 'text-sm font-medium text-foreground' : 'text-sm text-foreground/80'} style={{ flexShrink: 1 }}>{option().label}</Text>
                            <If when={isRecommended(option().label)}><Text class="text-xs text-primary/80">{t('chat.questionCard.recommended')}</Text></If>
                          </View>
                          <If when={!!option().description}><Text class="text-xs text-muted-foreground">{option().description}</Text></If>
                        </View>
                      </View>
                    </Button>
                  );
                }}
              </Each>
              <Button testID="question-option-other" class={custom() ? `${row} bg-accent/60` : row} selected={custom()} disabled={disabled()} onPress={() => patchDraft(scope(), current => selectCustom(current, index()))}>
                <View class="flex-row items-center gap-2">
                  <Icon name="edit" size={14} color={custom() ? String(token('primary')) : String(token('muted-foreground'))} />
                  <Text class={custom() ? 'text-sm font-medium text-foreground' : 'text-sm text-muted-foreground'}>{t('chat.questionCard.other')}</Text>
                </View>
              </Button>
              <If when={custom()}>
                <View class="pl-6 pr-1 pt-0.5">
                  <Input
                    testID="question-custom-input"
                    class="min-h-16 px-2 py-1.5 rounded-lg border border-border/30 text-sm text-foreground"
                    multiline
                    autoFocus
                    value={draft().customText[index()] ?? ''}
                    disabled={disabled()}
                    onChange={event => patchDraft(scope(), current => setCustomText(current, index(), event.value))}
                    placeholder={t('chat.questionCard.yourAnswer')}
                    accessibilityLabel={t('chat.questionCard.yourAnswer')}
                  />
                </View>
              </If>
            </View>
          </If>
        </View>
        <If when={!!failure()}>
          <View class="px-3 pb-2 gap-0.5">
            <Text testID="question-failure" class="text-sm text-destructive">{failure()}</Text>
            <Text class="text-xs text-muted-foreground">{t('chat.questionCard.tryAgain')}</Text>
          </View>
        </If>
        <View class="flex-row flex-wrap items-center gap-1.5 px-3 py-2 border-t border-border/20">
          <Button testID="question-submit" class="min-h-11 px-3 rounded-lg flex-row items-center gap-1 bg-success/10 active:bg-success/20 disabled:opacity-50" disabled={disabled()} onPress={() => { if (satisfied()) void submit(); else next(); }}>
            <Icon name={satisfied() ? 'check' : 'arrow-right-s'} size={14} color={String(token('success'))} />
            <Text class="text-sm font-medium text-success">{t(satisfied() ? 'chat.questionCard.submit' : 'chat.questionCard.next')}</Text>
          </Button>
          <Button testID="question-dismiss" class="min-h-11 px-3 rounded-lg flex-row items-center gap-1 bg-destructive/10 active:bg-destructive/20 disabled:opacity-50" disabled={disabled()} onPress={() => { void dismiss(); }}>
            <Icon name="close" size={14} color={String(token('destructive'))} />
            <Text class="text-sm font-medium text-destructive">{t('chat.questionCard.dismiss')}</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

export function QuestionCard(props: { item: () => Row; scope: QuestionScope }) {
  const request = computed(() => questionFromForm(props.item()));
  let last: QuestionRequest | null = null;
  return <If when={!!request()}><QuestionBody request={() => { last = request() ?? last; return last!; }} scope={props.scope} /></If>;
}

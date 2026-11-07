import { cleanup, computed, effect, keymap, lifecycle, List, signal, Text, untracked, View, windowSize, type InputRef, type ListRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { language, t } from './i18n';
import { Icon } from './Icon';
import { captureHostRequest } from './state';
import type { ReferenceScope } from './composer-references';
import { referencePanelMetrics, referenceRowDensity, referenceTitleStyle, referenceDescriptionStyle } from './composer-references-presentation';
import type { TaskCommandContext } from './task-editor-defaults';
import { createTaskPromptSearch, insertTaskPromptChoice, taskPromptTrigger, type TaskPromptSnapshot, type TaskPromptState } from './task-editor-prompt-core';

/** Plain scheduled prompt text, not a Chat reference document or submission compiler. */
export function TaskEditorPrompt(props: {
  value: string; onChange: (value: string) => void; fieldClass: string; disabled: boolean;
  scope: ReferenceScope; active?: boolean; current: () => boolean; commandContext?: TaskCommandContext;
}) {
  const request = captureHostRequest();
  let input: InputRef | undefined, list: ListRef | undefined;
  const caret = signal<{ start: number; end: number } | null>(null), selection = signal<{ start: number } | undefined>(undefined);
  const focused = signal(false), composing = signal(false), dismissed = signal(''), retry = signal(0), activeID = signal('');
  const state = signal<TaskPromptState>({ rows: [], busy: false, failed: false });
  const owner = signal<TaskPromptSnapshot | null>(null);
  const enabled = () => (props.active ?? true) && lifecycle() === 'active' && props.current() && !props.disabled;
  const snapshot = computed((): TaskPromptSnapshot | null => {
    const range = caret(), value = props.value;
    if (!enabled() || !focused() || composing() || dismissed() === value || !props.scope.host || !props.scope.directory ||
      range && (range.start !== range.end || range.start < 0 || range.start > value.length)) return null;
    const cursor = range?.start ?? value.length, trigger = taskPromptTrigger(value, cursor);
    return trigger ? { scope: { ...props.scope }, text: value, cursor, trigger } : null;
  });
  const search = createTaskPromptSearch({ send: request, current: () => enabled(), t, publish: (next, captured) => {
    state.set(next); owner.set(captured);
    if (!next.rows.some(row => row.presentation.id === activeID())) activeID.set(next.rows[0]?.presentation.id ?? '');
  } });
  function dismiss() { dismissed.set(props.value); search.close(); state.set({ rows: [], busy: false, failed: false }); owner.set(null); }
  function choose(id: string) {
    const captured = owner(), current = snapshot(), row = state().rows.find(row => row.presentation.id === id);
    if (!captured || !current || !row) return;
    const inserted = insertTaskPromptChoice(captured, current, row);
    if (!inserted) return;
    props.onChange(inserted.text); selection.set({ start: inserted.caret }); caret.set({ start: inserted.caret, end: inserted.caret });
    dismiss(); input?.focus(); input?.setSelection(inserted.caret); focused.set(true);
  }
  function key(value: string) {
    if (!snapshot()) return;
    if (value === 'escape') { dismiss(); return; }
    if (value === 'enter' || value === 'tab') { if (activeID()) choose(activeID()); return; }
    const rows = state().rows;
    if (!rows.length) return;
    const current = Math.max(0, rows.findIndex(row => row.presentation.id === activeID()));
    const index = (current + (value === 'down' ? 1 : -1) + rows.length) % rows.length;
    activeID.set(rows[index].presentation.id); list?.scrollToIndex({ index, animated: false, viewPosition: .5 });
  }
  effect(() => {
    const current = snapshot(); retry(); language();
    const context = props.commandContext;
    untracked(() => {
      if (current) search.update(current, context);
      else { search.close(); state.set({ rows: [], busy: false, failed: false }); owner.set(null); activeID.set(''); }
    });
  });
  effect(() => {
    if (!snapshot()) return;
    return keymap.bind({ up: () => key('up'), down: () => key('down'), enter: () => key('enter'), tab: () => key('tab'), escape: () => key('escape') }, { when: 'always', repeat: true });
  });
  cleanup(search.dispose);
  return <View class="gap-2">
    <Input testID="features-task-prompt" ref={node => { input = node; }} class={props.fieldClass + ' min-h-36'} multiline value={props.value} disabled={props.disabled} selectedRange={selection()} onSelectionChange={range => { selection.set(undefined); caret.set(range); }} onCompositionChange={event => composing.set(event.composing)} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} submitBehavior={snapshot() ? 'submit' : 'newline'} onSubmit={() => key('enter')} onChange={event => { selection.set(undefined); caret.set(null); dismissed.set(''); props.onChange(event.value); }} placeholder={t('sessions.scheduledTasks.editor.prompt.placeholder')} accessibilityLabel={t('sessions.scheduledTasks.editor.prompt.label')} />
    <If when={!!snapshot()}><View testID="task-editor-autocomplete" class="bg-card rounded-2xl border border-border/30 gap-1 py-2">
      <View class="flex-row items-center justify-between px-3"><Text class="text-xs text-muted-foreground">{t(snapshot()?.trigger.kind === 'slash-command' ? 'chat.autocomplete.tabs.commands' : 'chat.autocomplete.tabs.files')}</Text><Button testID="task-editor-autocomplete-close" class="min-h-8 min-w-8 items-center justify-center" accessibilityLabel={t('gitView.common.close')} onPress={dismiss}><Text class="text-foreground">×</Text></Button></View>
      <If when={state().busy && !state().rows.length}><Text class="px-3 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={state().failed}><Button testID="task-editor-autocomplete-retry" class="min-h-11 px-3" onPress={() => retry.set(retry() + 1)}><Text class="text-xs text-destructive">{t('common.unavailable')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
      <If when={!!state().rows.length}><List testID="task-editor-autocomplete-list" ref={node => { list = node; }} keyboardDismissMode="none" each={state().rows} keyExtractor={row => row.presentation.id} style={{ height: referencePanelMetrics(state().rows, windowSize().height).listHeight }}>{row => <View testID={`task-editor-choice-${row().candidate?.kind ?? 'command'}-${row().candidate?.value ?? row().command}`} role="button" accessible focusable={false} accessibilityState={{ selected: activeID() === row().presentation.id }} class="active:bg-accent rounded-lg px-3 py-2 flex-row items-center gap-2" style={{ minHeight: referenceRowDensity.minHeight }} onPress={() => choose(row().presentation.id)}><Icon name={row().presentation.iconName} size={16} /><View class="flex-1"><Text class="text-foreground" style={referenceTitleStyle}>{row().presentation.title}</Text><If when={!!row().presentation.subtitle}><Text class="text-muted-foreground" style={{ ...referenceDescriptionStyle, numberOfLines: 1 }}>{row().presentation.subtitle}</Text></If></View><If when={!!row().presentation.badge}><Text class="text-xs text-muted-foreground">{row().presentation.badge}</Text></If></View>}</List></If>
      <If when={!state().busy && !state().rows.length && !state().failed}><Text class="px-3 text-xs text-muted-foreground">{t(snapshot()?.trigger.kind === 'slash-command' ? 'chat.commandAutocomplete.empty' : 'chat.fileMentionAutocomplete.empty')}</Text></If>
    </View></If>
  </View>;
}

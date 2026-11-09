import { cleanup, computed, effect, keymap, signal, untracked, type InputRef } from 'nsh';
import { sameReferenceScope, type ReferenceCandidate, type ReferenceScope } from './composer-references';
import { createAutocompleteKeyboard, createReferenceKeyboard, type ReferenceKeyboardContext, type ReferenceKeyboardState } from './composer-reference-keyboard';
import { resolveComposerAutocompleteTrigger } from '../ui/src/lib/composer-autocomplete/trigger';
import { shouldSubmitCommandOnSelection, type NativeCommandRow, type NativeSlashCommand, type NativeComposerAction } from './composer-commands-model';

/** Native Input + keymap adapter shared by production Chat and the isolated headless fixture. */
export function createNativeReferenceKeyboard(options: {
  active: () => boolean;
  scope: () => ReferenceScope;
  text: () => string;
  insert: (candidate: ReferenceCandidate, start: number, end: number) => boolean;
  chooseCommand?: (command: NativeSlashCommand, submit: boolean, context: ReferenceKeyboardContext) => boolean | void;
  commandActions?: () => readonly NativeComposerAction[];
  commandOwner?: () => object | null;
}) {
  const caret = signal<{ start: number; end: number } | null>(null), composing = signal(false), focused = signal(false);
  const dismissed = signal<string | null>(null), selectedRange = signal<{ start: number } | undefined>(undefined);
  const state = signal<ReferenceKeyboardState>({ rows: [], index: 0 });
  const commandState = signal<{ rows: readonly NativeCommandRow[]; index: number; id?: string }>({ rows: [], index: 0 });
  let input: InputRef | undefined, unbind: (() => void) | undefined;
  let previousScope: ReferenceScope | undefined;
  let previousCommandOwner: object | null | undefined;
  effect(() => {
    const active = options.active(), scope = options.scope(), owner = options.commandOwner?.();
    if (!active || owner !== previousCommandOwner || (previousScope && !sameReferenceScope(previousScope, scope))) untracked(() => {
      caret.set(null); selectedRange.set(undefined); composing.set(false); focused.set(false); dismissed.set(null);
      unbind?.(); unbind = undefined;
    });
    previousScope = { ...scope };
    previousCommandOwner = owner;
  });
  const autocomplete = computed(() => {
    const scope = options.scope();
    if (!options.active() || !focused() || !scope.host || !scope.draft || !scope.directory || composing() || dismissed() === options.text()) return null;
    const range = caret();
    if (range && (range.start !== range.end || range.start < 0 || range.start > options.text().length)) return null;
    return resolveComposerAutocompleteTrigger({ text: options.text(), cursor: range?.start ?? options.text().length });
  });
  const trigger = computed(() => { const value = autocomplete(); return value?.kind === 'mention' ? { start: value.tokenStart, end: value.tokenEnd, query: value.query } : null; });
  const commandTrigger = computed(() => { const value = autocomplete(); return options.chooseCommand && value?.kind === 'slash-command' ? { start: value.tokenStart, end: value.tokenEnd, query: value.query } : null; });
  const editing = computed(() => {
    const scope = options.scope();
    return (!!trigger() || !!commandTrigger()) && focused() && !!scope.host && !!scope.draft && !!scope.directory;
  });
  const dismiss = () => { dismissed.set(options.text()); refresh(); };
  const core = createReferenceKeyboard({
    read: () => { const value = trigger(); return value ? { ...value, scope: options.scope(), text: options.text(), editing: focused() } : null; },
    publish: value => state.set(value), dismiss,
    choose: (candidate, context) => {
      if (!options.insert(candidate, context.start, context.end)) return false;
      const next = context.end + options.text().length - context.text.length;
      dismissed.set(options.text());
      caret.set({ start: next, end: next }); selectedRange.set({ start: next });
      // Native ref commands are ordered with the controlled value; no unfenced delayed focus timer.
      input?.focus(); input?.setSelection(next); focused.set(true);
    },
  });
  const commandCore = createAutocompleteKeyboard<NativeCommandRow>({
    read: () => { const value = commandTrigger(); return value ? { ...value, scope: options.scope(), text: options.text(), editing: focused(), owner: options.commandOwner?.() ?? undefined } : null; },
    publish: value => commandState.set(value), dismiss,
    id: row => row.presentation.id, scope: row => row.scope,
    validate: context => { const value = resolveComposerAutocompleteTrigger({ text: context.text, cursor: context.end }); return value?.kind === 'slash-command' && value.tokenStart === context.start && value.query === context.query; },
    choose: (row, context, submit) => {
      if (options.chooseCommand?.(row.command, submit, context) === false) return false;
      dismissed.set(options.text());
      if (!shouldSubmitCommandOnSelection(row.command, submit, options.commandActions?.())) {
        const next = context.end + options.text().length - context.text.length;
        caret.set({ start: next, end: next }); selectedRange.set({ start: next });
        input?.focus(); input?.setSelection(next); focused.set(true);
      }
    },
  });
  const currentCore = () => commandTrigger() ? commandCore : core;
  function refresh() {
    core.sync(); commandCore.sync();
    const current = currentCore().sync(), enabled = !!current?.editing;
    if (enabled && !unbind) unbind = keymap.bind({
      up: () => { currentCore().key('up'); refresh(); }, down: () => { currentCore().key('down'); refresh(); },
      enter: () => { currentCore().key('enter'); refresh(); }, tab: () => { currentCore().key('tab'); refresh(); },
      escape: () => { currentCore().key('escape'); refresh(); },
    }, { when: 'always', repeat: true });
    if (!enabled && unbind) { unbind(); unbind = undefined; }
  }
  effect(() => { trigger(); commandTrigger(); options.scope(); untracked(() => { core.sync(); commandCore.sync(); }); });
  effect(() => {
    editing(); untracked(refresh);
    // keymap bindings created under an effect are also owned by that effect's lifetime.
    cleanup(() => { unbind?.(); unbind = undefined; });
  });
  cleanup(() => { unbind?.(); unbind = undefined; core.clear(); commandCore.clear(); });
  return {
    trigger, state, commandTrigger, commandState, commandCore, selectedRange, core, refresh, dismiss,
    ref: (node: InputRef) => { input = node; },
    onFocus: () => { focused.set(true); refresh(); },
    onBlur: () => { focused.set(false); refresh(); },
    onCompositionChange: (event: { composing: boolean }) => { composing.set(event.composing); refresh(); },
    onSelectionChange: (range: { start: number; end: number }) => { selectedRange.set(undefined); caret.set(range); refresh(); },
    beforeChange: () => { selectedRange.set(undefined); caret.set(null); dismissed.set(null); },
    onSubmit: () => { currentCore().key('enter'); refresh(); },
    submitBehavior: () => editing() ? 'submit' as const : 'newline' as const,
    choose: (id: string) => { const accepted = core.choose(id); refresh(); return accepted; },
    chooseCommand: (id: string, submit = true) => { const accepted = commandCore.choose(id, submit); refresh(); return accepted; },
  };
}
export type NativeReferenceKeyboard = ReturnType<typeof createNativeReferenceKeyboard>;

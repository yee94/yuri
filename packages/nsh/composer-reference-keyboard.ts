import { sameReferenceScope, type MixedReferenceRow, type ReferenceCandidate, type ReferenceScope } from './composer-references';
import { resolveComposerAutocompleteTrigger } from '../ui/src/lib/composer-autocomplete/trigger';

export type ReferenceKeyboardOwner = { scope: ReferenceScope; query: string };
export type ReferenceKeyboardContext = ReferenceKeyboardOwner & { text: string; start: number; end: number; editing: boolean; owner?: object };
export type ReferenceKeyboardState = { rows: readonly MixedReferenceRow[]; index: number; id?: string };
const sameOwner = (a: ReferenceKeyboardOwner, b: ReferenceKeyboardOwner) => sameReferenceScope(a.scope, b.scope) && a.query === b.query;

/** One mounted composer. No timers, catalog enumeration, subscriptions or native focus ownership. */
export function createReferenceKeyboard(options: {
  read: () => ReferenceKeyboardContext | null;
  publish: (state: ReferenceKeyboardState) => void;
  choose: (candidate: ReferenceCandidate, context: ReferenceKeyboardContext) => boolean | void;
  dismiss: () => void;
}) {
  return createAutocompleteKeyboard<MixedReferenceRow>({ ...options,
    choose: (row, context) => options.choose(row.candidate, context),
    id: row => row.presentation.id, scope: row => row.candidate.scope,
    validate: next => { const token = resolveComposerAutocompleteTrigger({ text: next.text, cursor: next.end }); return token?.kind === 'mention' && token.tokenStart === next.start && token.query === next.query; },
  });
}

/** Shared range/scope admission and key navigation; each domain retains its own rows and delivery. */
export function createAutocompleteKeyboard<T>(options: {
  read: () => ReferenceKeyboardContext | null;
  publish: (state: { rows: readonly T[]; index: number; id?: string }) => void;
  choose: (row: T, context: ReferenceKeyboardContext, submit: boolean) => boolean | void;
  dismiss: () => void;
  id: (row: T) => string;
  scope: (row: T) => ReferenceScope | undefined;
  validate: (context: ReferenceKeyboardContext) => boolean;
}) {
  const empty = () => ({ rows: [] as readonly T[], index: 0, id: undefined as string | undefined });
  let context: ReferenceKeyboardContext | null = null, state = empty(), preferredID: string | undefined;
  const emit = (next: typeof state) => { state = next; options.publish(state); };
  function sync() {
    const next = options.read();
    const valid = next && next.scope.host && next.scope.draft && next.scope.directory
      && Number.isInteger(next.start) && Number.isInteger(next.end) && next.start >= 0 && next.end >= next.start && next.end <= next.text.length
      && options.validate(next);
    if (!valid || !context || !sameOwner(context, next) || context.owner !== next.owner) {
      preferredID = undefined;
      if (state.rows.length || state.id) emit(empty());
    }
    context = valid ? { ...next, scope: { ...next.scope } } : null;
    return context;
  }
  function rows(owner: ReferenceKeyboardOwner, values: readonly T[], pending = false) {
    const current = sync();
    if (!current || !sameOwner(current, owner)) return;
    const safe = values.filter(row => { const scope = options.scope(row); return !!scope && sameReferenceScope(scope, current.scope); });
    if (!safe.length && pending) { emit(empty()); return; }
    const found = safe.findIndex(row => options.id(row) === preferredID), index = Math.max(0, found);
    preferredID = safe[index] ? options.id(safe[index]) : undefined;
    emit({ rows: safe, index, id: preferredID });
  }
  function choose(id: string, submit = true) {
    // Read authoritative text/range/scope again at admission, not at pointer-down or async publish.
    const before = context, current = sync();
    if (!before || !current || !sameOwner(before, current) || before.owner !== current.owner || before.text !== current.text || before.start !== current.start || before.end !== current.end) return false;
    const row = state.rows.find(row => options.id(row) === id), scope = row && options.scope(row);
    if (!row || !scope || !sameReferenceScope(scope, current.scope)) return false;
    if (options.choose(row, current, submit) === false) return false;
    sync();
    return true;
  }
  function key(key: string) {
    const current = sync();
    if (!current?.editing || !['up', 'down', 'enter', 'tab', 'escape'].includes(key)) return false;
    if (key === 'escape') { options.dismiss(); sync(); return true; }
    if (key === 'enter' || key === 'tab') { if (state.id) choose(state.id, key === 'enter'); return true; }
    if (state.rows.length) {
      const index = (state.index + (key === 'down' ? 1 : -1) + state.rows.length) % state.rows.length;
      preferredID = options.id(state.rows[index]);
      emit({ ...state, index, id: preferredID });
    }
    return true;
  }
  return { sync, rows, choose, key, state: () => state, clear() { context = null; preferredID = undefined; emit(empty()); } };
}

import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';

export type NativeBtwScope = { sessionId: string; directory?: string | null; runtime?: NativeBtwRuntime };
export type NativeBtwRuntime = { transport: string; generation: number };
export type NativeBtwSelection = { providerID: string; modelID: string; agent?: string; variant?: string | null };
export type NativeBtwTurn = { id: string; quotes: readonly string[]; question: string; answer: string; error: string | null; pending: boolean; completedAt?: number; durationMs?: number };
export type NativeBtwEntry = { turns: readonly NativeBtwTurn[]; quotes: readonly string[] };
export type NativeBtwRequestScope = { runtime: NativeBtwRuntime; sessionID: string; directory: string | null };
const EMPTY: NativeBtwEntry = Object.freeze({ turns: Object.freeze([]), quotes: Object.freeze([]) });
const INSTRUCTIONS = 'The user is asking a quick side question about the conversation so far. Answer directly and concisely in markdown from what you already know. Do not call any tools and do not take any actions.';
const formatTurn = (turn: Pick<NativeBtwTurn, 'question' | 'quotes'>) => turn.quotes.length
  ? ['Quoted from the conversation:', ...turn.quotes.map(quote => quote.split('\n').map(line => `> ${line}`).join('\n')), turn.question].join('\n\n') : turn.question;
function promptFor(history: readonly NativeBtwTurn[], current: Pick<NativeBtwTurn, 'question' | 'quotes'>) {
  const earlier = history.filter(turn => turn.answer).slice(-12);
  return earlier.length ? [INSTRUCTIONS, 'Earlier in this side conversation:', earlier.map(turn => `User: ${formatTurn(turn)}\n\nAssistant: ${turn.answer}`).join('\n\n'), 'Follow-up question:', formatTurn(current)].join('\n\n')
    : [INSTRUCTIONS, formatTurn(current)].join('\n\n');
}

/** Native owner of the exact Web side-turn semantics. Only injected session.generate can request an answer. */
export function createNativeBtwStore(options: {
  runtime: () => NativeBtwRuntime;
  resolveSelection: (scope: NativeBtwScope) => NativeBtwSelection | null;
  rememberSelection: (scope: NativeBtwScope, selection: NativeBtwSelection) => void;
  applySelection: (scope: NativeBtwRequestScope, selection: NativeBtwSelection, request: { signal: AbortSignal }) => Promise<void>;
  /** Official SDK input is { sessionID, prompt }; HTTP body is { prompt }. Signal is a request option. */
  generate?: (scope: NativeBtwRequestScope, body: { sessionID: string; prompt: string }, request: { signal: AbortSignal }) => Promise<{ text: string }>;
  now?: () => number;
  elapsed?: () => number;
}) {
  const entries = new Map<string, NativeBtwEntry>(), selections = new Map<string, NativeBtwSelection>();
  const controllers = new Map<string, { controller: AbortController; turnID: string; runtime: NativeBtwRuntime }>();
  const observers = new Map<string, Set<() => void>>();
  let sequence = 0, epoch = 0, alive = true;
  const key = (scope: NativeBtwScope) => `${(scope.runtime ?? options.runtime()).transport}\u0000${normalizeDirectoryKey(scope.directory)}\u0000${scope.sessionId.trim()}`;
  const current = (scope: NativeBtwScope) => !scope.runtime || scope.runtime.transport === options.runtime().transport && scope.runtime.generation === options.runtime().generation;
  const valid = (scope: NativeBtwScope) => alive && current(scope) && !!scope.sessionId.trim();
  const notify = (id: string) => {
    for (const observer of observers.get(id) ?? []) {
      try { observer(); } catch { /* A retired view cannot interrupt the side-turn owner. */ }
    }
  };
  const patch = (id: string, turnID: string, value: Partial<NativeBtwTurn>) => {
    const entry = entries.get(id); if (!entry || !entry.turns.some(turn => turn.id === turnID)) return;
    entries.delete(id);
    entries.set(id, { ...entry, turns: entry.turns.map(turn => turn.id === turnID ? { ...turn, ...value } : turn) }); notify(id);
  };
  function cancelKey(id: string) {
    const slot = controllers.get(id); if (!slot) return;
    controllers.delete(id); slot.controller.abort(); patch(id, slot.turnID, { pending: false });
  }
  function write(id: string, value: NativeBtwEntry) {
    entries.delete(id); entries.set(id, value);
    while (entries.size > 40) {
      const victim = [...entries.keys()].find(item => item !== id && !entries.get(item)!.turns.some(turn => turn.pending)) ?? [...entries.keys()].find(item => item !== id);
      if (!victim) break;
      cancelKey(victim); entries.delete(victim); notify(victim);
    }
    notify(id);
  }
  const selection = (scope: NativeBtwScope) => selections.get(key(scope)) ?? options.resolveSelection(scope);
  async function run(scope: NativeBtwScope, id: string, turn: NativeBtwTurn, history: readonly NativeBtwTurn[]) {
    const runtime = { ...(scope.runtime ?? options.runtime()) }, capturedEpoch = epoch;
    const requestScope: NativeBtwRequestScope = { runtime, sessionID: scope.sessionId.trim(), directory: scope.directory ?? null };
    const slot = { controller: new AbortController(), turnID: turn.id, runtime }; controllers.set(id, slot);
    const owned = () => alive && epoch === capturedEpoch && controllers.get(id) === slot;
    const current = () => owned() && options.runtime().transport === runtime.transport && options.runtime().generation === runtime.generation;
    const commit = (value: Partial<NativeBtwTurn>) => { if (owned()) patch(id, turn.id, current() ? value : { pending: false }); };
    const started = (options.elapsed ?? (() => performance.now()))();
    try {
      const selected = selection(scope), capturedSelection = selected ? { ...selected } : null;
      if (capturedSelection) await options.applySelection(requestScope, capturedSelection, { signal: slot.controller.signal });
      if (!current()) { commit({ pending: false }); return; }
      if (!options.generate) throw new Error('session.btw failed');
      const result = await options.generate(requestScope, { sessionID: requestScope.sessionID, prompt: promptFor(history, turn) }, { signal: slot.controller.signal });
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      commit(text ? { answer: text, error: null, pending: false, completedAt: (options.now ?? Date.now)(), durationMs: Math.max(0, (options.elapsed ?? (() => performance.now()))() - started) }
        : { answer: '', error: 'empty response', pending: false });
    } catch (failure) {
      const cancelled = slot.controller.signal.aborted || failure instanceof Error && failure.name === 'AbortError';
      const error = failure instanceof Error && failure.message.trim() ? failure.message : typeof failure === 'string' && failure.trim() ? failure : 'session.btw failed';
      commit(cancelled ? { pending: false } : { error, pending: false });
    } finally { if (controllers.get(id) === slot) controllers.delete(id); }
  }
  async function ask(scope: NativeBtwScope, raw: string) {
    const question = raw.trim(); if (!valid(scope) || !question || !options.generate) return false;
    const id = key(scope); cancelKey(id);
    const entry = entries.get(id) ?? EMPTY;
    const turn: NativeBtwTurn = { id: `btw_${++sequence}`, quotes: entry.quotes, question, answer: '', error: null, pending: true };
    write(id, { turns: [...entry.turns, turn].slice(-50), quotes: EMPTY.quotes });
    await run({ ...scope }, id, turn, entry.turns);
    return true;
  }
  function clear(scope: NativeBtwScope) {
    if (!current(scope)) return;
    const id = key(scope); cancelKey(id); entries.delete(id); selections.delete(id); notify(id);
  }
  function reset() {
    epoch++;
    for (const id of controllers.keys()) cancelKey(id);
    const keys = [...entries.keys()]; entries.clear(); selections.clear(); keys.forEach(notify);
  }
  return {
    /** Freeze the actual transport/generation so retired view cleanup cannot clear a new Host entry. */
    captureScope: (scope: NativeBtwScope): NativeBtwScope => Object.freeze({ ...scope, runtime: Object.freeze({ ...(scope.runtime ?? options.runtime()) }) }),
    current: (scope: NativeBtwScope) => valid(scope),
    available: () => alive && typeof options.generate === 'function',
    entry: (scope: NativeBtwScope): NativeBtwEntry => entries.get(key(scope)) ?? EMPTY,
    selection,
    setSelection(scope: NativeBtwScope, value: NativeBtwSelection) {
      if (!valid(scope) || !value.providerID || !value.modelID) return;
      selections.set(key(scope), { ...value }); options.rememberSelection(scope, { ...value }); notify(key(scope));
    },
    observe(scope: NativeBtwScope, observer: () => void) {
      const id = key(scope), set = observers.get(id) ?? new Set<() => void>(); set.add(observer); observers.set(id, set);
      return () => { set.delete(observer); if (!set.size) observers.delete(id); };
    },
    ask,
    async retry(scope: NativeBtwScope) {
      if (!valid(scope) || !options.generate) return false;
      const id = key(scope), turns = entries.get(id)?.turns ?? [], last = turns[turns.length - 1]; if (!last) return;
      cancelKey(id); patch(id, last.id, { answer: '', error: null, pending: true, completedAt: undefined, durationMs: undefined });
      await run({ ...scope }, id, last, turns.slice(0, -1));
      return true;
    },
    cancel: (scope: NativeBtwScope) => {
      const id = key(scope), slot = controllers.get(id);
      if (!scope.runtime || slot?.runtime.transport === scope.runtime.transport && slot.runtime.generation === scope.runtime.generation) cancelKey(id);
    }, clear, reset,
    addQuote(scope: NativeBtwScope, raw: string) {
      const quote = raw.trim(); if (!valid(scope) || !quote) return;
      const id = key(scope), entry = entries.get(id) ?? EMPTY;
      if (!entry.quotes.includes(quote)) write(id, { ...entry, quotes: [...entry.quotes, quote].slice(-10) });
    },
    removeQuote(scope: NativeBtwScope, index: number) {
      const id = key(scope), entry = entries.get(id);
      if (entry && index >= 0 && index < entry.quotes.length) write(id, { ...entry, quotes: entry.quotes.filter((_, position) => position !== index) });
    },
    dispose() { reset(); alive = false; observers.clear(); },
  };
}
export type NativeBtwStore = ReturnType<typeof createNativeBtwStore>;

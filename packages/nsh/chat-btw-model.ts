import type { RuntimeScope } from './runtime-scope';

export type BtwScope = Readonly<{ runtime: RuntimeScope; sessionID: string; directory: string }>;
export type BtwTurn = Readonly<{ id: number; question: string; answer: string; status: 'pending' | 'complete' | 'failed' | 'cancelled'; error: string | null }>;
export type BtwState = Readonly<{ open: boolean; draft: string; turns: readonly BtwTurn[]; revision: number; presentationGeneration: number }>;
export type BtwAction = Readonly<{ owner: object; revision: number }>;
export type BtwCloseTicket = Readonly<{ owner: object; generation: number }>;
export type BtwRequest = (path: string, method: string, body: unknown) => Promise<unknown>;
export type BtwGenerate = (prompt: string) => Promise<string>;
let diagnosticSequence = 0;

/** Installed @opencode/protocol session.generate: session-owned, no location query. */
export function createBtwGenerate(scope: BtwScope, request: BtwRequest): BtwGenerate {
  const sessionID = scope.sessionID.trim();
  return async prompt => {
    if (!sessionID) throw new Error('session_required');
    const response = await request(`/api/session/${encodeURIComponent(sessionID)}/generate`, 'POST', { prompt });
    if (!response || typeof response !== 'object' || !('data' in response)) throw new Error('invalid_generate_response');
    const data = response.data;
    if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') throw new Error('invalid_generate_response');
    const text = data.text.trim();
    if (!text) throw new Error('empty_generate_response');
    return text;
  };
}

const instructions = 'The user is asking a quick side question about the conversation so far. Answer directly and concisely in markdown from what you already know. Do not call any tools and do not take any actions.';
function promptFor(turns: readonly BtwTurn[], question: string) {
  const earlier = turns.filter(turn => turn.status === 'complete' && turn.answer).slice(-12);
  return earlier.length ? [instructions, 'Earlier in this side conversation:', earlier.map(turn => `User: ${turn.question}\n\nAssistant: ${turn.answer}`).join('\n\n'), 'Follow-up question:', question].join('\n\n') : [instructions, question].join('\n\n');
}

/** One captured Chat/Host lease; no main transcript, draft, history or queue access. */
export function createBtwOwner(scope: BtwScope, generate: BtwGenerate, current: () => boolean, notify: () => void = () => {}) {
  const identity = Object.freeze({ ...scope, runtime: Object.freeze({ ...scope.runtime }) });
  const owner = {};
  let state: BtwState = { open: false, draft: '', turns: [], revision: 0, presentationGeneration: 0 };
  let request: object | null = null, sequence = 0, disposed = false;
  const valid = () => !disposed && current();
  const publish = (patch: Partial<BtwState>) => { state = { ...state, ...patch, revision: state.revision + 1 }; notify(); };
  const capture = (): BtwAction => ({ owner, revision: state.revision });
  const accepts = (action?: BtwAction) => valid() && (!action || action.owner === owner && action.revision === state.revision);
  function cancel(action?: BtwAction) {
    if (action && !accepts(action)) return false;
    request = null;
    const turns = state.turns.map(turn => turn.status === 'pending' ? { ...turn, status: 'cancelled' as const } : turn);
    publish({ turns });
    return true;
  }
  function close(action?: BtwAction) {
    if (action && !accepts(action)) return false;
    request = null;
    publish({ open: false, draft: '', turns: [], presentationGeneration: state.presentationGeneration + 1 });
    return true;
  }
  async function run(turn: BtwTurn, history: readonly BtwTurn[]) {
    const ticket = {}; request = ticket;
    const owns = () => valid() && request === ticket;
    try {
      const answer = await generate(promptFor(history, turn.question));
      if (!owns()) return;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('empty_generate_response');
      publish({ turns: state.turns.map(value => value.id === turn.id ? { ...value, answer: answer.trim(), status: 'complete', error: null } : value) });
    } catch (error) {
      if (owns()) publish({ turns: state.turns.map(value => value.id === turn.id ? { ...value, status: 'failed', error: error instanceof Error ? error.message : 'generate_failed' } : value) });
    } finally { if (request === ticket) request = null; }
  }
  function ask(question: string, action?: BtwAction, newPresentation = false): boolean {
    if (!accepts(action) || request || !question.trim() || !identity.sessionID) return false;
    const history = state.turns;
    const turn: BtwTurn = { id: ++sequence, question: question.trim(), answer: '', status: 'pending', error: null };
    publish({ open: true, turns: [...history, turn].slice(-50), presentationGeneration: state.presentationGeneration + (newPresentation || !state.open ? 1 : 0) });
    void run(turn, history);
    return true;
  }
  return {
    diagnosticID: ++diagnosticSequence, isCurrent: valid,
    scope: identity, snapshot: () => state, capture,
    capturePresentation: (): BtwCloseTicket => ({ owner, generation: state.presentationGeneration }),
    closePresentation(ticket: BtwCloseTicket) {
      if (!valid() || ticket.owner !== owner || ticket.generation !== state.presentationGeneration) return false;
      return close();
    },
    open(action?: BtwAction) { if (!accepts(action) || !identity.sessionID) return false; publish({ open: true, presentationGeneration: state.presentationGeneration + 1 }); return true; },
    edit(text: string, action?: BtwAction) { if (!accepts(action)) return false; publish({ draft: text }); return true; },
    ask: (question: string, action?: BtwAction) => ask(question, action),
    acceptIntent: (question: string) => question.trim() ? ask(question, undefined, true) : false,
    submit(action?: BtwAction) { if (!ask(state.draft, action)) return false; publish({ draft: '' }); return true; },
    retry(action?: BtwAction) {
      const last = state.turns.at(-1);
      if (!accepts(action) || request || !last || last.status === 'complete') return false;
      const turn: BtwTurn = { ...last, answer: '', error: null, status: 'pending' };
      publish({ turns: [...state.turns.slice(0, -1), turn] });
      void run(turn, state.turns.slice(0, -1));
      return true;
    },
    cancel, close,
    retire() { close(); disposed = true; },
  };
}
export type BtwOwner = ReturnType<typeof createBtwOwner>;

/** Router calls before send-flight/selection/history/queue. Caller alone CAS-clears main text. */
export function acceptBtwIntent(owner: BtwOwner, intent: { question: string }, hasReferences: boolean): 'accepted' | 'plainTextRequired' | 'blocked' {
  if (hasReferences) return 'plainTextRequired';
  return (intent.question.trim() ? owner.acceptIntent(intent.question) : owner.open()) ? 'accepted' : 'blocked';
}

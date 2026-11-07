import { messageFrom, record, type Message, type Row } from './model';
import { isSlimActivityPart } from '../ui/src/lib/slimActivityPart';

export type ActivityFillStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ActivityFillOptions = { automatic?: boolean; retryErrorsOnly?: boolean };
export type ActivityMaterialization = {
  state: (ids: readonly string[]) => { loading: boolean; failed: boolean; empty: boolean };
  request: (ids: readonly string[], options?: ActivityFillOptions) => Promise<void>;
};
const slim = (part: Row) => isSlimActivityPart({ type: String(part.type || ''), slim: part.slim });
export const hasSlimActivity = (message: Message) => message.content?.some(slim) === true;
function hasActivityOutput(message: Message): boolean {
  const present = (value: unknown) => typeof value === 'string' ? value.trim().length > 0 : value != null;
  return message.content?.some(part => {
    if (part.type === 'reasoning') return present(part.text);
    if (part.type === 'file') return present(part.url || part.uri);
    if (part.type !== 'tool') return false;
    const state = record(part.state);
    return present(state.output) || present(state.error) || Array.isArray(state.content) && state.content.length > 0;
  }) === true;
}

/** Exact Host reads accept native v2 records and the legacy info/parts envelope. */
export function materializedActivityMessage(payload: unknown, expected: Message, sessionID: string): Message {
  const body = record(record(payload).data ?? payload), info = record(body.info ?? body);
  const parts = body.parts ?? body.content;
  if (info.id !== expected.id || info.sessionID && info.sessionID !== sessionID || !Array.isArray(parts)) throw new Error('Invalid exact activity message');
  if (parts.some(value => slim(record(value)))) throw new Error('Exact activity message is still slim');
  const full = messageFrom({ ...info, parts });
  if (!full) throw new Error('Invalid exact activity message');
  // Exact-fill owns bodies only. Existing ordered metadata and turn authority do not change.
  return { ...expected, text: full.text, reasoning: full.reasoning, content: full.content, tools: full.tools, files: full.files, cards: full.cards };
}

/** Session-owned two-read queue. Failed IDs survive row remounts; only explicit actions retry. */
export function createActivityMaterializer(deps: {
  current: () => boolean;
  message: (id: string) => Message | undefined;
  read: (id: string, expected: Message) => Promise<Message>;
  apply: (message: Message, expected: Message) => boolean;
  changed: () => void;
}) {
  type Job = { id: string; source: Message; epoch: number; resolve: () => void; promise: Promise<void> };
  const states = new Map<string, { status: ActivityFillStatus; empty?: boolean }>(), flights = new Map<string, Job>();
  let queue: Job[] = [], active = 0, epoch = 0;
  function publish(id: string, status: ActivityFillStatus, empty = false) { states.set(id, { status, empty }); deps.changed(); }
  function pump() {
    while (active < 2 && queue.length && deps.current()) {
      const job = queue.shift()!;
      if (job.epoch !== epoch) { job.resolve(); continue; }
      active++;
      void Promise.resolve().then(() => job.epoch === epoch && deps.current() ? deps.read(job.id, job.source) : undefined).then(full => {
        if (!full || job.epoch !== epoch || !deps.current()) return;
        if (!deps.apply(full, job.source)) {
          const current = deps.message(job.id);
          publish(job.id, current && !hasSlimActivity(current) ? 'ready' : 'error');
          return;
        }
        publish(job.id, 'ready', !hasActivityOutput(full));
      }).catch(() => { if (job.epoch === epoch && deps.current()) publish(job.id, 'error'); }).finally(() => {
        active--; if (flights.get(job.id) === job) flights.delete(job.id);
        job.resolve(); pump();
      });
    }
  }
  function request(ids: readonly string[], options: ActivityFillOptions = {}): Promise<void> {
    if (!deps.current()) return Promise.resolve();
    const waiting: Promise<void>[] = [];
    const added: Job[] = [];
    const queued = options.automatic ? undefined : new Set(queue);
    for (const id of new Set(ids)) {
      const status = states.get(id)?.status;
      const source = deps.message(id);
      if (!source) continue;
      if (!hasSlimActivity(source)) {
        if (status && (status !== 'ready' || states.get(id)?.empty !== !hasActivityOutput(source))) publish(id, 'ready', !hasActivityOutput(source));
        continue;
      }
      if (options.automatic && status === 'error' || options.retryErrorsOnly && status !== 'error') continue;
      const existing = flights.get(id);
      if (existing) {
        waiting.push(existing.promise);
        if (queued?.has(existing)) added.push(existing);
        continue;
      }
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      const job = { id, source, epoch, resolve, promise };
      flights.set(id, job); publish(id, 'loading');
      added.push(job);
      waiting.push(promise);
    }
    const promoted = new Set(added);
    queue = options.automatic ? [...queue, ...added] : [...added, ...queue.filter(job => !promoted.has(job))];
    pump(); return Promise.all(waiting).then(() => {});
  }
  function cancel(clear = false) {
    epoch++;
    for (const job of flights.values()) { if (states.get(job.id)?.status === 'loading') states.delete(job.id); job.resolve(); }
    flights.clear(); queue = [];
    if (clear) states.clear();
    deps.changed();
  }
  return { request, cancel, state(ids: readonly string[]) {
    const values = ids.map(id => states.get(id));
    return { loading: values.some(value => value?.status === 'loading'), failed: values.some(value => value?.status === 'error'), empty: values.length > 0 && values.every(value => value?.status === 'ready' && value.empty) };
  } };
}

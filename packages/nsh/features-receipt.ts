import { openDraft } from './drafts';
import { record, text, type Row } from './model';

export type FeatureOperation = {
  action: 'save' | 'delete' | 'run' | 'toggle'; path: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  resourceID: string; body?: Row; expectedRevision?: number; beforeIDs?: string[];
};
export type FeatureReceipt = { version: 1; phase: 'unknown' | 'acknowledged'; operation: FeatureOperation; draft: Row; ack?: Row };
type Durable = Pick<ReturnType<typeof openDraft>, 'ready' | 'draft' | 'flush' | 'close' | 'status' | 'retry'>;
const owners = new Map<string, symbol>();
function cloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) => {
    if (/^(authorization|password|clientToken|accessToken|apiKey|secret|bearerToken)$/i.test(key)) throw new Error('feature-receipt-credentials-forbidden');
    return entry;
  }));
}

function decode(raw: string): FeatureReceipt | null {
  if (!raw) return null;
  const row = record(JSON.parse(raw)), operation = record(row.operation);
  if (row.version !== 1 || !['unknown', 'acknowledged'].includes(text(row.phase)) || !['save', 'delete', 'run', 'toggle'].includes(text(operation.action)) ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(text(operation.method)) || !/^\/api\/(?:yuri\/assistants(?:\/[^/?#]+)?|projects\/[^/?#]+\/scheduled-tasks(?:\/[^/?#]+(?:\/run)?)?)$/.test(text(operation.path)) || typeof operation.resourceID !== 'string' ||
    !row.draft || typeof row.draft !== 'object' || Array.isArray(row.draft) || operation.beforeIDs !== undefined && (!Array.isArray(operation.beforeIDs) || operation.beforeIDs.some(value => typeof value !== 'string')) ||
    operation.expectedRevision !== undefined && !Number.isSafeInteger(operation.expectedRevision)) throw new Error('invalid-feature-receipt');
  return { version: 1, phase: row.phase as FeatureReceipt['phase'], operation: operation as FeatureOperation, draft: record(row.draft), ...(row.ack !== undefined ? { ack: record(row.ack) } : {}) };
}

/** Uses openDraft's actual per-key serialized Storage/CAS and owner transfer, not a second journal store. */
export function createFeatureReceipt(durable: Durable, current: () => boolean = () => true) {
  let value: FeatureReceipt | null = null, active = true;
  let currentWrite: Promise<void> = Promise.resolve();
  let restoration = durable.ready.then(() => { value = decode(durable.draft()); });
  const ready = restoration;
  void ready.catch(() => {});
  function write(next: FeatureReceipt | null) {
    const work = currentWrite.catch(() => {}).then(async () => {
      await restoration;
      if (!active || !current()) throw new Error('feature-receipt-retired');
      durable.draft.set(next ? JSON.stringify(cloneSafe(next)) : '');
      await durable.flush();
      if (!current()) throw new Error('feature-receipt-retired');
      if (durable.status() !== 'ready') throw new Error('feature-receipt-not-stored');
      value = next;
    });
    currentWrite = work; return work;
  }
  return { ready, value: () => value,
    prepare: (operation: FeatureOperation, draft: Row) => write({ version: 1, phase: 'unknown', operation: cloneSafe(operation), draft: cloneSafe(draft) }),
    confirm: (ack: Row = {}) => { if (!value) return Promise.reject(new Error('feature-receipt-missing')); const safe: Row = {}; for (const key of ['id', 'revision', 'task', 'schedulerSynced']) if (ack[key] !== undefined) safe[key] = ack[key]; return write({ ...value, phase: 'acknowledged', ack: cloneSafe(safe) }); },
    clear: () => write(null),
    async retry() { if (!active || !current()) throw new Error('feature-receipt-retired'); restoration = durable.retry().then(() => { value = decode(durable.draft()); }); await restoration; },
    async close() { await currentWrite.catch(() => {}); active = false; await durable.close(); },
  };
}

export function openFeatureReceipt(hostID: string, identity: string) {
  const key = JSON.stringify([hostID, identity]), owner = Symbol(); owners.set(key, owner);
  const journal = createFeatureReceipt(openDraft(hostID, { kind: 'session', id: `feature-editor:${identity}`, directory: '', title: '' }), () => owners.get(key) === owner);
  return { ...journal, async close() { try { await journal.close(); } finally { if (owners.get(key) === owner) owners.delete(key); } } };
}

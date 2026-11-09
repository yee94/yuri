import { openDraft } from './drafts';
import { record, type Row } from './model';
import { settingsPreferencePatch } from './settings-preferences-core';

export type PreferenceReceipt = { acknowledged: boolean; patch: Row; submitted: Row; edits: Record<string, number>; revision: number };
type Durable = Pick<ReturnType<typeof openDraft>, 'ready' | 'draft' | 'flush' | 'close' | 'status' | 'retry'>;
type Envelope = { version: 1; handoffs: number; receipt: PreferenceReceipt };
const owners = new Map<string, symbol>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function validated(value: unknown): PreferenceReceipt {
  const row = record(value), patch = record(row.patch), submitted = record(row.submitted), edits = record(row.edits);
  if (typeof row.acknowledged !== 'boolean' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !Object.keys(patch).length) throw new Error('invalid-preference-receipt');
  for (const [key, item] of Object.entries(patch)) {
    if (['themeId', 'lightThemeId', 'darkThemeId'].includes(key)) {
      if (typeof item !== 'string' || !item.trim()) throw new Error('invalid-preference-theme');
    } else if (key === 'themeVariant') {
      if (item !== 'light' && item !== 'dark') throw new Error('invalid-preference-theme');
    } else if (key === 'useSystemTheme') {
      if (typeof item !== 'boolean') throw new Error('invalid-preference-theme');
    } else if (settingsPreferencePatch({ [key]: item })[key] !== item) throw new Error('invalid-preference-patch');
  }
  for (const [key, item] of Object.entries(submitted)) {
    if (!(key in patch) || settingsPreferencePatch({ [key]: item })[key] !== patch[key]) throw new Error('invalid-preference-submission');
    if (!Number.isSafeInteger(edits[key]) || Number(edits[key]) < 0 || Number(edits[key]) > Number(row.revision)) throw new Error('invalid-preference-edit');
  }
  if (Object.keys(edits).some(key => !(key in submitted))) throw new Error('invalid-preference-edit');
  return clone({ acknowledged: row.acknowledged, patch, submitted, edits, revision: Number(row.revision) } as PreferenceReceipt);
}
const sameOperation = (left: PreferenceReceipt, right: PreferenceReceipt) => JSON.stringify({ ...left, acknowledged: false }) === JSON.stringify({ ...right, acknowledged: false });

/** Settings journal over the existing per-key Storage/CAS draft lane. No Host
 * sender, credentials, local cache state or ordinary user draft enters it. */
function createPreferenceReceipt(durable: Durable, current: () => boolean) {
  let value: PreferenceReceipt | null = null, handoffs = 0, active = true;
  // This capability exists only in the owner which prepared the exact input
  // object. It is deliberately absent from Storage and never restored.
  let prepared: { input: PreferenceReceipt; receipt: PreferenceReceipt; entered: boolean } | null = null;
  let cancelled: PreferenceReceipt | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const admitted = () => active && current();
  const assertOwner = () => { if (!admitted()) throw new Error('preference-receipt-retired'); };
  function restore() {
    assertOwner();
    const raw = durable.draft();
    if (!raw) { value = null; handoffs = 0; return; }
    const row = record(JSON.parse(raw));
    if (row.version !== 1 || !Number.isSafeInteger(row.handoffs) || Number(row.handoffs) < 0) throw new Error('invalid-preference-journal');
    value = validated(row.receipt); handoffs = Number(row.handoffs);
  }
  let restoration = durable.ready.then(restore);
  const ready = restoration; void ready.catch(() => {});
  function serialized<T>(work: () => Promise<T>) {
    const result = tail.catch(() => {}).then(async () => { await restoration; assertOwner(); return work(); });
    tail = result; return result;
  }
  async function persist(next: PreferenceReceipt | null, transfers = handoffs) {
    assertOwner();
    const envelope: Envelope | null = next ? { version: 1, handoffs: transfers, receipt: validated(next) } : null;
    durable.draft.set(envelope ? JSON.stringify(envelope) : '');
    await durable.flush(); assertOwner();
    if (durable.status() !== 'ready') throw new Error('preference-receipt-not-stored');
    value = envelope?.receipt ?? null; handoffs = transfers;
  }
  function check(expected: PreferenceReceipt) {
    const next = validated(expected);
    if (value && !sameOperation(value, next)) throw new Error('preference-receipt-changed');
    return next;
  }
  return {
    ready, current: admitted, value: () => value ? clone(value) : null,
    prepare: (receipt: PreferenceReceipt) => serialized(async () => {
      if (value) throw new Error('preference-receipt-pending');
      const next = validated(receipt);
      if (next.acknowledged) throw new Error('preference-receipt-missing-dispatch');
      prepared = { input: receipt, receipt: next, entered: false }; cancelled = null;
      await persist(next);
    }),
    enterPut(receipt: PreferenceReceipt) {
      assertOwner(); check(receipt);
      if (!value || prepared?.input !== receipt || prepared.entered || !sameOperation(prepared.receipt, validated(receipt))) throw new Error('preference-receipt-not-prepared');
      // Call immediately before invoking PUT, with no asynchronous gap. Once
      // entered, even a rejected/late response must retain unknown semantics.
      prepared.entered = true;
    },
    cancelUnsent: (receipt: PreferenceReceipt) => serialized(async () => {
      if (!prepared && !value && cancelled === receipt) return;
      if (prepared?.input !== receipt || prepared.entered || !sameOperation(prepared.receipt, validated(receipt))) throw new Error('preference-receipt-not-definitely-unsent');
      check(receipt);
      await persist(null);
      cancelled = receipt; prepared = null;
    }),
    confirm: (receipt: PreferenceReceipt) => serialized(async () => {
      if (!value) throw new Error('preference-receipt-missing');
      if (!value.acknowledged && (!prepared?.entered || !sameOperation(prepared.receipt, validated(receipt)))) throw new Error('preference-receipt-not-entered');
      await persist({ ...check(receipt), acknowledged: true });
    }),
    handoff: (receipt: PreferenceReceipt) => serialized(async () => {
      const next = check(receipt);
      if (prepared && !prepared.entered && sameOperation(prepared.receipt, next)) throw new Error('preference-receipt-unsent');
      // A distinct durable transfer revision makes failure observable even
      // when the original pending receipt was already stored before dispatch.
      await persist({ ...next, acknowledged: value?.acknowledged === true || next.acknowledged }, handoffs + 1);
    }),
    clear: (receipt: PreferenceReceipt) => serialized(async () => {
      check(receipt);
      if (!value?.acknowledged) throw new Error('preference-receipt-unknown');
      await persist(null);
      prepared = null;
    }),
    async retry() {
      assertOwner();
      restoration = durable.retry().then(restore); await restoration;
    },
    close() {
      active = false;
      return durable.close();
    },
  };
}

/** One settings partition per saved connection and authorization, shared by
 * appearance/chat pages and restored after process restart. The map contains
 * only live owner tokens; durable receipt data stays in the existing draft store. */
export function openPreferenceReceipt(connectionID: string, authorizationID: string) {
  if (!connectionID || !authorizationID) throw new Error('preference-receipt-authorization-required');
  const identity = JSON.stringify([connectionID, authorizationID]), owner = Symbol();
  owners.set(identity, owner);
  const journal = createPreferenceReceipt(openDraft(identity, { kind: 'session', id: 'settings-preferences-receipt:v1', directory: '', title: '' }), () => owners.get(identity) === owner);
  return { ...journal, close() {
    if (owners.get(identity) === owner) owners.delete(identity);
    return journal.close();
  } };
}

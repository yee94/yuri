import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useEvent } from '@reactuses/core';
import { useInputStore } from '@/sync/input-store';
import type { DraftKey, DraftRecord } from '@/sync/input-draft-types';

type Selection = { text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' };
type Slot = { owner: object; selection?: Selection };
type InputStore = Pick<typeof useInputStore, 'getState'>;

// Record identity is the CAS boundary. Replaced/deleted records and disposed stores
// release their selection without another catalog, persistence write or eviction scan.
const selections = new WeakMap<InputStore, WeakMap<DraftRecord, Slot>>();

/** Web textarea continuity only: never restores focus or controls a native overlay. */
export function useComposerSelection({ draftKey, text, textareaRef, enabled, store = useInputStore }: {
  draftKey: DraftKey | null;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  store?: InputStore;
}) {
  const transportIdentity = draftKey?.transportIdentity;
  const ownerKind = draftKey?.owner.kind;
  const ownerID = draftKey?.owner.ownerID;
  const key = useMemo<DraftKey | null>(() => transportIdentity && ownerKind && ownerID
    ? { transportIdentity, owner: { kind: ownerKind, ownerID } } : null, [transportIdentity, ownerKind, ownerID]);
  const lifecycle = useRef<{
    node: HTMLTextAreaElement; owner: object; record?: DraftRecord; text: string;
    pending?: { record: DraftRecord; selection: Selection };
  } | null>(null);
  const record = key ? store.getState().getDraft(key) : undefined;

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!enabled || !key || !node) {
      return;
    }
    let slots = selections.get(store);
    if (!slots) { slots = new WeakMap(); selections.set(store, slots); }
    const current = store.getState().getDraft(key);
    const saved = current ? slots.get(current)?.selection : undefined;
    const owner = {};
    const binding = { node, owner, record: current, text: node.value,
      pending: current && saved ? { record: current, selection: saved } : undefined };
    lifecycle.current = binding;
    if (current) slots.set(current, { owner });
    return () => {
      // Capture the actual departing node, before ref detachment; never publish an
      // old DOM snapshot over an external CAS or a more recently mounted owner.
      const latest = store.getState().getDraft(key);
      if (latest && latest === binding.record && slots.get(latest)?.owner === owner && node.value === binding.text) {
        slots.set(latest, { owner, selection: { text: node.value, start: node.selectionStart,
          end: node.selectionEnd, direction: node.selectionDirection } });
      }
      if (lifecycle.current === binding) lifecycle.current = null;
    };
  }, [enabled, key, store, textareaRef]);

  useLayoutEffect(() => {
    const binding = lifecycle.current;
    if (!binding) return;
    const slots = selections.get(store)!;
    if (record && record !== binding.record) slots.set(record, { owner: binding.owner });
    binding.record = record;
    binding.text = text;
    const pending = binding.pending;
    if (!pending) return;
    if (record !== pending.record) { binding.pending = undefined; return; }
    // A DraftKey switch can first render the previous controller text. Wait for
    // the owning controlled value's layout commit, not a timer or a focus retry.
    if (text !== pending.selection.text || binding.node.value !== text) return;
    binding.pending = undefined;
    binding.node.setSelectionRange(pending.selection.start, pending.selection.end, pending.selection.direction);
  }, [enabled, key, record, store, text]);

  return useEvent(() => {
    // Explicit input/focus/selection supersedes any not-yet-materialized restore.
    if (lifecycle.current) {
      lifecycle.current.pending = undefined;
    }
  });
}

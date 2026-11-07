import type { Message } from './model';
import { nativeBodyRows, type NativeBodyRow } from './transcript-body-model';

/** One bounded projection per mounted Chat. Keys survive older-run enrichment. */
export function createNativeHistoryRows() {
  let source: readonly Message[] | undefined, chronological: NativeBodyRow[] = [], displayed: NativeBodyRow[] = [];
  return (messages: readonly Message[]): NativeBodyRow[] => {
    if (source === messages) return displayed;
    const next = nativeBodyRows(messages, chronological);
    source = messages;
    if (next !== chronological) { chronological = next; displayed = next.slice().reverse(); }
    return displayed;
  };
}

/** Data-only, synchronous pre-flush contract. No view, measurement or scroll ownership. */
export type NativeHistoryPresentation = Readonly<{
  authority: 'successful-history' | 'presentation' | 'failure' | 'reset';
  scope: Readonly<{
    hostID: string; generation: number; owner: number; historyGeneration: number;
    targetKind: 'session' | 'assistant'; targetID: string; directory: string;
  }>;
  more: boolean; historyError: string; boundaryMissing: boolean; repairPending: boolean; hasGap: boolean;
  readError: string; resolved: boolean;
}>;

// Consumers may create a terminal footprint only for successful-history, never
// for a retry's error clear, a failed read, or a reset. The complete footer
// predicate is more || !!historyError || boundaryMissing || repairPending || hasGap.
// Write the UI footprint signal synchronously in the callback (no await). The
// caller's existing batch owns both that signal and the authoritative writes.
// Page/lifecycle and experimental enablement remain the mounted UI owner's gates.

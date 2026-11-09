import { resolveRevertRedoTarget, resolveRevertUndoTarget } from '../ui/src/sync/conversation-order';
import type { Message } from './model';
import type { NativeHistoryInvocation, NativeHistoryOutcome } from './transcript-actions-core';

export type NativeHistoryRead = { messages: readonly Message[]; revertMessageID?: string; complete: boolean; more: boolean; loading: boolean; error: boolean };

/** Pagination belongs to the existing Chat; never invent an exhausted tail from a partial window. */
export async function nativeHistoryStep(options: {
  redo: boolean;
  invocation: NativeHistoryInvocation;
  read: () => NativeHistoryRead;
  loadOlder?: () => Promise<void>;
  stage: (message: Message) => Promise<NativeHistoryOutcome>;
  clear: () => Promise<NativeHistoryOutcome>;
}): Promise<NativeHistoryOutcome> {
  const rejected = (reason: string): NativeHistoryOutcome => ({ status: 'rejected', reason });
  for (let page = 0; page < 1000; page++) {
    if (!options.invocation.current()) return rejected('stale');
    const before = options.read();
    if (before.error || before.loading) return rejected('history-incomplete');
    if (before.complete) {
      const marker = before.revertMessageID;
      if (marker && !before.messages.some(message => message.id === marker)) return rejected('history-incomplete');
      if (options.redo && !marker) return rejected('no-target');
      const message = options.redo && marker ? resolveRevertRedoTarget(before.messages, marker) : resolveRevertUndoTarget(before.messages, marker);
      if (message) return options.stage(message);
      return options.redo ? options.clear() : rejected('no-target');
    }
    if (!before.more || !options.loadOlder) return rejected('history-incomplete');
    try { await options.loadOlder(); } catch { return rejected('history-incomplete'); }
    if (!options.invocation.current()) return rejected('stale');
    const after = options.read();
    if (after.error || after.messages.length <= before.messages.length && !after.complete) return rejected('history-incomplete');
  }
  return rejected('history-incomplete');
}

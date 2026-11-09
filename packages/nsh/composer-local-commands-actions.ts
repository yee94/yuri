import { resolveRevertRedoTarget, resolveRevertUndoTarget } from '../ui/src/sync/conversation-order';
import { compileNativePrompt, magicCommand } from './composer';
import type { CompiledSubmission, Message } from './model';
import type { NativeLocalCommandAction, NativeLocalCommandInvocation, NativeLocalCommandOutcome } from './composer-local-commands';

/** Uses the real magic compiler, but never the resource-consuming ordinary chat.send path. */
export function createNativeLocalMagicAction(options: {
  request: (path: string) => Promise<unknown>;
  admit: (compiled: CompiledSubmission, invocation: NativeLocalCommandInvocation) => Promise<NativeLocalCommandOutcome>;
  onPreparationError: () => void;
}): NativeLocalCommandAction {
  return { async run(invocation) {
    if (!invocation.current() || invocation.snapshot.hasReferences || magicCommand(invocation.snapshot.text)?.name !== invocation.command) return { status: 'rejected' };
    let compiled: CompiledSubmission;
    try {
      compiled = await compileNativePrompt({ text: invocation.snapshot.text, files: [], scope: invocation.snapshot.scope, isCurrentScope: invocation.current }, options.request);
    } catch {
      if (invocation.current()) options.onPreparationError();
      return { status: 'rejected' };
    }
    if (!invocation.current()) return { status: 'rejected' };
    // No attachments/references are handed to prompt dispatch; original owners remain untouched.
    return options.admit(compiled, invocation);
  } };
}

/** Shared Web order semantics. The owning transcript controller still owns backup, idle checks and wire. */
export function createNativeLocalHistoryActions(options: {
  read: () => { messages: readonly Message[]; revertMessageID?: string; complete: boolean; busy: boolean };
  stage: (message: Message, invocation: NativeLocalCommandInvocation) => Promise<NativeLocalCommandOutcome>;
  clear: (invocation: NativeLocalCommandInvocation) => Promise<NativeLocalCommandOutcome>;
  onUnavailable: (reason: 'history-incomplete' | 'busy' | 'no-target') => void;
}): { undo: NativeLocalCommandAction; redo: NativeLocalCommandAction } {
  const run = async (invocation: NativeLocalCommandInvocation, redo: boolean): Promise<NativeLocalCommandOutcome> => {
    if (!invocation.current() || invocation.command !== (redo ? 'redo' : 'undo')) return { status: 'rejected' };
    const history = options.read(), marker = history.revertMessageID;
    const unavailable = (reason: 'history-incomplete' | 'busy' | 'no-target'): NativeLocalCommandOutcome => {
      options.onUnavailable(reason); return { status: 'rejected' };
    };
    if (history.busy) return unavailable('busy');
    // A missing boundary/partial page is not proof that redo has reached its last step.
    if (!history.complete || marker && !history.messages.some(message => message.id === marker)) return unavailable('history-incomplete');
    if (redo && !marker) return unavailable('no-target');
    const target = redo && marker ? resolveRevertRedoTarget(history.messages, marker) : resolveRevertUndoTarget(history.messages, marker);
    if (target) return options.stage(target, invocation);
    if (redo) return options.clear(invocation);
    return unavailable('no-target');
  };
  return { undo: { run: invocation => run(invocation, false) }, redo: { run: invocation => run(invocation, true) } };
}

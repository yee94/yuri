import { createNativeLocalCommands, type NativeLocalCommandConflict, type NativeLocalCommandSnapshot, type NativeLocalCommandOutcome } from './composer-local-commands';
import { createNativeLocalMagicAction } from './composer-local-commands-actions';
import { magicCommands } from './composer';
import { sameReferenceScope } from './composer-references';
import type { NativeSlashCommand } from './composer-commands-model';
import type { ReferenceKeyboardContext } from './composer-reference-keyboard';
import type { NativeNewSessionOwner, NativeNewSessionHandoff } from './new-session';
import type { t } from './i18n';
import { confirmNativeLocalCommandConflict } from './desktop-local-command-conflict';

const sameSelection = (a: NativeLocalCommandSnapshot['selection'], b: NativeLocalCommandSnapshot['selection']) => a === b || !!a && !!b && a.agent === b.agent && a.model?.providerID === b.model?.providerID && a.model?.modelID === b.model?.modelID && a.model?.variant === b.model?.variant;
/** One real draft page owner. Snapshot reads are bounded by its own document, never catalogs/history. */
export function createNativeNewSessionLocalCommands(options: {
  owner: NativeNewSessionOwner;
  current: () => boolean;
  editing: () => boolean;
  pending: () => boolean;
  inputMode: () => 'normal' | 'shell';
  t: typeof t;
  focus: () => void;
  onConfirming: (value: boolean) => void;
  onPending: (value: boolean) => void;
  onFailure: () => void;
  onUnknown: () => void;
  openModel: () => NativeLocalCommandOutcome;
  openNewDraft: () => Promise<NativeLocalCommandOutcome>;
  handoff: (receipt: NativeNewSessionHandoff) => NativeLocalCommandOutcome;
}) {
  const owner = options.owner;
  const operations = new WeakMap<NonNullable<ReturnType<typeof owner.operation>>, number>();
  let nextOperation = 0, alive = true, confirming = false;
  const read = (): NativeLocalCommandSnapshot => {
    const operation = owner.operation();
    if (operation && !operations.has(operation)) operations.set(operation, ++nextOperation);
    const selection = owner.selection(), model = selection.model;
    return { scope: owner.durable.scope, authority: JSON.stringify([owner.hostID, owner.generation, operation ? operations.get(operation) : null]),
      target: { kind: 'draft', id: owner.durable.key, directory: owner.directory }, revision: owner.composerRevision(), text: owner.durable.draft(),
      inputMode: options.inputMode(), active: alive && options.current() && options.editing(),
      ready: !!operation?.current() && owner.phase() === 'draft' && owner.status() === 'ready' && owner.durable.status() === 'ready',
      pending: options.pending() || confirming || !!owner.durable.pendingSend(), unknown: owner.creationUnknown() || owner.admission() === 'unknown' || owner.durable.pendingSend()?.uncertain === true,
      sending: owner.submitting(), queueEditing: !!owner.durable.queueEdit(), hasReferences: !!owner.durable.references().length, hasMessages: false,
      selection: { ...(selection.agent ? { agent: selection.agent } : {}), ...(model ? { model: { providerID: model.providerID, modelID: model.id, ...(model.variant !== undefined ? { variant: model.variant } : {}) } } : {}) } };
  };
  const replaceText = (expected: NativeLocalCommandSnapshot, value: string) => {
    const next = read();
    return next.active && next.authority === expected.authority && next.revision === expected.revision && next.text === expected.text && sameReferenceScope(next.scope, expected.scope) && sameSelection(next.selection, expected.selection) && owner.compareAndSetDraftText(expected.revision, value);
  };
  let choosing: { command: NativeSlashCommand; submit: boolean } | undefined;
  let confirmationFlight: Promise<void> | undefined, hostSelection: { revision: number; text: string } | undefined;
  function confirm(conflict: NativeLocalCommandConflict) {
    if (confirmationFlight) return;
    const choice = choosing;
    confirming = true; options.onConfirming(true);
    const work = confirmNativeLocalCommandConflict(conflict, { current: () => {
      const next = read();
      return next.active && next.authority === conflict.snapshot.authority && sameReferenceScope(next.scope, conflict.snapshot.scope) && sameSelection(next.selection, conflict.snapshot.selection);
    }, replace: replaceText, submit: () => { confirming = false; local.submit(); }, focus: options.focus }).then(result => {
      if (result.status === 'applied' && choice?.command.source === 'opencode') { const next = read(); hostSelection = { revision: next.revision, text: next.text }; }
      if (result.status === 'rejected' && read().active) options.onFailure();
    }).finally(() => { confirming = false; options.onConfirming(false); if (confirmationFlight === work) confirmationFlight = undefined; });
    confirmationFlight = work;
  }
  const magic = { async run(invocation: Parameters<ReturnType<typeof createNativeLocalMagicAction>['run']>[0]) {
    if (!invocation.current()) return { status: 'rejected' as const };
    options.onPending(true);
    let staged = false;
    try {
      const captured = owner.captureOperation();
      return await createNativeLocalMagicAction({ request: path => captured.request(path), onPreparationError: options.onFailure,
        admit: async (compiled, invocation) => {
          if (!captured.current() || !invocation.current()) return { status: 'rejected' };
          const result = await owner.admitLocalMagic(compiled, invocation);
          if (result.status !== 'accepted') return result;
          staged = true;
          if (!result.handoff || !captured.current() || !invocation.current()) return { status: 'unknown' };
          return options.handoff(result.handoff);
        } }).run(invocation);
    } catch { return { status: staged ? 'unknown' as const : 'rejected' as const }; }
    finally { options.onPending(false); }
  } };
  const actions = { new: { run: options.openNewDraft }, model: { run: () => options.openModel() }, ...Object.fromEntries(magicCommands.filter(command => command.name !== 'summary').map(command => [command.name, magic])) };
  const local = createNativeLocalCommands({ t: options.t, read, replaceText, actions,
    onConflict: confirm, onBlocked: (_command, reason) => { if (reason === 'unknown') options.onUnknown(); else options.onFailure(); },
    onOutcome: (_invocation, outcome) => { if (outcome.status === 'unknown') options.onUnknown(); else if (outcome.status === 'rejected') options.onFailure(); } });
  return { readSnapshot: read, catalog: local.catalog,
    choose: (command: NativeSlashCommand, submit: boolean, context: ReferenceKeyboardContext) => {
      choosing = { command, submit };
      try { return local.choose(command, submit, context); } finally { choosing = undefined; }
    },
    trySubmit: () => { const next = read(); if (hostSelection && hostSelection.revision === next.revision && hostSelection.text === next.text) { options.onFailure(); return true; } return local.submit().kind !== 'pass'; },
    settled: async () => { await confirmationFlight; await local.settled(); },
    dispose: () => { alive = false; local.dispose(); } };
}

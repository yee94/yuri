import { shouldSubmitCommandOnSelection, nativeCommandAvailable, nativeLocalAction, nativeComposerActions, type NativeCommandContext, type NativeComposerAction, type NativeSlashCommand } from './composer-commands-model';
import { magicCommands } from './composer';
import { editNativeReferences, sameReferenceScope, type ScopedReferenceDocument } from './composer-references';
import type { ReferenceKeyboardContext } from './composer-reference-keyboard';
import { promoteTypedSlashChipSlots } from '../ui/src/components/chat/typedSlashChipPromotion';

export type NativeCommandSnapshot = {
  /** Exact page-operation identity; equal Host/directory strings do not authorize an ABA owner. */
  owner: object;
  revision: number;
  document: ScopedReferenceDocument;
  context: NativeCommandContext;
  inputMode: 'normal' | 'shell';
};
export type NativeCommandNotice = 'unavailable' | 'session-required' | 'plain-text-required';
export type NativeCommandIntent = {
  action: NativeComposerAction;
  argument: string;
  source: 'submit' | 'selection';
  snapshot: NativeCommandSnapshot;
  /** Authority only; owners that later edit a draft must also use their own revision CAS. */
  current: () => boolean;
};
export type NativeCommandActions = Partial<Record<NativeComposerAction, (intent: NativeCommandIntent) => boolean | void>>;
type Plan =
  | { kind: 'pass' }
  | { kind: 'blocked'; notice: NativeCommandNotice }
  | { kind: 'insert'; document: ScopedReferenceDocument; submit?: string }
  | { kind: 'action'; action: NativeComposerAction; argument: string; document: ScopedReferenceDocument };
type Selection = { command: NativeSlashCommand; submit: boolean; context: ReferenceKeyboardContext };

/** Literal leading token only, including Web's optional reserved icon slot. No catalog or network reads. */
function invocation(text: string) {
  const match = /^\s*\/\u2003?([^\s]+)/i.exec(text);
  return match ? { name: match[1].toLowerCase(), end: match[0].length, argument: text.slice(match[0].length).trim() } : undefined;
}
export function isNativeBtwCommand(text: string, inputMode: 'normal' | 'shell'): boolean {
  return inputMode === 'normal' && invocation(text)?.name === 'btw';
}
function replace(document: ScopedReferenceDocument, text: string): ScopedReferenceDocument | undefined {
  const next = editNativeReferences(document, text);
  return next.references.length === document.references.length ? { ...next, scope: document.scope } : undefined;
}
function actionPlan(snapshot: NativeCommandSnapshot, document: ScopedReferenceDocument, presetText?: string): Plan {
  const command = invocation(presetText ?? document.text);
  if (!command) return { kind: 'pass' };
  const action = nativeComposerActions.find(name => name === command.name);
  if (!action) {
    if ((magicCommands.some(magic => magic.name === command.name) || command.name === 'init') && !nativeCommandAvailable(command.name, snapshot.context)) return { kind: 'blocked', notice: 'unavailable' };
    return { kind: 'pass' };
  }
  if (action === 'compact' && !snapshot.context.hasSession && snapshot.context.hasNewDraft) return { kind: 'pass' };
  if (!snapshot.context.hasSession && action !== 'new' && action !== 'model') return { kind: 'blocked', notice: action === 'btw' ? 'session-required' : 'unavailable' };
  if (action === 'btw' && document.references.length) return { kind: 'blocked', notice: 'plain-text-required' };
  // Web consumeImmediateCommandText replaces the complete body, not just its
  // leading token. Root attachments and inline-comment drafts are separate owners.
  const next = action === 'model' || action === 'timeline' ? document
    : { text: '', references: [], scope: document.scope };
  return { kind: 'action', action, argument: command.argument, document: next };
}

/** Shared by pointer/Enter/Tab and Send; Web body edits stay separate from external resource owners. */
export function planNativeComposerCommand(snapshot: NativeCommandSnapshot, selection?: Selection): Plan {
  if (snapshot.inputMode !== 'normal') return { kind: 'pass' };
  if (!selection) return actionPlan(snapshot, snapshot.document);
  const { command, context } = selection, document = snapshot.document;
  if (context.owner && context.owner !== snapshot.owner || !sameReferenceScope(context.scope, document.scope) || context.text !== document.text || !Number.isInteger(context.start) || !Number.isInteger(context.end)
    || context.start !== 0 || context.end <= context.start || context.end > document.text.length || document.text[context.start] !== '/') return { kind: 'blocked', notice: 'unavailable' };
  if (!/^[^\s/]+$/.test(command.name)) return { kind: 'blocked', notice: 'unavailable' };
  const local = command.source === 'yuri' && command.id === `yuri:${command.name}`;
  if (command.source === 'yuri' && !local) return { kind: 'blocked', notice: 'unavailable' };
  if (local && !nativeCommandAvailable(command.name, snapshot.context)) return { kind: 'blocked', notice: 'unavailable' };
  if (!local) {
    const next = replace(document, `/${command.name} ${document.text.slice(context.end)}`);
    return next ? { kind: 'insert', document: next } : { kind: 'blocked', notice: 'unavailable' };
  }
  const commandText = `/${command.name}`, plain = `${commandText} `;
  const insert = promoteTypedSlashChipSlots(plain, new Set([command.name.toLowerCase()]), plain.length)?.text ?? plain;
  // ChatInput.handleCommandSelect: BTW edits only its token; every other local
  // candidate uses replacePlainDocument (whole body, empty inline references).
  const next = command.name === 'btw' ? replace(document, `${insert}${document.text.slice(context.end)}`)
    : { text: insert, references: [], scope: document.scope };
  if (!next) return { kind: 'blocked', notice: 'unavailable' };
  const submit = local && nativeLocalAction(command) && shouldSubmitCommandOnSelection(command, selection.submit, nativeComposerActions);
  return { kind: 'insert', document: next, ...(submit ? { submit: commandText } : {}) };
}

/** No transport, persistence, queue or UI ownership; callbacks belong to the captured page operation. */
export function createNativeComposerCommandRouter(options: {
  read: () => NativeCommandSnapshot | null;
  write: (next: ScopedReferenceDocument, expected: NativeCommandSnapshot) => boolean;
  actions: NativeCommandActions;
  notify: (notice: NativeCommandNotice) => void;
  /** A new-draft compact falls through Web's regular first-send materialization. */
  submitPass?: (presetText: string) => void;
}) {
  let selectedHost: { owner: object; revision: number; text: string } | undefined;
  function route(selection?: Selection, presetText?: string, origin: 'submit' | 'selection' = 'submit'): 'pass' | 'handled' | 'rejected' {
    const snapshot = options.read();
    if (!snapshot) return 'rejected';
    if (!selection && selectedHost?.owner === snapshot.owner && selectedHost.revision === snapshot.revision && selectedHost.text === snapshot.document.text) return 'pass';
    selectedHost = undefined;
    const plan = presetText === undefined ? planNativeComposerCommand(snapshot, selection) : actionPlan(snapshot, snapshot.document, presetText);
    if (plan.kind === 'pass') return 'pass';
    if (plan.kind === 'blocked') { options.notify(plan.notice); return 'rejected'; }
    const action = plan.kind === 'action' ? options.actions[plan.action] : undefined;
    if (plan.kind === 'action' && !action) { options.notify('unavailable'); return 'rejected'; }
    if (plan.kind === 'insert' && plan.submit) {
      const name = invocation(plan.submit)?.name;
      const forward = name === 'compact' && !snapshot.context.hasSession && snapshot.context.hasNewDraft;
      if (forward ? !options.submitPass : !nativeComposerActions.some(action => action === name && options.actions[action])) { options.notify('unavailable'); return 'rejected'; }
    }
    const current = () => {
      const latest = options.read();
      return !!latest && latest.owner === snapshot.owner && sameReferenceScope(latest.document.scope, snapshot.document.scope);
    };
    const latest = options.read();
    if (!current() || latest?.revision !== snapshot.revision || latest.document.text !== snapshot.document.text) return 'rejected';
    // A busy BTW owner may reject the question. Only its synchronous acceptance
    // permits the captured revision CAS; a failed CAS preserves a newer main draft.
    if (plan.kind === 'action' && plan.action === 'btw') {
      if (action?.({ action: plan.action, argument: plan.argument, source: origin, snapshot, current }) === false) return 'rejected';
      if (plan.document !== snapshot.document) options.write(plan.document, snapshot);
      return 'handled';
    }
    if (plan.document !== snapshot.document && !options.write(plan.document, snapshot)) return 'rejected';
    if (selection?.command.source === 'opencode' && plan.kind === 'insert') {
      const inserted = options.read();
      if (inserted?.owner === snapshot.owner) selectedHost = { owner: inserted.owner, revision: inserted.revision, text: inserted.document.text };
    }
    if (plan.kind === 'insert' && plan.submit) {
      if (route(undefined, plan.submit, 'selection') === 'pass') options.submitPass?.(plan.submit);
    }
    if (plan.kind === 'action') action?.({ action: plan.action, argument: plan.argument, source: origin, snapshot, current });
    return 'handled';
  }
  return {
    submit: () => route(),
    choose: (command: NativeSlashCommand, submit: boolean, context: ReferenceKeyboardContext) => route({ command, submit, context }) === 'handled',
  };
}
